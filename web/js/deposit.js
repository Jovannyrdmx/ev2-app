/**
 * EV2 — el anticipo por transferencia y el resto en la puerta (D113), sin DOM.
 *
 * Tres pantallas usan esto: la del cliente (pagar el anticipo y subir su
 * comprobante), la del gerente y la de la puerta (revisar comprobantes y cobrar el
 * resto). Las decisiones viven aquí, juntas y probadas, para que las tres digan lo
 * mismo de la misma reservación.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2Deposit = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const cents = (n) => Math.round(Number(n || 0) * 100);
  const fromCents = (c) => (c / 100).toFixed(2);

  /**
   * En qué punto va el anticipo, para la página del cliente.
   *
   *   pay       — falta mandar el comprobante (o el último se rechazó: `rejected` lo dice);
   *   review    — mandó su comprobante y el club lo está revisando;
   *   confirmed — el anticipo está pagado: la mesa es suya;
   *   closed    — la reservación ya no espera nada (cancelada, no llegó).
   */
  function stage(info) {
    const r = (info && info.reservation) || {};
    if (['cancelled', 'no_show', 'completed'].includes(r.status)) return 'closed';
    if (info && info.deposit_status === 'paid') return 'confirmed';
    if (['confirmed', 'seated'].includes(r.status)) return 'confirmed';
    if (info && info.deposit_status === 'pending_manual') return 'review';
    return 'pay';
  }

  /** El último comprobante se rechazó y el cliente tiene que mandar otro. */
  const wasRejected = (info) => Boolean(info && info.last_proof
    && info.last_proof.status === 'rejected' && stage(info) === 'pay');

  /** Lo que falta pagar al llegar, después del anticipo. */
  function restAtDoor(info) {
    if (!info) return '0.00';
    const total = cents(info.total);
    const pagado = cents(info.paid);
    const anticipo = stage(info) === 'confirmed' ? 0 : cents(info.deposit_amount_due || info.deposit);
    return fromCents(Math.max(0, total - pagado - anticipo));
  }

  const PROOF_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
  const PROOF_MAX_BYTES = 10 * 1024 * 1024;

  /**
   * Por qué no se puede mandar todavía el comprobante (clave de texto) o null.
   * El servidor lo vuelve a revisar todo: esto es para no mandar una foto de 30 MB
   * por datos móviles y enterarse después.
   */
  function proofBlocker({ file, optionId, options }) {
    if (Array.isArray(options) && options.length > 0 && !optionId) return 'dpo.errPickAccount';
    if (!file) return 'dpo.errNoFile';
    // Algunos teléfonos no dicen el tipo (HEIC en Android): se deja pasar y decide el servidor.
    if (file.type && !PROOF_TYPES.includes(file.type)) return 'dpo.errType';
    if (file.size > PROOF_MAX_BYTES) return 'dpo.errSize';
    return null;
  }

  const methodKey = (m) => `dpo.m_${m}`;

  /**
   * El cambio al cobrar el resto en efectivo. `received` vacío = exacto.
   * Devuelve { ok, change, missing } en texto de dos decimales.
   */
  function cashChange(due, received) {
    const debe = cents(due);
    const dio = received === '' || received === null || received === undefined
      ? debe : cents(received);
    if (!Number.isFinite(dio)) return { ok: false, change: '0.00', missing: fromCents(debe) };
    if (dio < debe) return { ok: false, change: '0.00', missing: fromCents(debe - dio) };
    return { ok: true, change: fromCents(dio - debe), missing: '0.00' };
  }

  /** Un renglón de la cola de revisión, listo para pintar. */
  function reviewLine(item) {
    const p = (item && item.payment) || {};
    const r = (item && item.reservation) || {};
    return {
      paymentId: p.id,
      amount: p.amount,
      currency: p.currency,
      method: p.method,
      reference: p.reference || null,
      hasProof: Boolean(p.proof),
      isPdf: Boolean(p.proof && p.proof.mime === 'application/pdf'),
      sentAt: p.created_at,
      who: r.holder_name || (p.declared_by && p.declared_by.name) || '',
      phone: r.holder_phone || null,
      table: r.table_code || null,
      event: r.event_name || null,
      guests: r.guest_count || null,
      status: p.status,
    };
  }

  /** El motivo de un rechazo: obligatorio y con algo de texto, como lo exige el servidor. */
  const rejectBlocker = (reason) => (String(reason || '').trim().length < 5 ? 'dpo.errReason' : null);

  return {
    stage, wasRejected, restAtDoor, proofBlocker, methodKey, cashChange, reviewLine, rejectBlocker,
    PROOF_TYPES, PROOF_MAX_BYTES,
  };
}));
