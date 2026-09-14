/**
 * EV2 — las decisiones del almacén.
 *
 * Aquí vive lo que se puede equivocar sin que nadie lo note hasta el corte: cuántas
 * botellas son 2,630 ml, si un traspaso deja el almacén en negativo, qué falta
 * surtir antes de abrir, y si un movimiento a mano está completo antes de mandarlo.
 * Nada de esto toca el DOM ni la red, así que se prueba sin navegador — que es la
 * única forma de probar aritmética de inventario en serio.
 *
 * El servidor manda igual: todo lo que se valida aquí se vuelve a validar allá. Esto
 * existe para que el almacenista vea el error ANTES de capturar treinta renglones,
 * no para ser la única defensa.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.EV2Warehouse = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Los movimientos que se capturan a mano, y qué pide cada uno. */
  const MOVEMENTS = [
    { key: 'receive', direction: 'in', needsReason: false, needsTarget: false, needsCost: true },
    { key: 'transfer', direction: 'move', needsReason: false, needsTarget: true, needsCost: false },
    { key: 'count', direction: 'set', needsReason: false, needsTarget: false, needsCost: false },
    { key: 'waste', direction: 'out', needsReason: true, needsTarget: false, needsCost: false },
    { key: 'courtesy', direction: 'out', needsReason: true, needsTarget: false, needsCost: false },
    { key: 'issue', direction: 'out', needsReason: true, needsTarget: false, needsCost: false },
    { key: 'adjustment', direction: 'any', needsReason: true, needsTarget: false, needsCost: false },
  ];

  const movementKeys = () => MOVEMENTS.map((m) => m.key);
  const movementFor = (key) => MOVEMENTS.find((m) => m.key === key) || null;

  const round3 = (n) => Math.round(Number(n) * 1000) / 1000;

  /**
   * Cuántas presentaciones son esos mililitros.
   *
   * Se redondea a dos decimales porque "3.5 botellas" se puede comprobar mirando el
   * estante y "3.4667" no. El saldo de verdad sigue siendo el de la unidad base: esto
   * es para leerlo, no para calcular con ello.
   */
  function packagesOf(quantity, packageSize) {
    const size = Number(packageSize);
    if (!(size > 0)) return null;
    return Math.round((Number(quantity) / size) * 100) / 100;
  }

  /** El texto que se enseña de un saldo: "2,630 ml · 3.5 botellas de 750 ml". */
  function describeStock(supply, quantity, lang = 'es') {
    const amount = round3(quantity);
    const packs = packagesOf(amount, supply.package_size);
    const unit = supply.unit === 'pza' ? (lang === 'en' ? 'pcs' : 'pza') : supply.unit;
    if (supply.unit === 'pza' || packs === null || Number(supply.package_size) === 1) {
      return `${amount.toLocaleString(lang === 'en' ? 'en-US' : 'es-MX')} ${unit}`;
    }
    const label = supply.package_label || (lang === 'en' ? 'packages' : 'presentaciones');
    return `${amount.toLocaleString(lang === 'en' ? 'en-US' : 'es-MX')} ${unit} · ${packs} ${label}`;
  }

  /**
   * Convierte lo que capturó la persona a la unidad base.
   *
   * Quien recibe cuenta cajas y botellas; quien cuenta un estante cuenta botellas. El
   * sistema guarda mililitros. Hacer esa multiplicación de cabeza es como se capturan
   * entradas de 750 unidades en lugar de 750 ml.
   */
  function toBaseUnit({ amount, mode, supply }) {
    const value = Number(amount);
    if (!Number.isFinite(value)) return null;
    if (mode === 'packages') return round3(value * Number(supply.package_size));
    return round3(value);
  }

  /**
   * ¿Qué va a pasar si mando esto? Se responde ANTES de mandarlo.
   *
   * Devuelve el saldo que quedaría en cada lugar involucrado, para poder enseñarlo
   * junto al botón. Un almacenista que ve "quedarían 0.5 botellas" corrige antes de
   * mandar; uno que solo ve un mensaje de error después, no entiende qué pasó.
   */
  function preview({ kind, supply, from, to, quantity }) {
    const move = movementFor(kind);
    if (!move) return null;
    const qty = round3(quantity);
    const before = Number(from ? from.stock : 0);

    if (move.direction === 'in') {
      return [{ location: to || from, before, after: round3(before + qty) }];
    }
    if (move.direction === 'out') {
      return [{ location: from, before, after: round3(before - Math.abs(qty)) }];
    }
    if (move.direction === 'set') {
      return [{ location: from, before, after: qty, difference: round3(qty - before) }];
    }
    if (move.direction === 'any') {
      return [{ location: from, before, after: round3(before + qty) }];
    }
    // Traspaso: los dos lados, porque el error típico es vaciar el almacén sin verlo.
    const toBefore = Number(to ? to.stock : 0);
    return [
      { location: from, before, after: round3(before - qty) },
      { location: to, before: toBefore, after: round3(toBefore + qty) },
    ];
  }

  /**
   * ¿Está completo el movimiento? Devuelve la lista de lo que falta, por campo.
   *
   * Se devuelven claves, no frases: la pantalla las traduce. Y se devuelven TODAS las
   * que fallan, no la primera, para no mandar a corregir de una en una.
   */
  function validate({ kind, supply, from, to, quantity, reason, unitCost }) {
    const move = movementFor(kind);
    const problems = [];
    if (!move) return [{ field: 'kind', code: 'unknown_movement' }];
    if (!supply) problems.push({ field: 'supply', code: 'required' });
    if (!from) problems.push({ field: 'from', code: 'required' });

    const qty = Number(quantity);
    if (!Number.isFinite(qty)) problems.push({ field: 'quantity', code: 'required' });
    else if (move.direction === 'set') {
      if (qty < 0) problems.push({ field: 'quantity', code: 'negative' });
    } else if (qty === 0) problems.push({ field: 'quantity', code: 'zero' });
    else if (move.direction !== 'any' && qty < 0) {
      problems.push({ field: 'quantity', code: 'negative' });
    }

    if (move.needsTarget) {
      if (!to) problems.push({ field: 'to', code: 'required' });
      else if (from && to.id === from.id) problems.push({ field: 'to', code: 'same_place' });
    }
    if (move.needsReason && !String(reason || '').trim()) {
      problems.push({ field: 'reason', code: 'required' });
    }
    if (unitCost !== undefined && unitCost !== null && unitCost !== '' && Number(unitCost) < 0) {
      problems.push({ field: 'unit_cost', code: 'negative' });
    }

    // Lo que no hay no se puede sacar. El servidor lo rechaza igual, pero enterarse
    // aquí evita capturar un surtido entero contra un almacén vacío.
    if (from && Number.isFinite(qty) && ['out', 'move'].includes(move.direction)) {
      const available = Number(from.stock || 0);
      if (Math.abs(qty) > available + 1e-9) {
        problems.push({
          field: 'quantity', code: 'not_enough', available, needed: Math.abs(qty),
        });
      }
    }
    return problems;
  }

  /** El cuerpo que espera la API para cada movimiento. */
  function requestFor({ kind, supply, from, to, quantity, reason, unitCost, mode }) {
    const amountField = mode === 'packages' ? 'packages' : 'quantity';
    const base = {};
    if (kind === 'receive') {
      base.location_id = (to || from).id;
      base[amountField] = Number(quantity);
      if (unitCost !== undefined && unitCost !== null && unitCost !== '') {
        base.package_cost = Number(unitCost);
      }
      if (reason) base.reason = String(reason).trim();
      return { path: `/supplies/${supply.id}/receive`, body: base };
    }
    if (kind === 'transfer') {
      base.from_location_id = from.id;
      base.to_location_id = to.id;
      base[amountField] = Number(quantity);
      if (reason) base.reason = String(reason).trim();
      return { path: `/supplies/${supply.id}/transfer`, body: base };
    }
    if (kind === 'count') {
      base.location_id = from.id;
      base[mode === 'packages' ? 'counted_packages' : 'counted'] = Number(quantity);
      if (reason) base.reason = String(reason).trim();
      return { path: `/supplies/${supply.id}/count`, body: base };
    }
    base.location_id = from.id;
    base.kind = kind;
    base[amountField] = Number(quantity);
    base.reason = String(reason || '').trim();
    return { path: `/supplies/${supply.id}/adjust`, body: base };
  }

  /**
   * Lo que hay que surtir antes de abrir: lo que está bajo mínimo en una barra y
   * todavía hay en el almacén.
   *
   * Es la lista que de verdad usa el almacenista, y no existía: "bajo mínimo" a secas
   * incluye lo que tampoco hay en el almacén, que no es una tarea sino una compra.
   */
  function restockList(supplies, { barCode } = {}) {
    const list = [];
    for (const supply of supplies) {
      const locations = supply.locations || [];
      const warehouse = locations.find((l) => l.kind === 'warehouse');
      for (const location of locations) {
        if (location.kind !== 'bar') continue;
        if (barCode && location.code !== barCode) continue;
        if (!location.low) continue;
        const missing = round3(Number(location.min_stock) - Number(location.stock));
        const available = warehouse ? Number(warehouse.stock) : 0;
        list.push({
          supply_id: supply.id,
          name: supply.name,
          unit: supply.unit,
          package_size: Number(supply.package_size),
          location_id: location.location_id,
          location_name: location.name,
          missing,
          missing_packages: packagesOf(missing, supply.package_size),
          available_in_warehouse: available,
          // Si no hay en el almacén no es un surtido pendiente: es una compra
          // pendiente, y mezclarlas hace que el almacenista persiga fantasmas.
          action: available >= missing ? 'transfer' : (available > 0 ? 'partial' : 'purchase'),
        });
      }
    }
    return list.sort((a, b) => {
      const order = { transfer: 0, partial: 1, purchase: 2 };
      if (order[a.action] !== order[b.action]) return order[a.action] - order[b.action];
      return a.name.localeCompare(b.name);
    });
  }

  /** Agrupa para pintar: una sección por categoría, ordenadas por nombre. */
  function byCategory(supplies) {
    const groups = new Map();
    for (const supply of supplies) {
      const key = supply.category || 'Otros';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(supply);
    }
    return [...groups.entries()]
      .map(([category, items]) => ({
        category,
        items: items.slice().sort((a, b) => a.name.localeCompare(b.name)),
        low: items.filter((i) => i.low).length,
        unconfirmed: items.filter((i) => i.size_confirmed === false).length,
      }))
      .sort((a, b) => a.category.localeCompare(b.category));
  }

  /** Valor del inventario, por lugar y total. Al costo, nunca al precio de venta. */
  function inventoryValue(supplies) {
    const byLocation = new Map();
    let total = 0;
    for (const supply of supplies) {
      const cost = Number(supply.avg_cost || 0);
      for (const location of supply.locations || []) {
        const value = Number(location.stock) * cost;
        byLocation.set(location.name, round3((byLocation.get(location.name) || 0) + value));
        total += value;
      }
    }
    return { total: Math.round(total * 100) / 100, byLocation: [...byLocation.entries()] };
  }

  return {
    MOVEMENTS,
    movementKeys,
    movementFor,
    packagesOf,
    describeStock,
    toBaseUnit,
    preview,
    validate,
    requestFor,
    restockList,
    byCategory,
    inventoryValue,
    round3,
  };
}));
