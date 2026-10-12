/**
 * EV2 — precio y personas por mesa VIP (D103): las cuentas de la pantalla del gerente.
 *
 * Funciones puras, probadas en Node. Una mesa con precio o personas propios manda sobre su
 * zona; vacios, usa los de la zona. Aqui se agrupan las mesas por zona, se calcula lo que
 * vera el cliente y se arma SOLO lo que cambio, para que guardar no toque otras mesas.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.EV2TablePricing = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

  /** Mesas con precio de zona y que se reservan, agrupadas por zona en el orden del club. */
  function groupByZone(tables, zones) {
    const byZone = new Map((zones || []).map((z) => [z.section, z]));
    const groups = new Map();
    for (const t of (tables || [])) {
      const zone = byZone.get(t.section);
      if (!zone || zone.reservable === false) continue;
      if (!groups.has(t.section)) {
        groups.set(t.section, { section: t.section, zone, tables: [] });
      }
      groups.get(t.section).tables.push(t);
    }
    const order = new Map((zones || []).map((z, i) => [z.section, i]));
    return [...groups.values()]
      .sort((a, b) => order.get(a.section) - order.get(b.section))
      .map((g) => ({
        ...g,
        tables: g.tables.slice().sort((x, y) => (num(x.table_number) ?? 1e9) - (num(y.table_number) ?? 1e9)
          || String(x.code).localeCompare(String(y.code))),
      }));
  }

  /** Lo que vera el cliente: la mesa si tiene dato propio, si no la zona. */
  function effective(table, zone) {
    const own = { price: num(table.vip_price), people: num(table.vip_capacity) };
    return {
      price: own.price !== null ? own.price : num(zone.base_price),
      people: own.people !== null ? own.people : num(zone.included_tickets),
      priceFromTable: own.price !== null,
      peopleFromTable: own.people !== null,
    };
  }

  /** Un campo del formulario: vacio = null (vuelve a la zona), o un numero valido. */
  function parseField(kind, text) {
    const raw = String(text === null || text === undefined ? '' : text).trim().replace(',', '.');
    if (raw === '') return { value: null };
    const n = Number(raw);
    if (!Number.isFinite(n)) return { error: kind };
    if (kind === 'price') return n >= 0 && n <= 1000000 ? { value: Math.round(n * 100) / 100 } : { error: kind };
    return Number.isInteger(n) && n >= 1 && n <= 50 ? { value: n } : { error: kind };
  }

  /**
   * Los cambios a mandar: solo las mesas cuyo precio o personas difieren de lo guardado.
   * `edits` es id -> { price, people } con el texto de los campos. Devuelve
   * `{ changes, errors }`; con algun error no se manda nada.
   */
  function diff(tables, edits) {
    const changes = [];
    const errors = [];
    for (const t of (tables || [])) {
      const e = edits.get(t.id);
      if (!e) continue;
      const price = parseField('price', e.price);
      const people = parseField('people', e.people);
      if (price.error || people.error) {
        errors.push({ id: t.id, field: price.error ? 'price' : 'people' });
        continue;
      }
      if (price.value !== num(t.vip_price) || people.value !== num(t.vip_capacity)) {
        changes.push({ id: t.id, vip_price: price.value, vip_capacity: people.value });
      }
    }
    return { changes, errors };
  }

  return { groupByZone, effective, parseField, diff };
}));
