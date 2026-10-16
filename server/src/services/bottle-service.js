/**
 * EV2 — el servicio de botella (D117).
 *
 * Una botella va con sus mezcladores, y cada mesa los pide distinto: cuatro Sprite,
 * o dos aguas minerales y un arándano. Por eso no viven en la receta de la botella
 * (que solo descuenta el licor) sino en el pedido: quien pide la botella -- el mesero
 * o el cliente -- elige los mezcladores, y este módulo decide cuánto cuestan y qué
 * insumos bajan.
 *
 * Las reglas que puso el dueño:
 *   * Solo se ofrecen los mezcladores que el gerente dio de alta (`bottle_mixers`).
 *   * Cada botella incluye hasta su tope (`drinks.included_mixers`) por pieza: dos
 *     botellas de un servicio de 4 incluyen 8 mezcladores.
 *   * Del tope en adelante, cada mezclador se cobra a su `extra_price`.
 *   * Hay dos topes por botella: CHICOS (`included_mixers`) y GRANDES
 *     (`included_large_mixers`), p. ej. 3 chicos y 1 grande. No se compensan: lo que
 *     pase del tope de grandes se cobra aunque sobren chicos, y al revés.
 *
 * El precio lo decide SIEMPRE el servidor. El teléfono manda qué mezcladores y
 * cuántos; nunca cuánto cuestan ni cuáles van incluidos.
 *
 * Cuáles van incluidos cuando se pasa del tope: los más caros. Es la cuenta más
 * favorable para el cliente y la que un mesero haría de cabeza ("te cobro los
 * baratos"), y es determinista: el mismo pedido da el mismo total siempre.
 */
'use strict';

const { ApiError } = require('../middleware/errors');

const cents = (n) => Math.round(Number(n || 0) * 100);

/** El catálogo del club, con el insumo al que apunta cada mezclador. */
async function listMixers(runner, { nightclubId, activeOnly = false }) {
  const { rows } = await runner.query(
    `SELECT m.id, m.name, m.supply_id, s.name AS supply_name, s.unit,
            m.portion::float8 AS portion, m.extra_price::text AS extra_price,
            m.size, m.active, m.sort_order
       FROM bottle_mixers m JOIN supplies s ON s.id = m.supply_id
      WHERE m.nightclub_id = $1 AND ($2::boolean IS FALSE OR (m.active AND s.active))
      ORDER BY m.size, m.sort_order, m.name`,
    [nightclubId, activeOnly]);
  return rows;
}

/**
 * Valida y pone precio a los mezcladores de un pedido.
 *
 * @param {Array} items        los renglones del pedido, cada uno con `mixers` opcional:
 *                             [{ mixer_id, quantity }]
 * @param {Map}   drinksById   las bebidas del pedido (con `included_mixers`)
 * @returns {{ perItem: Array<Array>, extraCents: number, supplies: Array }}
 *   perItem[i] = renglones de mezclador del item i (vacío si no lleva);
 *   supplies = [{ supply_id, quantity }] lo que hay que descontar de la barra.
 */
async function priceMixers(runner, { nightclubId, items, drinksById }) {
  const perItem = items.map(() => []);
  const conMezcla = items.some((i) => Array.isArray(i.mixers) && i.mixers.length > 0);
  if (!conMezcla) return { perItem, extraCents: 0, supplies: [] };

  const ids = [...new Set(items.flatMap((i) => (i.mixers || []).map((m) => m.mixer_id)))];
  const { rows } = await runner.query(
    `SELECT m.id, m.name, m.supply_id, m.portion::float8 AS portion, m.size,
            m.extra_price::text AS extra_price, m.active AND s.active AS active
       FROM bottle_mixers m JOIN supplies s ON s.id = m.supply_id
      WHERE m.nightclub_id = $1 AND m.id = ANY($2::uuid[])`,
    [nightclubId, ids]);
  const catalogo = new Map(rows.map((r) => [r.id, r]));
  const faltan = ids.filter((id) => !catalogo.has(id) || !catalogo.get(id).active);
  if (faltan.length) {
    throw ApiError.unprocessable('Ese mezclador no está disponible para el servicio', { mixer_ids: faltan });
  }

  let extraCents = 0;
  const porInsumo = new Map();
  items.forEach((item, i) => {
    const pedidos = item.mixers || [];
    if (pedidos.length === 0) return;
    const drink = drinksById.get(item.drink_id);
    if (!drink || drink.included_mixers === null || drink.included_mixers === undefined) {
      throw ApiError.unprocessable(`${drink ? drink.name : 'Esa bebida'} no lleva servicio de mezcladores`);
    }

    // El mismo mezclador dos veces en el renglón se suma: es una sola elección.
    const juntos = new Map();
    for (const p of pedidos) juntos.set(p.mixer_id, (juntos.get(p.mixer_id) || 0) + p.quantity);

    // Los más caros entran primero en lo incluido; empate, por nombre.
    const lineas = [...juntos.entries()]
      .map(([id, quantity]) => ({ mixer: catalogo.get(id), quantity }))
      .sort((a, b) => cents(b.mixer.extra_price) - cents(a.mixer.extra_price)
        || a.mixer.name.localeCompare(b.mixer.name));

    // Un tope por tamaño, y cada uno se gasta solo con los de su tamaño.
    const libres = {
      small: Number(drink.included_mixers) * item.quantity,
      large: Number(drink.included_large_mixers || 0) * item.quantity,
    };
    for (const l of lineas) {
      const size = l.mixer.size === 'large' ? 'large' : 'small';
      const included = Math.min(libres[size], l.quantity);
      libres[size] -= included;
      const charged = l.quantity - included;
      const lineCents = charged * cents(l.mixer.extra_price);
      extraCents += lineCents;
      perItem[i].push({
        mixer_id: l.mixer.id,
        supply_id: l.mixer.supply_id,
        name: l.mixer.name,
        size,
        portion: l.mixer.portion,
        quantity: l.quantity,
        included,
        charged,
        unit_price: (cents(l.mixer.extra_price) / 100).toFixed(2),
        line_total: (lineCents / 100).toFixed(2),
      });
      const q = Math.round(l.mixer.portion * l.quantity * 1000) / 1000;
      porInsumo.set(l.mixer.supply_id, Math.round(((porInsumo.get(l.mixer.supply_id) || 0) + q) * 1000) / 1000);
    }
  });

  return {
    perItem,
    extraCents,
    supplies: [...porInsumo.entries()].map(([supply_id, quantity]) => ({ supply_id, quantity })),
  };
}

/** Guarda lo que llevó cada botella, congelado al pedirla. */
async function saveMixers(client, { orderId, orderItemId, lines }) {
  for (const l of lines) {
    await client.query(
      `INSERT INTO drink_order_item_mixers (order_id, order_item_id, mixer_id, supply_id, name, size,
                                            portion, quantity, included, charged, unit_price, line_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [orderId, orderItemId, l.mixer_id, l.supply_id, l.name, l.size, l.portion, l.quantity,
        l.included, l.charged, l.unit_price, l.line_total]);
  }
}

/**
 * Lo que llevó cada renglón, para enseñarlo debajo de la botella. Es el SQL que usan
 * la pantalla de pedidos, la comanda y la cuenta, para que digan lo mismo.
 */
const ITEM_MIXERS_JSON = `
  (SELECT json_agg(json_build_object(
            'name', m.name, 'size', m.size, 'quantity', m.quantity, 'included', m.included,
            'charged', m.charged, 'unit_price', m.unit_price::text,
            'line_total', m.line_total::text) ORDER BY m.name)
     FROM drink_order_item_mixers m WHERE m.order_item_id = oi.id)`;

module.exports = { listMixers, priceMixers, saveMixers, ITEM_MIXERS_JSON };
