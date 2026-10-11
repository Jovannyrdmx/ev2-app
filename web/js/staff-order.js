/**
 * EV2 — el pedido de consumo del personal (D101): las cuentas de la pantalla.
 *
 * Funciones puras, probadas en Node. El servidor manda: el precio que se descuenta lo
 * calcula él al crear el pedido; esto solo muestra al empleado cuánto va a costarle, y
 * nunca manda un precio.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2StaffOrder = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const cents = (n) => Math.round(Number(n) * 100);

  /** Lo que se le descuenta por una pieza: precio de la carta menos el porcentaje. */
  function staffPrice(price, pct) {
    return Math.round(cents(price) * (1 - Number(pct) / 100)) / 100;
  }

  /** Lo que se puede pedir: lo que la barra no apagó. */
  const orderable = (drinks) => (drinks || []).filter((d) => d && d.available !== false);

  /** Agrupa por categoría, con las categorías y los productos en orden alfabético. */
  function byCategory(drinks) {
    const groups = new Map();
    for (const d of orderable(drinks)) {
      const key = d.category || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }
    return [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([category, items]) => ({
        category, items: items.slice().sort((x, y) => String(x.name).localeCompare(String(y.name))),
      }));
  }

  /** El carrito: id de bebida → cantidad (1 a 20). */
  function createCart() {
    const lines = new Map();
    return {
      set(id, quantity) {
        const q = Math.max(0, Math.min(20, Math.trunc(Number(quantity) || 0)));
        if (q === 0) lines.delete(id); else lines.set(id, q);
      },
      add(id, delta = 1) { this.set(id, (lines.get(id) || 0) + delta); },
      quantity: (id) => lines.get(id) || 0,
      count: () => [...lines.values()].reduce((a, b) => a + b, 0),
      items: () => [...lines.entries()].map(([drink_id, quantity]) => ({ drink_id, quantity })),
      clear() { lines.clear(); },
      isEmpty: () => lines.size === 0,
    };
  }

  /** Total de lista y total a descontar de un carrito, en centavos exactos. */
  function totals(cart, drinks, pct) {
    const byId = new Map((drinks || []).map((d) => [d.id, d]));
    let list = 0;
    for (const { drink_id: id, quantity } of cart.items()) {
      const d = byId.get(id);
      if (d) list += cents(d.price) * quantity;
    }
    return {
      list: list / 100,
      deduct: Math.round(list * (1 - Number(pct) / 100)) / 100,
    };
  }

  return { staffPrice, orderable, byCategory, createCart, totals };
}));
