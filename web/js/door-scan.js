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
    not_tonight: { tone: 'warn', key: 'scan.notTonight' },
    unpaid: { tone: 'warn', key: 'scan.unpaid' },
    cancelled: { tone: 'bad', key: 'scan.cancelled' },
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
      guest: pass ? pass.guest && pass.guest.name : null,
      table: pass ? pass.table && pass.table.code : null,
      section: pass ? pass.table && pass.table.section : null,
      guestCount: pass ? pass.guest_count : null,
      extras: pass ? pass.extras_bought : 0,
      checkedInAt: pass ? pass.checked_in_at : null,
      startsAt: pass ? pass.starts_at : null,
      notes: pass ? pass.special_requests : null,
      reservationId: pass ? pass.reservation_id : null,
    };
  }

  /**
   * Lo que se manda al vender. El total se calcula aquí y se enseña ANTES de
   * cobrar: en la puerta el importe se dice en voz alta antes de que la persona
   * saque el dinero.
   */
  function admissionPayload(kind, { quantity, unitPrice, method, reservationId, notes }) {
    const cantidad = Math.min(50, Math.max(1, Math.round(Number(quantity) || 1)));
    const precio = Math.max(0, Number(unitPrice) || 0);
    const body = {
      kind,
      quantity: cantidad,
      unit_price: Math.round(precio * 100) / 100,
      payment_method: method || 'cash',
    };
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

  /** Por qué NO se puede vender todavía. Devuelve la clave del motivo o null. */
  function sellBlocker(kind, { unitPrice, reservationId }) {
    if (!(Number(unitPrice) >= 0) || unitPrice === '' || unitPrice === null) return 'sell.errPrice';
    if (kind === 'vip_extra' && !reservationId) return 'sell.errNoPass';
    return null;
  }

  /** Solo un pase que YA entró puede comprar extras: se cobran contra esa mesa. */
  const canSellExtra = (v) => Boolean(v && v.reservationId
    && (v.result === 'ok' || v.result === 'already_in'));

  const METHODS = ['cash', 'card', 'transfer', 'courtesy'];
  const methodKey = (m) => `sell.m_${m}`;

  return { RESULTS, TONES, view, admissionPayload, total, sellBlocker, canSellExtra, METHODS, methodKey };
}));
