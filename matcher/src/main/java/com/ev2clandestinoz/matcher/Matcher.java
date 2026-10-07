package com.ev2clandestinoz.matcher;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.machinezoo.sourceafis.FingerprintImage;
import com.machinezoo.sourceafis.FingerprintImageOptions;
import com.machinezoo.sourceafis.FingerprintMatcher;
import com.machinezoo.sourceafis.FingerprintTemplate;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * EV2 fingerprint matcher (D94).
 *
 * Internal-only HTTP service: it is reachable only inside the Docker network and every
 * request must carry the shared token. It stores nothing; the API sends the probe image
 * and the candidate templates on each call and gets back a score.
 *
 *   GET  /health                                   -> {"ok":true}
 *   POST /extract  {"dpi":512,"images":["b64png"]} -> {"templates":["b64"],"pairs":[[0,1,87.3]]}
 *   POST /identify {"dpi":512,"image":"b64png",
 *                   "candidates":[{"id":"x","template":"b64"}]}
 *                                                  -> {"top":[{"id":"x","score":91.2}, ...]}
 *
 * The decision (threshold) belongs to the API, not to this service.
 */
public final class Matcher {
    static final int MAX_BODY_BYTES = 4 * 1024 * 1024;
    static final int MAX_IMAGES = 8;
    static final int MAX_CANDIDATES = 5000;
    static final int CACHE_SIZE = 8192;
    static final int TOP = 10;

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Deserialized templates, keyed by the SHA-256 of their serialized form. */
    private static final Map<String, FingerprintTemplate> CACHE =
        new LinkedHashMap<>(256, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, FingerprintTemplate> e) {
                return size() > CACHE_SIZE;
            }
        };

    private final byte[] token;

    /** `token == null` means "not configured": every request is refused. */
    Matcher(String token) {
        this.token = token == null ? null : token.getBytes(StandardCharsets.UTF_8);
    }

    public static void main(String[] args) throws IOException {
        String token = System.getenv("MATCHER_TOKEN");
        boolean configured = token != null && token.length() >= 32;
        if (!configured) {
            // Stay up and refuse everything instead of exiting: an exit would put the
            // container in a restart loop on every deploy until the key is set, and
            // the API already tells the manager what is missing.
            System.err.println("MATCHER_TOKEN is missing or shorter than 32 characters: refusing all requests");
        }
        int port = Integer.parseInt(System.getenv().getOrDefault("MATCHER_PORT", "8090"));
        Matcher m = new Matcher(configured ? token : null);
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 64);
        server.createContext("/", m::handle);
        server.setExecutor(Executors.newFixedThreadPool(Math.max(2, Runtime.getRuntime().availableProcessors())));
        server.start();
        System.out.println("EV2 matcher listening on " + port);
    }

    void handle(HttpExchange ex) throws IOException {
        try (ex) {
            String path = ex.getRequestURI().getPath();
            String method = ex.getRequestMethod();
            if ("GET".equals(method) && "/health".equals(path)) {
                reply(ex, 200, JSON.createObjectNode().put("ok", true));
                return;
            }
            if (!authorized(ex)) {
                reply(ex, 401, error("unauthorized"));
                return;
            }
            if (!"POST".equals(method)) {
                reply(ex, 405, error("method_not_allowed"));
                return;
            }
            JsonNode body;
            try {
                body = JSON.readTree(readBody(ex.getRequestBody()));
            } catch (BodyTooLarge e) {
                reply(ex, 413, error("too_large"));
                return;
            } catch (IOException e) {
                reply(ex, 400, error("bad_json"));
                return;
            }
            try {
                switch (path) {
                    case "/extract" -> reply(ex, 200, extract(body));
                    case "/identify" -> reply(ex, 200, identify(body));
                    default -> reply(ex, 404, error("not_found"));
                }
            } catch (BadRequest e) {
                reply(ex, 422, error(e.getMessage()));
            }
        } catch (RuntimeException e) {
            // Never echo internals: the API logs its own side of the failure.
            System.err.println("matcher error: " + e);
            try { reply(ex, 500, error("internal")); } catch (IOException ignored) { /* closed */ }
        }
    }

    // ------------------------------------------------------------------ operations

    ObjectNode extract(JsonNode body) throws BadRequest {
        double dpi = dpi(body);
        JsonNode images = body.get("images");
        if (images == null || !images.isArray() || images.isEmpty() || images.size() > MAX_IMAGES) {
            throw new BadRequest("images_required");
        }
        FingerprintTemplate[] templates = new FingerprintTemplate[images.size()];
        ObjectNode out = JSON.createObjectNode();
        ArrayNode serialized = out.putArray("templates");
        for (int i = 0; i < images.size(); i++) {
            templates[i] = template(images.get(i), dpi);
            serialized.add(Base64.getEncoder().encodeToString(templates[i].toByteArray()));
        }
        // Every pair, so the API can check that the captures of one finger agree.
        ArrayNode pairs = out.putArray("pairs");
        for (int i = 0; i < templates.length; i++) {
            FingerprintMatcher probe = new FingerprintMatcher(templates[i]);
            for (int j = i + 1; j < templates.length; j++) {
                pairs.addArray().add(i).add(j).add(round(probe.match(templates[j])));
            }
        }
        return out;
    }

    ObjectNode identify(JsonNode body) throws BadRequest {
        double dpi = dpi(body);
        FingerprintTemplate probe = template(body.get("image"), dpi);
        JsonNode candidates = body.get("candidates");
        if (candidates == null || !candidates.isArray() || candidates.size() > MAX_CANDIDATES) {
            throw new BadRequest("candidates_required");
        }
        FingerprintMatcher matcher = new FingerprintMatcher(probe);
        List<double[]> scored = new ArrayList<>();
        List<String> ids = new ArrayList<>();
        for (JsonNode c : candidates) {
            JsonNode id = c.get("id");
            JsonNode t = c.get("template");
            if (id == null || !id.isTextual() || t == null || !t.isTextual()) {
                throw new BadRequest("bad_candidate");
            }
            ids.add(id.asText());
            scored.add(new double[] { scored.size(), matcher.match(cached(t.asText())) });
        }
        // The best few, highest first. The API groups them by person: two different
        // people both above the threshold is an ambiguity it must refuse, not guess.
        scored.sort((a, b) -> Double.compare(b[1], a[1]));
        ObjectNode out = JSON.createObjectNode();
        ArrayNode top = out.putArray("top");
        for (int i = 0; i < Math.min(TOP, scored.size()); i++) {
            double[] s = scored.get(i);
            top.addObject().put("id", ids.get((int) s[0])).put("score", round(s[1]));
        }
        return out;
    }

    // ------------------------------------------------------------------ helpers

    static double dpi(JsonNode body) throws BadRequest {
        JsonNode d = body.get("dpi");
        if (d == null || !d.isNumber() || d.asDouble() < 300 || d.asDouble() > 1200) {
            throw new BadRequest("dpi_required");
        }
        return d.asDouble();
    }

    static FingerprintTemplate template(JsonNode image, double dpi) throws BadRequest {
        if (image == null || !image.isTextual()) throw new BadRequest("image_required");
        byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(image.asText());
        } catch (IllegalArgumentException e) {
            throw new BadRequest("bad_base64");
        }
        try {
            return new FingerprintTemplate(new FingerprintImage(bytes, new FingerprintImageOptions().dpi(dpi)));
        } catch (RuntimeException e) {
            throw new BadRequest("bad_image");
        }
    }

    static FingerprintTemplate cached(String b64) throws BadRequest {
        String key = sha256(b64);
        synchronized (CACHE) {
            FingerprintTemplate hit = CACHE.get(key);
            if (hit != null) return hit;
        }
        FingerprintTemplate t;
        try {
            t = new FingerprintTemplate(Base64.getDecoder().decode(b64));
        } catch (RuntimeException e) {
            throw new BadRequest("bad_template");
        }
        synchronized (CACHE) {
            CACHE.put(key, t);
        }
        return t;
    }

    boolean authorized(HttpExchange ex) {
        String given = ex.getRequestHeaders().getFirst("X-Matcher-Token");
        if (token == null || given == null) return false;
        return MessageDigest.isEqual(token, given.getBytes(StandardCharsets.UTF_8));
    }

    static byte[] readBody(InputStream in) throws IOException {
        byte[] data = in.readNBytes(MAX_BODY_BYTES + 1);
        if (data.length > MAX_BODY_BYTES) throw new BodyTooLarge();
        return data;
    }

    static void reply(HttpExchange ex, int status, JsonNode json) throws IOException {
        byte[] out = JSON.writeValueAsBytes(json);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        ex.sendResponseHeaders(status, out.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(out);
        }
    }

    static ObjectNode error(String code) {
        return JSON.createObjectNode().put("error", code);
    }

    static double round(double v) {
        return Math.round(v * 100.0) / 100.0;
    }

    static String sha256(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(d);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static final class BadRequest extends Exception {
        private static final long serialVersionUID = 1L;

        BadRequest(String code) { super(code); }
    }

    static final class BodyTooLarge extends IOException {
        private static final long serialVersionUID = 1L;
    }
}
