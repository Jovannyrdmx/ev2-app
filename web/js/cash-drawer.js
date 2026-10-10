/**
 * EV2 — el cajón de dinero y el cambio en efectivo, en pantalla (D96).
 *
 * Lo comparten la caja (`caja.html`) y la puerta (`staff.html`):
 *   - `change()` calcula EN VIVO lo que se ve mientras la persona cuenta el dinero.
 *     Es la misma regla del servidor (que es quien decide): dólares al tipo de cambio,
 *     cubren hasta el total, lo que sobra de dólares vuelve en pesos redondeado hacia
 *     abajo al peso, y los pesos pagan lo que falte con cambio exacto;
 *   - `notice()` traduce lo que contestó el servidor sobre el cajón a un aviso;
 *   - `openNoSale()` abre el cajón sin venta, con motivo y PIN del gerente.
 */
(function (root, factory) {
  'use strict';
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.EV2Drawer = lib;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const cents = (n) => Math.round(Number(n || 0) * 100);
  const fromCents = (c) => (c / 100).toFixed(2);
  const filled = (v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v));

  /**
   * El cambio, en pesos.
   *   total: lo que cuesta (pesos); mxn: pesos recibidos; usd: dólares recibidos;
   *   rate: pesos por dólar.
   * Devuelve { ready, missing, change, usdMxn } en texto con dos decimales, o
   * `{ ready: false }` si todavía no se ha capturado nada.
   */
  function change({ total, mxn, usd, rate }) {
    const hayPesos = filled(mxn) && Number(mxn) > 0;
    const hayDolares = filled(usd) && Number(usd) > 0;
    if (!filled(total) || (!hayPesos && !hayDolares)) return { ready: false };
    if (hayDolares && !(Number(rate) > 0)) return { ready: false, needsRate: true };
    const totalC = cents(total);
    const usdMxnC = hayDolares ? Math.round(Number(usd) * Number(rate) * 100) : 0;
    const usdAmountC = Math.min(usdMxnC, totalC);
    const usdChangeC = hayDolares ? Math.floor((usdMxnC - usdAmountC) / 100) * 100 : 0;
    const pesosDueC = totalC - usdAmountC;
    const pesosC = hayPesos ? cents(mxn) : 0;
    if (pesosC < pesosDueC) {
      return { ready: true, ok: false, missing: fromCents(pesosDueC - pesosC), usdMxn: fromCents(usdMxnC) };
    }
    return {
      ready: true,
      ok: true,
      missing: '0.00',
      change: fromCents((pesosC - pesosDueC) + usdChangeC),
      usdMxn: fromCents(usdMxnC),
    };
  }

  /** Agrega lo recibido al cuerpo de la venta de la puerta. */
  function tenderPayload(body, { mxn, usd, rateId }) {
    const out = { ...body };
    if (out.payment_method !== 'cash') return out;
    if (filled(mxn) && Number(mxn) > 0) out.cash_received = Math.round(Number(mxn) * 100) / 100;
    if (filled(usd) && Number(usd) > 0) {
      out.usd_received = Math.round(Number(usd) * 100) / 100;
      if (rateId) out.exchange_rate_id = String(rateId);
    }
    return out;
  }

  /**
   * Lo que se le dice a quien cobra sobre el cajón, o `null` si no hay nada que
   * decir. Solo se avisa lo que obliga a hacer algo: que NO va a abrirse.
   */
  function notice(drawer) {
    if (!drawer) return null;
    if (drawer.status === 'failed') return { key: 'drawer.failed', tone: 'warn' };
    return null;
  }

  /** El aviso en vivo de que el pulso no salió (impresora sin papel, apagada…). */
  function failedEvent(message) {
    if (!message || message.type !== 'print_job_failed') return null;
    const p = message.payload || {};
    if (p.kind !== 'drawer') return null;
    return { key: 'drawer.notOpened', vars: { error: p.error || '' }, tone: 'error' };
  }

  /**
   * Abrir sin venta: pide motivo y PIN del gerente con los diálogos de la app.
   * `deps`: { api, clubId, t, toast, ui } — `ui` es `EV2UI`.
   */
  async function openNoSale(deps) {
    const { api, clubId, t, toast, ui } = deps;
    if (!ui) return null;
    const reason = await ui.prompt(t('drawer.reasonPrompt'), { ok: t('drawer.next') });
    if (reason === null) return null;
    if (String(reason).trim().length < 3) { toast(t('drawer.reasonShort'), 'error'); return null; }
    const pin = await ui.prompt(t('drawer.pinPrompt'), { inputmode: 'numeric', secret: true, ok: t('drawer.open') });
    if (pin === null) return null;
    try {
      const res = await api.post(`/nightclubs/${clubId()}/cash-drawer/open`, {
        reason: String(reason).trim(), manager_pin: String(pin).trim(),
      });
      const aviso = notice(res.drawer);
      if (aviso) toast(t(aviso.key), 'error', 9000);
      else toast(t('drawer.opened', { name: res.authorized_by || '' }), 'ok');
      return res;
    } catch (err) {
      toast(deps.errorMessage ? deps.errorMessage(err) : String(err.message || err), 'error', 7000);
      return null;
    }
  }

  return { change, tenderPayload, notice, failedEvent, openNoSale };
}));
