/**
 * EV2 — leer un pase en la puerta y vender la entrada.
 *
 * Esto se usa de pie, de noche, con una fila enfrente y música encima. Dos cosas
 * mandan sobre todas las demás:
 *
 *   1. **El resultado se lee de reojo.** Un pase que abre y uno que no tienen que
 *      distinguirse por color y por una frase, sin leer un párrafo.
 *   2. **Teclear nunca es el plan B escondido.** La cámara puede no estar —un
 *      iPhone no lee QR dentro de una página web, y una pantalla estrellada no se
 *      deja leer por ningún lector— así que el campo del código está siempre a la
 *      vista. La fila no se detiene porque un lector no enfocó.
 *
 * El módulo de decisiones va primero y sin DOM, para poder probarlo.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2DoorScan = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Cómo se enseña cada resultado.
   *
   * `tone` decide el color, y es lo único que la persona de la puerta mira antes
   * de decidir si deja pasar. Los motivos que se arreglan hablando (falta el
   * depósito, es de mañana) son ámbar y no rojos: rojo es "no entra", y decirle
   * eso a quien solo debe pagar su anticipo es mandarlo a su casa por nada.
   */
  const RESULTS = {
    ok: { tone: 'ok', key: 'scan.ok' },
    already_in: { tone: 'warn', key: 'scan.alreadyIn' },
    // `used` es el pase individual ya gastado, y es ÁMBAR a propósito, no rojo:
    // casi siempre significa que esa persona ya entró y volvió a enseñar su
    // teléfono, no que esté intentando colarse. Lo que sí es rojo es un pase
    // revocado o fabricado.
    used: { tone: 'warn', key: 'scan.used' },
    not_tonight: { tone: 'warn', key: 'scan.notTonight' },
    unpaid: { tone: 'warn', key: 'scan.unpaid' },
    expired: { tone: 'warn', key: 'scan.expired' },
    // Falta la revisión de identificación, o no sirve. Ámbar: se arregla
    // volviendo a pedir la INE, y el pase NO se gastó.
    no_id_check: { tone: 'warn', key: 'scan.noIdCheck' },
    cancelled: { tone: 'bad', key: 'scan.cancelled' },
    revoked: { tone: 'bad', key: 'scan.revoked' },
    forged: { tone: 'bad', key: 'scan.forged' },
    not_found: { tone: 'bad', key: 'scan.notFound' },
  };

  const TONES = {
    ok: { bg: 'rgba(0,255,0,.10)', border: 'rgba(0,255,0,.45)', text: '#7CFF7C' },
    warn: { bg: 'rgba(255,193,7,.10)', border: 'rgba(255,193,7,.45)', text: '#FFD666' },
    bad: { bg: 'rgba(255,68,68,.12)', border: 'rgba(255,68,68,.5)', text: '#FF9B9B' },
  };

  /** Lo que la pantalla pinta con la respuesta del servidor. */
  function view(response) {
    const r = response || {};
    const pass = r.pass || null;
    const result = (pass && pass.result) || r.result || 'not_found';
    const shape = RESULTS[result] || RESULTS.not_found;
    return {
      result,
      ok: result === 'ok',
      tone: shape.tone,
      colors: TONES[shape.tone],
      headlineKey: shape.key,
      // Dos formas caben aquí: la de la MESA (mirar un pase sin gastarlo, que
      // devuelve `guest.name`) y la del pase INDIVIDUAL (el escaneo, que devuelve
      // el nombre del titular y el apodo del invitado). Una sola vista para las
      // dos, porque la persona de la puerta mira la misma tarjeta en pantalla.
      guest: pass ? ((pass.guest && pass.guest.name) || pass.holder_name || null) : null,
      label: pass ? (pass.label || null) : null,
      kind: pass ? (pass.kind || null) : null,
      table: pass ? pass.table && pass.table.code : null,
      section: pass ? pass.table && pass.table.section : null,
      guestCount: pass ? pass.guest_count : null,
      // Cuántos de esa mesa ya están adentro. Es el número que la puerta usa para
      // decir "van 6 de 8" sin llamar a nadie por radio.
      inside: pass && pass.already_inside != null ? pass.already_inside : null,
      extras: pass ? pass.extras_bought : 0,
      checkedInAt: pass ? (pass.checked_in_at || pass.used_at || null) : null,
      expiresAt: pass ? (pass.expires_at || null) : null,
      startsAt: pass ? pass.starts_at : null,
      notes: pass ? pass.special_requests : null,
      reservationId: pass ? pass.reservation_id : null,
      passId: pass ? (pass.id || null) : null,
      // Por qué falló la revisión de identificación, cuando ese fue el motivo.
      idCheckReason: r.id_check && r.id_check.ok === false ? r.id_check.reason : null,
      admitted: r.admitted === true,
      seated: r.seated === true,
    };
  }

  // -------------------------------------------------------------- la identificación

  /**
   * Los documentos que la puerta puede aceptar.
   *
   * `none` existe porque pasa: alguien llega sin nada. No es un atajo — se
   * registra como lo que es, y con `adult` en falso queda rechazado.
   */
  const ID_DOCUMENTS = ['ine', 'passport', 'license', 'other', 'none'];
  const documentKey = (d) => `idc.doc_${d}`;

  /**
   * Lo que se manda al registrar la revisión.
   *
   * Solo tres datos: qué documento, si es mayor de edad, y si se acepta. NO se
   * manda el número de la identificación ni la fecha de nacimiento, y no es un
   * olvido: el club no necesita guardarlos para dejar entrar a alguien, y
   * guardarlos lo obligaría a custodiarlos.
   */
  function idCheckPayload({ document, adult, reason }) {
    const doc = ID_DOCUMENTS.includes(document) ? document : 'ine';
    // Un menor de edad SIEMPRE es rechazo. La pantalla no ofrece la combinación
    // contraria, y el servidor tampoco la acepta.
    const esAdulto = adult === true;
    const body = {
      document: doc,
      adult: esAdulto,
      decision: esAdulto ? 'accepted' : 'rejected',
    };
    const motivo = String(reason || '').trim();
    if (!esAdulto) body.reason = (motivo || 'menor de edad').slice(0, 200);
    else if (motivo) body.reason = motivo.slice(0, 200);
    return body;
  }

  /**
   * Registrar un rechazo distinto de la edad: identificación vencida, foto que no
   * corresponde, documento que no se deja ver.
   */
  function idRejectionPayload({ document, reason }) {
    const doc = ID_DOCUMENTS.includes(document) ? document : 'other';
    return {
      document: doc,
      adult: false,
      decision: 'rejected',
      reason: (String(reason || '').trim() || 'identificación no válida').slice(0, 200),
    };
  }

  /** Por qué NO se puede escanear todavía. Devuelve la clave del motivo o null. */
  function scanBlocker({ code, idCheckId }) {
    if (!String(code || '').trim()) return 'scan.errNoCode';
    if (!idCheckId) return 'scan.errNoIdCheck';
    return null;
  }

  /**
   * Cuánto le queda de vida a la revisión, en segundos. La pantalla lo enseña en
   * cuenta atrás: una revisión que se vence mientras el guardia teclea el código
   * es un escaneo que falla sin explicación aparente.
   */
  function idCheckRemaining(idCheck, now) {
    if (!idCheck || !idCheck.expires_at) return 0;
    const resta = new Date(idCheck.expires_at).getTime() - (now ? now.getTime() : Date.now());
    return Math.max(0, Math.round(resta / 1000));
  }

  // -------------------------------------------------------------- sin QR en la mano

  /** La búsqueda de la puerta. Menos de tres letras devolvería media base. */
  function lookupBlocker(q) {
    return String(q || '').trim().length < 3 ? 'look.errShort' : null;
  }

  /** Lo que se manda al emitir un pase de contingencia. El motivo es obligatorio. */
  function contingencyPayload({ reservationId, label, reason }) {
    const motivo = String(reason || '').trim();
    const body = { reservation_id: reservationId, reason: motivo.slice(0, 200) };
    const nombre = String(label || '').trim();
    if (nombre) body.label = nombre.slice(0, 60);
    return body;
  }

  function contingencyBlocker({ reservationId, reason }) {
    if (!reservationId) return 'cont.errNoReservation';
    if (String(reason || '').trim().length < 5) return 'cont.errReason';
    return null;
  }

  /** Cómo van los pases de una reservación encontrada: "6 de 8 adentro". */
  function lookupSummary(row) {
    const r = row || {};
    return {
      total: Number(r.passes_total) || 0,
      used: Number(r.passes_used) || 0,
      active: Number(r.passes_active) || 0,
      complete: (Number(r.passes_active) || 0) === 0 && (Number(r.passes_used) || 0) > 0,
    };
  }

  /**
   * Lo que se manda al vender. El total se calcula aquí y se enseña ANTES de
   * cobrar: en la puerta el importe se dice en voz alta antes de que la persona
   * saque el dinero.
   */
  function admissionPayload(kind, {
    quantity, unitPrice, coverPriceId, clientRequestId, method, reservationId, notes,
  }) {
    const cantidad = Math.min(50, Math.max(1, Math.round(Number(quantity) || 1)));
    const body = {
      kind,
      quantity: cantidad,
      payment_method: method || 'cash',
    };
    // El precio ya no lo pone quien cobra. Con un cover del catálogo escogido se manda
    // SU id y ningún importe: el servidor lo busca y asienta ese. Teclear sigue siendo
    // posible solo mientras el club no tenga catálogo, y el servidor lo marca `manual`.
    if (coverPriceId) {
      body.cover_price_id = coverPriceId;
    } else if (unitPrice !== '' && unitPrice !== null && unitPrice !== undefined
      && Number.isFinite(Number(unitPrice))) {
      const precio = Math.max(0, Number(unitPrice));
      body.unit_price = Math.round(precio * 100) / 100;
    }
    // La clave del doble toque. Con mal wifi la pantalla se queda pensando y el cadenero
    // toca otra vez: la misma clave devuelve la MISMA entrada en vez de vender dos.
    if (clientRequestId) body.client_request_id = clientRequestId;
    if (kind === 'vip_extra') body.reservation_id = reservationId;
    const nota = String(notes || '').trim();
    if (nota) body.notes = nota.slice(0, 200);
    return body;
  }

  /** El total, en centavos enteros: un peso no cabe sin pérdida en un float. */
  function total(quantity, unitPrice) {
    const cantidad = Math.min(50, Math.max(1, Math.round(Number(quantity) || 1)));
    const centavos = Math.round((Number(unitPrice) || 0) * 100) * cantidad;
    return (centavos / 100).toFixed(2);
  }

  /**
   * Por qué NO se puede vender todavía. Devuelve la clave del motivo o null.
   *
   * `covers` es el catálogo del club tal como lo devuelve `GET /cover-prices`. Si tiene
   * algo, el precio deja de teclearse: hay que escoger uno. Si está vacío —un club que
   * todavía no lo carga— la puerta sigue vendiendo con el importe tecleado, porque
   * dejarla sin vender por una tabla vacía sería peor que el defecto que esto arregla.
   */
  function sellBlocker(kind, { unitPrice, reservationId, coverPriceId, covers }) {
    if (kind === 'vip_extra' && !reservationId) return 'sell.errNoPass';
    if (coverPriceId) return null;
    // Un extra VIP se cobra a la tarifa de ESA noche, que la pone el evento y no la
    // puerta: aquí no se exige nada más que el pase.
    if (kind === 'vip_extra') return null;
    if (Array.isArray(covers) && covers.length > 0) return 'sell.errPickCover';
    if (!(Number(unitPrice) >= 0) || unitPrice === '' || unitPrice === null) return 'sell.errPrice';
    return null;
  }

  /** Solo un pase que YA entró puede comprar extras: se cobran contra esa mesa. */
  const canSellExtra = (v) => Boolean(v && v.reservationId
    && (v.result === 'ok' || v.result === 'already_in'));

  // -------------------------------------------------------------- la cámara

  /**
   * Con qué se va a leer el QR, o null si este teléfono no puede.
   *
   * `native` es `BarcodeDetector` (Chrome en Android): rápido y sin descargar nada.
   * `jsqr` es la librería que vive en `vendor/jsqr`: lee cuadros de la cámara en
   * JavaScript, y es lo que hace funcionar la cámara en iPhone, donde Safari —y
   * cualquier navegador de iPhone, que por dentro es Safari— no trae
   * `BarcodeDetector`. Sin `getUserMedia` (página abierta sin HTTPS, navegador muy
   * viejo) no hay cámara que pedir y el botón ni se enseña.
   */
  function cameraMode({ hasGetUserMedia, hasBarcodeDetector, nativeFormats, hasJsQR }) {
    if (!hasGetUserMedia) return null;
    // `BarcodeDetector` puede existir y NO saber leer QR: algunos Android lo traen
    // solo para códigos de barras. Sin esta comprobación la cámara se ve y ningún
    // código se lee nunca.
    const nativoSirve = hasBarcodeDetector
      && (nativeFormats == null || (Array.isArray(nativeFormats) && nativeFormats.includes('qr_code')));
    if (nativoSirve) return 'native';
    if (hasJsQR) return 'jsqr';
    return null;
  }

  /**
   * El aviso según POR QUÉ no abrió la cámara. Un permiso negado se arregla en diez
   * segundos dándolo en el navegador; decir "este teléfono no puede" manda a teclear
   * toda la noche a quien solo tocó "No permitir" una vez.
   */
  function cameraErrorKey(err) {
    const nombre = err && err.name;
    if (nombre === 'NotAllowedError' || nombre === 'SecurityError') return 'scan.camDenied';
    if (nombre === 'NotFoundError' || nombre === 'OverconstrainedError') return 'scan.camNotFound';
    if (nombre === 'NotReadableError' || nombre === 'AbortError') return 'scan.camBusy';
    return 'scan.noCamera';
  }

  /**
   * Cuántos cuadros seguidos pueden fallar al leerse antes de dar el lector nativo por
   * roto. Un cuadro borroso falla y es normal; treinta seguidos (unos nueve segundos)
   * ya no es mala suerte, es que ese lector no sirve en este teléfono.
   */
  const MAX_DETECT_ERRORS = 30;

  /** El tamaño del cuadro que se le pasa a jsQR: más grande es más lento, no más fiable. */
  function frameSize(videoWidth, videoHeight, max = 640) {
    const w = Number(videoWidth) || 0;
    const h = Number(videoHeight) || 0;
    if (!w || !h) return null;
    const escala = Math.min(1, max / Math.max(w, h));
    return { width: Math.round(w * escala), height: Math.round(h * escala) };
  }

  const METHODS = ['cash', 'card', 'transfer', 'courtesy'];
  const methodKey = (m) => `sell.m_${m}`;

  return {
    RESULTS, TONES, view, admissionPayload, total, sellBlocker, canSellExtra, METHODS, methodKey,
    ID_DOCUMENTS, documentKey, idCheckPayload, idRejectionPayload, scanBlocker,
    idCheckRemaining, lookupBlocker, contingencyPayload, contingencyBlocker, lookupSummary,
    cameraMode, cameraErrorKey, MAX_DETECT_ERRORS, frameSize,
  };
}));
