/**
 * EV2 — promociones por evento (D102, parte B).
 *
 * El precio de una promocion lo calcula SIEMPRE el servidor: el cliente manda bebida y
 * cantidad, nunca un precio. Aqui viven las dos mitades: cuales promociones estan
 * vigentes ahora (SQL, con la noche y la hora del club) y cuanto cuesta un renglon con
 * ellas (funciones puras, probadas sin base de datos).
 */
'use strict';

const cents = (n) => Math.round(Number(n) * 100);

/**
 * Total de `quantity` piezas, en centavos, con UNA promocion. Sin redondeos a medias:
 * todo se hace en centavos enteros y el porcentaje se redondea una sola vez, por pieza.
 */
function totalCents(listPrice, quantity, promo) {
  const list = cents(listPrice);
  if (!promo) return list * quantity;
  // El trago especial (D114) no tiene descuento: existe para planear, no para cobrar.
  if (promo.kind === 'special') return list * quantity;
  if (promo.kind === 'fixed_price') return Math.min(list, cents(promo.value)) * quantity;
  if (promo.kind === 'percent') {
    return Math.round(list * (1 - Number(promo.value) / 100)) * quantity;
  }
  if (promo.kind === 'n_for_m') {
    const n = Number(promo.buy_qty);
    const m = Number(promo.pay_qty);
    const free = Math.floor(quantity / n) * (n - m);
    return list * (quantity - free);
  }
  return list * quantity;
}

/** La promocion que deja el total mas bajo para esa cantidad (nunca se acumulan). */
function bestPromo(listPrice, quantity, promos) {
  let best = null;
  let bestTotal = cents(listPrice) * quantity;
  for (const p of promos || []) {
    const total = totalCents(listPrice, quantity, p);
    if (total < bestTotal) { best = p; bestTotal = total; }
  }
  return best;
}

/**
 * Precios de un pedido. Entra la lista de renglones en orden y las promociones vigentes;
 * sale, por renglon, el precio unitario, el total del renglon y la promocion.
 *
 * Una bebida repetida en varios renglones se cuenta junta (un 2x1 pedido en dos renglones
 * de uno sigue siendo un 2x1): cada renglon paga la diferencia de lo acumulado.
 *
 * `unit_price` es lo que se muestra por pieza; en un n_for_m queda el precio de carta y
 * el descuento vive en `line_total`.
 */
function priceLines(lines, drinksById, promosFor) {
  const totalQty = new Map();
  for (const l of lines) totalQty.set(l.drink_id, (totalQty.get(l.drink_id) || 0) + l.quantity);

  const chosen = new Map();
  for (const [id, qty] of totalQty) {
    const d = drinksById.get(id);
    chosen.set(id, bestPromo(d.price, qty, promosFor(d)));
  }

  const seen = new Map();
  return lines.map((l) => {
    const d = drinksById.get(l.drink_id);
    const promo = chosen.get(l.drink_id);
    const before = seen.get(l.drink_id) || 0;
    const after = before + l.quantity;
    seen.set(l.drink_id, after);
    if (!promo) {
      return { drink_id: l.drink_id, quantity: l.quantity, unitPrice: Number(d.price),
        listPrice: null, lineTotal: null, promoId: null,
        totalCents: cents(d.price) * l.quantity };
    }
    const lineCents = totalCents(d.price, after, promo) - totalCents(d.price, before, promo);
    const unit = promo.kind === 'n_for_m'
      ? Number(d.price)
      : totalCents(d.price, 1, promo) / 100;
    return { drink_id: l.drink_id, quantity: l.quantity, unitPrice: unit,
      listPrice: Number(d.price), lineTotal: lineCents / 100, promoId: promo.id,
      totalCents: lineCents };
  });
}

/**
 * Las promociones vigentes AHORA: de la noche de negocio del club (las 6 de la manana
 * cierran el dia), de un evento que no este cancelado ni terminado, activas, y dentro de
 * su horario si lo tienen (que puede cruzar la medianoche).
 */
async function activeNow(runner, { nightclubId }) {
  const { rows } = await runner.query(
    `WITH n AS (
       SELECT (now() AT TIME ZONE c.timezone) AS local_now,
              ((now() AT TIME ZONE c.timezone) - interval '6 hours')::date AS bd
         FROM nightclubs c WHERE c.id = $1)
     SELECT p.id::text AS id, p.name, p.kind, p.drink_id::text AS drink_id, p.category,
            p.value::float8 AS value, p.buy_qty, p.pay_qty,
            p.starts_time::text AS starts_time, p.ends_time::text AS ends_time,
            e.id::text AS event_id, e.name AS event_name
       FROM event_promotions p
       JOIN events_calendar e ON e.id = p.event_id
       CROSS JOIN n
      WHERE p.nightclub_id = $1 AND p.active
        AND e.event_date = n.bd AND e.status NOT IN ('cancelled','finished')
        AND (p.starts_time IS NULL
             OR (p.starts_time < p.ends_time
                 AND n.local_now::time >= p.starts_time AND n.local_now::time < p.ends_time)
             OR (p.starts_time > p.ends_time
                 AND (n.local_now::time >= p.starts_time OR n.local_now::time < p.ends_time)))
      ORDER BY p.created_at, p.id`,
    [nightclubId]);
  return rows;
}

/** Las promociones que le tocan a una bebida: la suya o las de su categoria. */
function promosForDrink(promos) {
  return (drink) => promos.filter((p) => p.drink_id === String(drink.id)
    || (p.category && p.category === drink.category));
}

/** Etiqueta corta para mostrar: «2x1», «-20%», «$60». */
function badge(p) {
  if (p.kind === 'special') return '★';
  if (p.kind === 'n_for_m') return `${p.buy_qty}x${p.pay_qty}`;
  if (p.kind === 'percent') return `-${Number(p.value)}%`;
  return `$${Number(p.value).toFixed(2).replace(/\.00$/, '')}`;
}

/**
 * Lo que se muestra de una bebida con promocion: la que mas conviene, su etiqueta y el
 * precio por pieza cuando es de precio fijo o porcentaje (en un n_for_m no hay precio por
 * pieza: depende de cuantas se lleven).
 */
function summary(drink, promos) {
  if (!promos.length) return null;
  const qty = Math.max(1, ...promos.map((p) => Number(p.buy_qty) || 1));
  const best = bestPromo(drink.price, qty, promos);
  if (!best) return null;
  return {
    id: best.id, name: best.name, kind: best.kind, badge: badge(best),
    value: best.value, buy_qty: best.buy_qty, pay_qty: best.pay_qty,
    unit_price: best.kind === 'n_for_m' ? null : totalCents(drink.price, 1, best) / 100,
    starts_time: best.starts_time, ends_time: best.ends_time,
  };
}

module.exports = { summary, totalCents, bestPromo, priceLines, activeNow, promosForDrink, badge };
