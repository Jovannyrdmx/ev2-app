/**
 * EV2 — checador de huella (D94).
 *
 * Dos cosas en un archivo:
 *
 *   1. `EV2Clock`: el lector de huella (envuelve la librería oficial de HID) y las
 *      decisiones de qué se enseña después de una marca. Lo usan esta pantalla y el
 *      registro de huellas del panel del gerente. Se prueba en Node.
 *   2. La pantalla del checador (`checador.html`), que arranca sola solo en esa
 *      página: la PC de la caja de abajo, siempre esperando un dedo.
 *
 * El lector se habla a través del agente de HID ("HID Authentication Device Client")
 * instalado en esa PC: la página le pide la huella como imagen PNG y la manda al
 * servidor. La página NUNCA guarda la imagen; viaja una vez y se olvida.
 *
 * La PC se identifica con su propio token (`localStorage`, clave `STATION_KEY`), que
 * pone ahí el gerente desde su panel en ESA PC. No hay sesión de persona en esta
 * pantalla: si la hubiera, cualquiera que se acercara a la caja tendría la sesión de
 * quien la abrió.
 */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.EV2Clock = api;
    if (root.document && root.document.body && root.document.body.dataset.page === 'checador') api.boot();
  }
}(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const STATION_KEY = 'ev2.clockStation';
  /** Lo que dura en pantalla el resultado de una marca antes de volver a esperar. */
  const SHOW_MS = 6000;
  /** Cada cuánto se vuelve a buscar el lector o su programa si no responden. */
  const RETRY_MS = 15000;
  /** El formato de la librería de HID para pedir la huella como PNG. */
  const PNG_FORMAT = 5;

  /** El color de cada resultado: verde entra, azul sale, ámbar "otra vez", rojo falla. */
  const TONE_COLORS = {
    in: '#a3e635', out: '#38bdf8', repeat: 'rgba(255,255,255,.6)',
    retry: '#fbbf24', blocked: '#fb923c', error: '#f87171',
  };

  const FINGERS = ['right_index', 'left_index', 'right_thumb', 'left_thumb', 'right_middle',
    'left_middle', 'right_ring', 'left_ring', 'right_little', 'left_little'];

  // ---------------------------------------------------------------- piezas puras

  /**
   * Una muestra de la librería de HID → base64 normal, listo para el servidor.
   *
   * La librería entrega base64url (con `-` y `_`), a veces envuelto en un objeto con
   * `Data`. Se normaliza aquí y no en el servidor para poder enseñar la imagen en la
   * pantalla de registro con un `data:` correcto.
   */
  function sampleToBase64(sample) {
    const raw = typeof sample === 'string' ? sample
      : (sample && (sample.Data || sample.data)) || '';
    let s = String(raw).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    if (!s) return '';
    while (s.length % 4) s += '=';
    return s;
  }

  /** Qué se enseña después de una marca que salió bien. */
  function punchView(body) {
    const b = body || {};
    const salida = b.kind === 'out';
    let titleKey = salida ? 'clk.out' : 'clk.in';
    if (b.repeated) titleKey = salida ? 'clk.repeatOut' : 'clk.repeatIn';
    return {
      tone: b.repeated ? 'repeat' : (salida ? 'out' : 'in'),
      titleKey,
      name: (b.user && b.user.name) || '',
      at: b.at || null,
    };
  }

  /**
   * Qué se enseña cuando la marca no salió. El servidor ya escribe sus mensajes para
   * quien está frente al lector ("No te reconocí…", "Haz tu corte primero…"); aquí
   * solo se decide el color y qué hacer con los casos que no son del dedo.
   */
  function errorView(err) {
    const status = err && err.status;
    if (status === 401) return { tone: 'error', key: 'clk.unpaired', unpaired: true };
    if (!status) return { tone: 'error', key: 'clk.offline' };
    if (status === 404 || status === 409) return { tone: 'retry', message: err.message };
    if (status === 422) return { tone: 'blocked', message: err.message };
    if (status === 429) return { tone: 'retry', key: 'clk.slowDown' };
    // 400/413: la imagen no llegó como el servidor la espera. No es del dedo, y el
    // texto técnico del servidor ("Validation failed") no le sirve a nadie aquí.
    if (status === 400 || status === 413) return { tone: 'error', key: 'clk.failed' };
    return { tone: 'error', message: err.message || null, key: 'clk.failed' };
  }

  const fingerKey = (finger) => `clk.finger.${finger}`;

  // ---------------------------------------------------------------- el lector

  /**
   * El lector de huella, a través de la librería oficial de HID (`dp.devices`).
   *
   * `onStatus` recibe: 'starting' | 'ready' | 'no-reader' | 'no-agent' | 'error'.
   * `onSample` recibe la huella en base64 (PNG). `onQuality` el código de calidad
   * cuando el lector rechaza un intento (dedo movido, muy oscuro…).
   */
  function createReader({ onSample, onStatus, onQuality } = {}) {
    const dp = root.dp && root.dp.devices;
    const status = (s, detail) => { if (onStatus) onStatus(s, detail); };
    if (!dp || !root.WebSdk) {
      status('no-agent');
      return { start: async () => false, stop: async () => {} };
    }
    const reader = new dp.FingerprintReader();
    let running = false;

    reader.on('DeviceConnected', () => { if (running) acquire(); });
    reader.on('DeviceDisconnected', () => status('no-reader'));
    reader.on('CommunicationFailed', () => status('no-agent'));
    reader.on('AcquisitionStarted', () => status('ready'));
    reader.on('QualityReported', (e) => { if (onQuality) onQuality(e.quality); });
    reader.on('ErrorOccurred', (e) => status('error', e && e.error));
    reader.on('SamplesAcquired', (e) => {
      const list = Array.isArray(e.samples) ? e.samples : [e.samples];
      const png = sampleToBase64(list[0]);
      if (png && onSample) onSample(png);
    });

    async function acquire() {
      try {
        const devices = await reader.enumerateDevices();
        if (!devices || devices.length === 0) { status('no-reader'); return false; }
        await reader.startAcquisition(PNG_FORMAT, devices[0]);
        return true;
      } catch (err) {
        status('no-agent', err && err.message);
        return false;
      }
    }

    return {
      async start() { running = true; status('starting'); return acquire(); },
      async stop() {
        running = false;
        try { await reader.stopAcquisition(); } catch { /* ya estaba detenido */ }
      },
    };
  }

  // ---------------------------------------------------------------- la pantalla

  /* global EV2Format */
  function boot() {
    const doc = root.document;
    const $ = (id) => doc.getElementById(id);
    const meta = (name, fallback) => {
      const el = doc.querySelector(`meta[name="${name}"]`);
      return (el && el.content) || fallback;
    };
    const API = meta('ev2:api', '/api');
    const t = (key, vars) => (vars ? EV2Format.tf(key, vars) : EV2Format.t(key));

    const storage = (() => { try { return root.localStorage; } catch { return null; } })();
    const token = () => (storage && storage.getItem(STATION_KEY)) || '';

    let busy = false;
    let resetTimer = null;
    let retryTimer = null;
    let reader = null;

    EV2Format.setLanguage(EV2Format.getLanguage());
    EV2Format.applyTo(doc);

    // El reloj grande. Es lo que se ve desde lejos: que la PC está viva.
    const tick = () => {
      const now = new Date();
      $('clk-time').textContent = EV2Format.time(now);
      $('clk-date').textContent = EV2Format.date(now);
    };
    tick();
    setInterval(tick, 1000);

    function setReaderStatus(s) {
      const keys = {
        starting: 'clk.readerStarting', ready: 'clk.readerReady', 'no-reader': 'clk.readerMissing',
        'no-agent': 'clk.agentMissing', error: 'clk.readerError',
      };
      $('clk-reader').textContent = t(keys[s] || 'clk.readerError');
      $('clk-reader').dataset.state = s;
      if (s !== 'ready' && s !== 'starting') {
        idle(true);
        // La PC se prende antes que el programa del lector, o alguien desconecta el
        // USB: se vuelve a intentar sola, sin que nadie tenga que recargar.
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { if (reader) reader.start(); }, RETRY_MS);
      }
    }

    function show(tone, title, line2) {
      clearTimeout(resetTimer);
      const box = $('clk-result');
      box.dataset.tone = tone;
      const color = TONE_COLORS[tone] || TONE_COLORS.error;
      box.style.borderColor = color;
      $('clk-title').style.color = color;
      $('clk-title').textContent = title || '';
      $('clk-line2').textContent = line2 || '';
      box.hidden = false;
      $('clk-wait').hidden = true;
      beep(tone);
      resetTimer = setTimeout(() => idle(), SHOW_MS);
    }

    function idle(keepReaderMsg) {
      clearTimeout(resetTimer);
      $('clk-result').hidden = true;
      $('clk-wait').hidden = false;
      if (!keepReaderMsg && reader && $('clk-reader').dataset.state === 'ready') {
        $('clk-reader').textContent = t('clk.readerReady');
      }
    }

    let audio = null;
    function beep(tone) {
      try {
        const Ctx = root.AudioContext || root.webkitAudioContext;
        if (!Ctx) return;
        audio = audio || new Ctx();
        const ok = tone === 'in' || tone === 'out' || tone === 'repeat';
        const notes = ok ? [880, 1320] : [330, 220];
        notes.forEach((f, i) => {
          const o = audio.createOscillator();
          const g = audio.createGain();
          o.frequency.value = f;
          g.gain.value = 0.12;
          o.connect(g); g.connect(audio.destination);
          const at = audio.currentTime + i * 0.16;
          o.start(at); o.stop(at + 0.14);
        });
      } catch { /* sin audio, la pantalla basta */ }
    }

    async function call(method, path, body) {
      let res;
      try {
        res = await fetch(`${API}${path}`, {
          method,
          headers: { 'content-type': 'application/json', 'x-clock-station-token': token() },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch {
        const err = new Error('offline'); err.status = 0; throw err;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error((data.error && data.error.message) || res.statusText);
        err.status = res.status;
        throw err;
      }
      return data;
    }

    function unpaired(reasonKey) {
      if (reader) reader.stop();
      $('clk-main').hidden = true;
      $('clk-setup').hidden = false;
      $('clk-setup-why').textContent = reasonKey ? t(reasonKey) : '';
    }

    async function onSample(png) {
      if (busy) return;
      busy = true;
      $('clk-reader').textContent = t('clk.checking');
      try {
        const r = await call('POST', '/clock-station/punch', { image: png });
        const v = punchView(r);
        show(v.tone, t(v.titleKey), `${v.name} · ${EV2Format.time(v.at)}`);
      } catch (err) {
        const v = errorView(err);
        if (v.unpaired) { storage && storage.removeItem(STATION_KEY); unpaired('clk.revoked'); return; }
        show(v.tone, v.message || t(v.key), v.message && v.key ? t(v.key) : '');
      } finally {
        busy = false;
        if ($('clk-reader').dataset.state === 'ready') $('clk-reader').textContent = t('clk.readerReady');
      }
    }

    async function start() {
      if (!token()) { unpaired(null); return; }
      try {
        const info = await call('GET', '/clock-station');
        $('clk-club').textContent = info.station.club_name || '';
        $('clk-station').textContent = info.station.name || '';
        if (!info.configured) $('clk-config').hidden = false;
      } catch (err) {
        if (err.status === 401) { storage && storage.removeItem(STATION_KEY); unpaired('clk.revoked'); return; }
        $('clk-reader').textContent = t('clk.offline');
        setTimeout(start, 10000);
        return;
      }
      $('clk-setup').hidden = true;
      $('clk-main').hidden = false;
      reader = createReader({
        onSample,
        onStatus: setReaderStatus,
        onQuality: () => { if (!busy) $('clk-reader').textContent = t('clk.badQuality'); },
      });
      await reader.start();
    }

    // La pantalla de la caja no debe apagarse sola mientras espera dedos.
    async function keepAwake() {
      try {
        if (root.navigator.wakeLock && doc.visibilityState === 'visible') {
          await root.navigator.wakeLock.request('screen');
        }
      } catch { /* el navegador no lo permite: no pasa nada */ }
    }
    doc.addEventListener('visibilitychange', keepAwake);
    keepAwake();

    $('btn-lang').addEventListener('click', () => {
      EV2Format.setLanguage(EV2Format.otherLanguage());
      root.location.reload();
    });
    $('btn-lang').textContent = EV2Format.otherLanguage().toUpperCase();

    start();
  }

  return {
    STATION_KEY, SHOW_MS, PNG_FORMAT, FINGERS, TONE_COLORS,
    sampleToBase64, punchView, errorView, fingerKey, createReader, boot,
  };
}));
