/**
 * EV2 — promociones por evento (D102): las cuentas de las pantallas.
 *
 * Funciones puras, probadas en Node. El servidor manda: calcula el precio al crear el
 * pedido y cada bebida llega con su `promo` vigente (ver `GET /drinks`). Esto solo sirve
 * para mostrar el precio de oferta y estimar el total de un carrito, y nunca manda un
 * precio.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.EV2Promos = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const cents = (n) => Math.round(Number(n) * 100);

  /** Total en centavos de `qty` piezas de una bebida, con su promocion si la tiene. */
  function lineCents(drink, qty) {
    const list = cents(drink.price);
    const p = drink.promo;
    if (!p) return list * qty;
    if (p.kind === 'n_for_m') {
      const n = Number(p.buy_qty);
      const m = Number(p.pay_qty);
      return list * (qty - Math.floor(qty / n) * (n - m));
    }
    if (p.unit_price === null || p.unit_price === undefined) return list * qty;
    return Math.min(list, cents(p.unit_price)) * qty;
  }

  /** «2x1», «-20%», «$45», o '' si la bebida no tiene promocion. */
  const badge = (drink) => (drink && drink.promo ? drink.promo.badge : '');

  /** Precio por pieza de oferta (precio fijo o porcentaje); null en un 2x1 o sin promo. */
  function unitPrice(drink) {
    const p = drink && drink.promo;
    if (!p || p.unit_price === null || p.unit_price === undefined) return null;
    return Number(p.unit_price) < Number(drink.price) ? Number(p.unit_price) : null;
  }

  /** Horario legible de la promocion: «22:00–00:30», o '' si dura toda la noche. */
  function window(drink) {
    const p = drink && drink.promo;
    return p && p.starts_time ? `${p.starts_time.slice(0, 5)}–${p.ends_time.slice(0, 5)}` : '';
  }

  /**
   * El precio de una bebida como se pinta en las listas: con oferta de precio, el de
   * carta tachado y el de oferta; con 2x1 o sin precio por pieza, el de carta. Siempre la
   * etiqueta. `fmt(amount, currency)` da el dinero; `esc` escapa el texto.
   */
  function priceHtml(drink, fmt, esc) {
    const list = fmt(drink.price, drink.currency);
    const u = unitPrice(drink);
    const tag = badge(drink);
    const when = window(drink);
    const tagHtml = tag
      ? ` <span class="rounded-full bg-fuchsia-500/20 text-fuchsia-200 px-2 py-0.5 text-[11px]" data-role="promo-badge">${esc(tag)}${when ? ` · ${esc(when)}` : ''}</span>`
      : '';
    if (u === null) return `${esc(list)}${tagHtml}`;
    return `<span class="line-through text-white/40">${esc(list)}</span> <span class="text-emerald-300">${esc(fmt(u, drink.currency))}</span>${tagHtml}`;
  }

  /**
   * Lo que manda el formulario del gerente, validado. Devuelve `{ body }` o `{ error }`
   * con la clave del problema (name, value, buy, pay, target, window), para que la
   * pantalla diga cual campo esta mal sin reinventar las reglas del servidor.
   */
  function payload(f) {
    const name = String(f.name || '').trim();
    if (!name) return { error: 'name' };
    const body = { name, kind: f.kind };
    if (f.targetKind === 'category') {
      if (!f.category) return { error: 'target' };
      body.category = f.category;
    } else {
      if (!f.drinkId) return { error: 'target' };
      body.drink_id = f.drinkId;
    }
    if (f.kind === 'fixed_price') {
      const v = Number(String(f.price).replace(',', '.'));
      if (String(f.price).trim() === '' || !Number.isFinite(v) || v < 0) return { error: 'value' };
      body.value = v;
    } else if (f.kind === 'percent') {
      const v = Number(String(f.pct).replace(',', '.'));
      if (String(f.pct).trim() === '' || !Number.isFinite(v) || v <= 0 || v > 100) return { error: 'value' };
      body.value = v;
    } else if (f.kind === 'n_for_m') {
      const n = Number(f.buy);
      const m = Number(f.pay);
      if (!Number.isInteger(n) || n < 2 || n > 20) return { error: 'buy' };
      if (!Number.isInteger(m) || m < 0 || m >= n) return { error: 'pay' };
      body.buy_qty = n;
      body.pay_qty = m;
    } else return { error: 'value' };
    const from = String(f.from || '');
    const to = String(f.to || '');
    if (from || to) {
      if (!from || !to || from === to) return { error: 'window' };
      body.starts_time = from;
      body.ends_time = to;
    }
    return { body };
  }

  return { lineCents, badge, unitPrice, window, priceHtml, payload };
}));
