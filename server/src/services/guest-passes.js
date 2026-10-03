/**
 * El pase individual: uno por persona, firmado y de un solo uso.
 *
 * Casi todo lo de aquí no depende de Express ni de la base —firmar, leer lo que
 * trae un QR, decidir si un pase abre la puerta y armar el mensaje de WhatsApp—
 * y se puede probar sin levantar nada. Al final, en su propia sección, están las
 * dos funciones que sí escriben: emitir los pases de una reservación y dejar el
 * renglón de auditoría. Están aquí y no en la ruta porque las llaman tres
 * lugares distintos (reservar, pagar y vender un extra en la puerta), y una
 * regla repetida en tres lados es una regla que va a dejar de ser la misma.
 *
 * ---------------------------------------------------------------------------
 * Por qué el QR va firmado
 * ---------------------------------------------------------------------------
 * El código de un pase es aleatorio, así que adivinarlo ya es prácticamente
 * imposible. La firma no está para eso: está para que un código inventado se
 * rechace SIN TOCAR LA BASE. Sin firma, cada intento de entrar con un código
 * falso es una consulta más, y una fila de gente probando códigos es una fila de
 * consultas; con firma, el servidor descarta el intento con una cuenta de
 * microsegundos y solo consulta lo que ya demostró venir de un pase que él
 * emitió.
 *
 * Y lo que el QR NO lleva: nombre, teléfono, fecha de nacimiento, ni el id de la
 * reservación. Un código y una firma. Quien fotografíe la pantalla de otro se
 * lleva su entrada —eso ya se resuelve revocando— pero no se lleva un solo dato
 * de esa persona.
 *
 * ---------------------------------------------------------------------------
 * De dónde sale la llave
 * ---------------------------------------------------------------------------
 * De `JWT_SECRET`, derivada con HMAC y una etiqueta propia. Dos consecuencias
 * que hay que saber, no esconder:
 *
 *   * no hace falta una variable de entorno nueva, ni un secreto más que
 *     custodiar, ni un despliegue que se cae porque alguien olvidó ponerla;
 *   * si algún día se rota `JWT_SECRET`, TODOS los QRs repartidos dejan de
 *     validar la firma. No dejan de existir: el código sigue en la base y sigue
 *     abriendo si se teclea. Se rota entre semana y a mediodía, no un sábado a
 *     las once de la noche.
 */
'use strict';

const crypto = require('crypto');
const door = require('./door');

// El mismo alfabeto del código del pase: sin 0/O ni 1/I/L. La firma también se
// puede dictar en voz alta, que es lo que pasa cuando la cámara no enfoca.
const ALPHABET = door.ALPHABET;
const SIGNATURE_LENGTH = 10;     // ~49 bits. De sobra para que no se adivine.
const PAYLOAD_PREFIX = 'EV2P';
const KEY_LABEL = 'ev2-guest-pass-v1';

let cachedKey = null;
let cachedSecret = null;

/**
 * La llave con la que se firma. Se deriva de `JWT_SECRET` y se memoriza, pero
 * comprobando que el secreto sea el mismo: en las pruebas se cambia entre casos
 * y una llave memorizada de más haría pasar una firma que en producción sería
 * inválida.
 */
function signingKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    // Que truene aquí y no al escanear. Un servidor sin JWT_SECRET no puede
    // emitir pases, y descubrirlo en la puerta es descubrirlo demasiado tarde.
    throw new Error('JWT_SECRET is required to sign guest passes');
  }
  if (cachedKey && cachedSecret === secret) return cachedKey;
  cachedSecret = secret;
  cachedKey = crypto.createHmac('sha256', secret).update(KEY_LABEL).digest();
  return cachedKey;
}

/**
 * La firma de un código: 10 letras del alfabeto del club.
 *
 * El `% ALPHABET.length` sesga un poco la distribución —31 no divide a 256— y da
 * exactamente igual: esto es un truncamiento de un MAC, no una llave. El sesgo
 * le quita una fracción de bit a los casi 50 que hay.
 */
function sign(code) {
  const mac = crypto.createHmac('sha256', signingKey())
    .update(String(code == null ? '' : code).toUpperCase())
    .digest();
  let out = '';
  for (let i = 0; i < SIGNATURE_LENGTH; i += 1) out += ALPHABET[mac[i] % ALPHABET.length];
  return out;
}

/** Lo que va dentro del QR: `EV2P.EV2-4K7M-2P4X.7QHM4NPR2S`. */
function payload(code) {
  return `${PAYLOAD_PREFIX}.${code}.${sign(code)}`;
}

/**
 * Lee lo que llega del lector, del teclado o de un enlace.
 *
 * Se aceptan tres formas, porque en la puerta llegan las tres:
 *
 *   * el payload completo del QR;
 *   * una dirección que lo lleve al final o en `?p=` (el enlace de WhatsApp,
 *     escaneado con la cámara del teléfono en vez del lector de la app);
 *   * el código pelón, tecleado, cuando la pantalla está rota o el teléfono
 *     muerto. Sin firma: eso lo decide `check`, no esto.
 */
function parse(scanned) {
  const texto = String(scanned == null ? '' : scanned).trim();
  if (!texto) return { code: '', signature: null, signed: false };

  // Un enlace: quedarse con `p=` si lo trae, y si no con el último segmento.
  let cuerpo = texto;
  const enQuery = /[?&]p=([^&\s]+)/i.exec(texto);
  if (enQuery) {
    cuerpo = decodeURIComponent(enQuery[1]);
  } else if (/^https?:\/\//i.test(texto) || texto.includes('/')) {
    cuerpo = texto.split(/[/?#]/).filter(Boolean).pop() || texto;
  }

  const partes = cuerpo.split('.').filter(Boolean);
  if (partes.length >= 3 && partes[0].toUpperCase() === PAYLOAD_PREFIX) {
    return {
      code: door.normalizePassCode(partes[1]),
      signature: partes[2].trim().toUpperCase(),
      signed: true,
    };
  }
  return { code: door.normalizePassCode(cuerpo), signature: null, signed: false };
}

/**
 * ¿La firma corresponde al código?
 *
 * Comparación de tiempo constante. Filtrar un MAC por el primer carácter
 * distinto deja medir cuántos aciertan, y con suficientes intentos eso se
 * convierte en fabricar una firma válida letra por letra.
 */
function verifySignature(code, signature) {
  if (typeof signature !== 'string') return false;
  const esperada = sign(code);
  if (signature.length !== esperada.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(esperada));
}

/** Un código nuevo, con el mismo formato que el de la reservación. */
const generateCode = door.generatePassCode;

/** `n` códigos distintos entre sí. Los choques contra la base los ve el índice único. */
function generateCodes(n) {
  const vistos = new Set();
  while (vistos.size < n) vistos.add(generateCode());
  return [...vistos];
}

const PASS_STATUS = {
  ok: 'ok',
  notFound: 'not_found',
  forged: 'forged',
  revoked: 'revoked',
  used: 'used',
  expired: 'expired',
  noIdCheck: 'no_id_check',
  // Y los de la reservación, que se heredan tal cual de `door.checkPass` para
  // que la puerta vea un solo vocabulario: unpaid, cancelled, not_tonight.
  unpaid: door.PASS_STATUS.unpaid,
  cancelled: door.PASS_STATUS.cancelled,
  notTonight: door.PASS_STATUS.notTonight,
};

/**
 * Si este pase abre la puerta ahora mismo, y si no, por qué.
 *
 * El orden de las comprobaciones es el orden en el que hay que contestarle a la
 * persona que está en la puerta:
 *
 *   1. la firma, si vino firmado. Un QR fabricado no merece ni una consulta más;
 *   2. el pase: revocado, ya usado, vencido;
 *   3. la reservación: pagada, no cancelada, y que sea hoy.
 *
 * Un pase de contingencia no tiene reservación que comprobar —lo emitió la
 * puerta hace un rato, justamente porque el caso normal no se pudo— así que se
 * queda en el paso 2.
 */
function check(pass, reservation, { now = new Date(), scan = null } = {}) {
  if (!pass) return { status: PASS_STATUS.notFound, ok: false };

  if (scan && scan.signed && !verifySignature(pass.code, scan.signature)) {
    return { status: PASS_STATUS.forged, ok: false };
  }

  if (pass.status === 'revoked') {
    return { status: PASS_STATUS.revoked, ok: false, reason: pass.revoke_reason || null };
  }
  if (pass.status === 'used' || pass.used_at) {
    return { status: PASS_STATUS.used, ok: false, at: pass.used_at || null };
  }
  if (pass.expires_at && now > new Date(pass.expires_at)) {
    return { status: PASS_STATUS.expired, ok: false, at: pass.expires_at };
  }

  // Un extra pagado en la puerta entra con su cobro, no con una reservación: no
  // hay horario que comprobarle más allá de su propio vencimiento.
  if (pass.kind === 'contingency' || (!reservation && pass.admission_id)) {
    return { status: PASS_STATUS.ok, ok: true };
  }
  if (!reservation) return { status: PASS_STATUS.notFound, ok: false };

  // Y la reservación, con una diferencia: que ya haya entrado gente NO cierra la
  // puerta a los demás pases. Eso es precisamente lo que esta migración vino a
  // arreglar, así que `already_in` no aplica a un pase individual.
  const dela = door.checkPass(
    { ...reservation, status: reservation.status === 'seated' ? 'confirmed' : reservation.status,
      checked_in_at: null },
    { now },
  );
  if (!dela.ok) return dela;
  return { status: PASS_STATUS.ok, ok: true };
}

/**
 * ¿Sirve esta revisión de identificación para abrir un pase?
 *
 * Tres condiciones, y las tres por algo que pasó o puede pasar en una puerta:
 *
 *   * aceptada y de un mayor de edad. Un rechazo no abre nada, que es el punto;
 *   * sin gastar. Una revisión por persona: si una sola sirviera para varios
 *     pases, revisar una identificación y meter a cuatro sería trivial;
 *   * fresca. `maxAgeMinutes` es el tiempo que puede pasar entre mirar la
 *     identificación y escanear el QR. Cinco minutos es mucho para un teléfono
 *     en la mano y poco para dejar revisiones vivas toda la noche.
 *
 * Y del mismo guardia que escanea: una revisión que hizo otro no es una revisión
 * que este vio.
 */
const ID_CHECK_MINUTES = 5;

function idCheckIsUsable(idCheck, { now = new Date(), staffId = null,
  maxAgeMinutes = ID_CHECK_MINUTES } = {}) {
  if (!idCheck) return { ok: false, reason: 'no_id_check' };
  if (idCheck.decision !== 'accepted' || !idCheck.adult) return { ok: false, reason: 'id_rejected' };
  if (idCheck.consumed_by) return { ok: false, reason: 'id_check_used' };
  if (staffId && idCheck.checked_by !== staffId) return { ok: false, reason: 'id_check_other_staff' };
  const edad = (now.getTime() - new Date(idCheck.created_at).getTime()) / 60_000;
  if (edad > maxAgeMinutes) return { ok: false, reason: 'id_check_stale' };
  return { ok: true };
}

/** Cuánto vive un pase de contingencia. Lo suficiente para cruzar la puerta. */
const CONTINGENCY_MINUTES = 45;

function contingencyExpiry({ now = new Date(), minutes = CONTINGENCY_MINUTES } = {}) {
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * Cuántos pases le tocan a una reservación: uno por persona.
 *
 * El titular cuenta como uno. Ocho personas son un titular y siete invitados, no
 * un titular y ocho: cobrar ocho lugares y emitir nueve pases sería regalar una
 * entrada cada mesa, todas las noches.
 */
function passesNeeded(guestCount) {
  const n = Math.max(1, Math.floor(Number(guestCount) || 1));
  return { holder: 1, guests: n - 1, total: n };
}

/**
 * El mensaje que el titular manda por WhatsApp.
 *
 * Lleva el enlace, no el código: el invitado abre, ve su QR y lo tiene en la
 * pantalla. Y lleva el código escrito abajo, porque a alguien se le va a morir
 * el teléfono en la fila.
 *
 * `baseUrl` lo pone el servidor con su propio dominio configurado, no el
 * navegador de quien pide: un enlace armado con lo que manda el cliente es un
 * enlace a donde ese cliente quiera.
 */
function shareLink(baseUrl, code) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return `${base}/pase.html?p=${encodeURIComponent(payload(code))}`;
}

const SHARE_TEXT = {
  es: ({ label, club, table, when, link, code }) => [
    label ? `${label}, este es tu pase para ${club}.` : `Este es tu pase para ${club}.`,
    table ? `Mesa ${table}.` : null,
    when ? `${when}.` : null,
    '',
    link,
    '',
    `Si no te abre el enlace, tu código es ${code}.`,
    'Es de un solo uso y solo sirve para ti. Lleva tu identificación.',
  ].filter((l) => l !== null).join('\n'),
  en: ({ label, club, table, when, link, code }) => [
    label ? `${label}, here is your pass for ${club}.` : `Here is your pass for ${club}.`,
    table ? `Table ${table}.` : null,
    when ? `${when}.` : null,
    '',
    link,
    '',
    `If the link does not open, your code is ${code}.`,
    'Single use, and only yours. Bring your ID.',
  ].filter((l) => l !== null).join('\n'),
};

function shareMessage({ code, label, club, table, when, baseUrl, lang = 'es' }) {
  const link = shareLink(baseUrl, code);
  const armar = SHARE_TEXT[lang] || SHARE_TEXT.es;
  const text = armar({ label: label || null, club: club || 'EV2', table: table || null,
    when: when || null, link, code });
  return {
    text,
    link,
    // `wa.me` abre la app instalada en teléfono y WhatsApp Web en computadora, sin
    // que el cliente tenga que saber en cuál está.
    whatsapp_url: `https://wa.me/?text=${encodeURIComponent(text)}`,
  };
}

// ===========================================================================
// Lo que escribe en la base
// ===========================================================================

/**
 * Un renglón de auditoría. Nunca lanza.
 *
 * Que la auditoría no pueda tirar la operación es deliberado y tiene un costo
 * que conviene decir en voz alta: si la tabla se rompiera, la puerta seguiría
 * dejando entrar gente sin registrar nada. Preferimos eso a lo contrario —una
 * puerta que se cierra porque no pudo escribir un log, con la fila afuera— y por
 * eso el error se escribe en el registro del servidor en vez de tragárselo en
 * silencio.
 */
async function audit(client, { passId, kind, reason = null, actorId = null,
  idCheckId = null, metadata = {} }) {
  try {
    await client.query(
      `INSERT INTO guest_pass_events (pass_id, kind, reason, actor_id, id_check_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [passId, kind, reason, actorId, idCheckId, JSON.stringify(metadata)],
    );
  } catch (err) {
    console.error('guest_pass_events insert failed', { passId, kind, error: err.message });
  }
}

/**
 * Emite los pases que le faltan a una reservación: uno por persona.
 *
 * Es idempotente a propósito, y no por elegancia. Se llama al reservar, y otra
 * vez cuando entra el pago, y otra vez si el cliente agrega un lugar. Si no lo
 * fuera, una reservación de ocho acabaría con veinticuatro pases y la mesa
 * entraría tres veces.
 *
 * El pase del titular reusa `reservations.pass_code` cuando ya existe, para que
 * un QR repartido antes de esta migración siga abriendo la puerta.
 *
 * Devuelve solo los pases NUEVOS: es lo que la ruta tiene que enseñar o mandar.
 */
async function issueForReservation(client, { reservation, actorId = null }) {
  const { id, nightclub_id: nightclubId, guest_count: guestCount } = reservation;
  const necesarios = passesNeeded(guestCount);

  const ya = await client.query(
    `SELECT kind, count(*)::int AS n
       FROM guest_passes
      WHERE reservation_id = $1 AND kind IN ('holder','guest') AND status <> 'revoked'
      GROUP BY kind`,
    [id],
  );
  const cuenta = { holder: 0, guest: 0 };
  for (const r of ya.rows) cuenta[r.kind] = r.n;

  const pendientes = [];
  if (cuenta.holder === 0) pendientes.push('holder');
  for (let i = cuenta.guest; i < necesarios.guests; i += 1) pendientes.push('guest');
  if (pendientes.length === 0) return [];

  const creados = [];
  for (const kind of pendientes) {
    // El titular reusa el código de la reservación si lo tiene; los invitados
    // siempre estrenan. El reintento existe porque el índice único es la única
    // autoridad sobre si un código está libre: comprobar antes y escribir después
    // es una carrera con el registro de la mesa de al lado.
    let fila = null;
    for (let intento = 0; intento < 5 && !fila; intento += 1) {
      const code = (kind === 'holder' && intento === 0 && reservation.pass_code)
        ? reservation.pass_code
        : generateCode();
      try {
        const { rows } = await client.query(
          `INSERT INTO guest_passes (nightclub_id, reservation_id, code, kind, created_by)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING id, code, kind, status, label, created_at`,
          [nightclubId, id, code, kind, actorId],
        );
        fila = rows[0];
      } catch (err) {
        if (err.code !== '23505') throw err;   // 23505 = código repetido
        // Si el que choca es el código del titular, ya existe su pase: nada que hacer.
        if (kind === 'holder' && intento === 0) { fila = null; break; }
      }
    }
    if (!fila) continue;
    await audit(client, { passId: fila.id, kind: 'issued', actorId,
      metadata: { kind: fila.kind, reservation_id: id } });
    creados.push(fila);
  }
  return creados;
}

/**
 * Los pases de un extra pagado en la puerta: uno por persona, ligados al cobro.
 *
 * Van sin reservación adentro del pase aunque el extra cuelgue de una: el pase
 * se sostiene con su propio cobro, y así un extra sigue valiendo si la
 * reservación se cancela después de que esa persona ya pagó y entró.
 */
async function issueForAdmission(client, { nightclubId, admissionId, reservationId = null,
  quantity = 1, actorId = null, labels = [] }) {
  const creados = [];
  for (let i = 0; i < quantity; i += 1) {
    let fila = null;
    for (let intento = 0; intento < 5 && !fila; intento += 1) {
      try {
        const { rows } = await client.query(
          `INSERT INTO guest_passes (nightclub_id, reservation_id, admission_id, code, kind,
                                     label, created_by)
           VALUES ($1,$2,$3,$4,'extra',$5,$6)
           RETURNING id, code, kind, status, label, created_at`,
          [nightclubId, reservationId, admissionId, generateCode(),
            labels[i] || null, actorId],
        );
        fila = rows[0];
      } catch (err) {
        if (err.code !== '23505') throw err;
      }
    }
    if (!fila) throw new Error('could not issue a unique pass code for the admission');
    await audit(client, { passId: fila.id, kind: 'issued', actorId,
      metadata: { kind: 'extra', admission_id: admissionId } });
    creados.push(fila);
  }
  return creados;
}

module.exports = {
  ALPHABET,
  SIGNATURE_LENGTH,
  PAYLOAD_PREFIX,
  PASS_STATUS,
  CONTINGENCY_MINUTES,
  ID_CHECK_MINUTES,
  sign,
  payload,
  parse,
  verifySignature,
  generateCode,
  generateCodes,
  check,
  idCheckIsUsable,
  contingencyExpiry,
  passesNeeded,
  shareLink,
  shareMessage,
  audit,
  issueForReservation,
  issueForAdmission,
};
