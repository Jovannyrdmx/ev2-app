/**
 * Existencias reales: el insumo, el lugar, la receta y el kardex.
 *
 * Este es el unico lugar del sistema que mueve una existencia. No porque quede
 * ordenado, sino porque un saldo que se puede cambiar desde tres rutas distintas
 * termina siendo un numero que nadie puede explicar, y un inventario que nadie
 * puede explicar no sirve para pedirle cuentas a nadie.
 *
 * Cuatro reglas cargan el peso:
 *
 *   1. Cada cambio de saldo escribe su renglon en `supply_movements`, con motivo, con
 *      el lugar y con el saldo que quedo. El saldo es la historia; sin la historia
 *      es un rumor.
 *   2. El saldo es de un INSUMO EN UN LUGAR. Treinta botellas repartidas entre el
 *      almacen y dos barras no son treinta botellas disponibles: son diez, quince y
 *      cinco, y la barra de arriba se queda sin servir aunque el total diga treinta.
 *   3. Un traspaso son dos renglones unidos por `transfer_group` -- uno que sale y
 *      otro que entra -- para que `balance_after` siga significando algo en cada
 *      lugar. Nunca se mueve producto "en general".
 *   4. Lo que devuelve una cancelacion sale del kardex, NO de volver a calcular la
 *      receta. Si la receta cambio entre que se sirvio y que se cancelo, recalcular
 *      devolveria una cantidad que nunca salio.
 *
 * Un producto SIN receta no tiene control de existencia: se vende libre y se
 * reporta como `null`, que quiere decir "no se lleva", no "hay cero". Inventar un
 * numero aqui es justo lo que hacia inutil al inventario anterior.
 */
'use strict';

const { ApiError } = require('../middleware/errors');

/** Las tres unidades base. Todo -saldo, receta y costo- habla en una de ellas. */
const UNITS = ['ml', 'g', 'pza'];

/**
 * Los movimientos posibles y de que lado del saldo caen.
 *
 * `issue` es una salida que no es venta ni traspaso: producto que sale del club
 * (una botella que se manda a un evento fuera, por ejemplo). `courtesy` es lo que
 * el club regala y quiere poder sumar por separado al final de la noche: sale del
 * inventario igual que una venta, pero no entra dinero por ella y confundirlas es
 * como se "pierde" producto que en realidad se autorizo.
 */
const MOVEMENT_KINDS = ['receipt', 'issue', 'transfer_in', 'transfer_out', 'consumption',
  'return', 'waste', 'courtesy', 'count', 'adjustment'];

/** Los que captura una persona a mano y por eso exigen motivo. */
const MANUAL_KINDS = ['adjustment', 'count', 'waste', 'courtesy', 'issue'];

/** Redondeo a milesimas: es la precision de las columnas NUMERIC(.,3). */
const round3 = (n) => Math.round(Number(n) * 1000) / 1000;

/**
 * Aplica un movimiento sobre (insumo, lugar) y deja su renglon en el kardex.
 *
 * `quantity` con signo: positivo entra, negativo sale. Espera que la fila de
 * existencia ya este bloqueada por quien llama (`lockStock`), porque el saldo se
 * lee para escribir `balance_after` y sin el bloqueo dos pedidos simultaneos
 * dejarian dos renglones con el mismo saldo final y uno de los dos seria mentira.
 */
async function move(client, { nightclubId, supplyId, locationId, kind, quantity, unitCost = null,
  referenceType = null, referenceId = null, reason = null, userId = null, authorizedBy = null,
  counterpartLocationId = null, transferGroup = null,
  // Migracion 022. Van en el INSERT y no en un UPDATE posterior porque
  // `supply_movements` es solo-insercion por diseno: un renglon del kardex se
  // escribe una vez y ya. Sellarlos despues fallaria contra el disparador, y con
  // razon -- si el folio se pudiera pegar despues, tambien se podria cambiar.
  supplierId = null, receiptGroup = null, requestId = null }) {
  if (!MOVEMENT_KINDS.includes(kind)) throw new Error(`Unknown movement kind: ${kind}`);
  const delta = round3(quantity);
  if (delta === 0) return null;

  // El saldo de un insumo en un lugar donde nunca ha estado es cero, no un error:
  // la primera recepcion en la barra de arriba crea el renglon al pasar.
  const { rows } = await client.query(
    `INSERT INTO supply_stock (supply_id, location_id, stock)
     SELECT s.id, l.id, $3
       FROM supplies s JOIN supply_locations l ON l.nightclub_id = s.nightclub_id
      WHERE s.id = $1 AND l.id = $2 AND s.nightclub_id = $4
     ON CONFLICT (supply_id, location_id)
       DO UPDATE SET stock = supply_stock.stock + EXCLUDED.stock, updated_at = now()
     RETURNING stock::float8 AS stock`,
    [supplyId, locationId, delta, nightclubId],
  );
  if (rows.length === 0) throw ApiError.notFound('Insumo o lugar no encontrado');

  const { rows: mov } = await client.query(
    `INSERT INTO supply_movements (nightclub_id, supply_id, location_id, counterpart_location_id,
                                   transfer_group, kind, quantity, balance_after, unit_cost,
                                   reference_type, reference_id, reason, created_by, authorized_by,
                                   supplier_id, receipt_group, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id, balance_after::float8 AS balance_after, created_at`,
    [nightclubId, supplyId, locationId, counterpartLocationId, transferGroup, kind, delta,
      round3(rows[0].stock), unitCost, referenceType, referenceId, reason, userId, authorizedBy,
      supplierId, receiptGroup, requestId],
  );
  return mov[0];
}

/**
 * Bloquea (insumo, lugar) para escribir, en orden estable.
 *
 * El orden importa: dos pedidos que tocan los mismos dos insumos en orden distinto
 * se traban el uno al otro. Se ordena por id, que es arbitrario pero igual para
 * todos.
 */
async function lockStock(client, { supplyIds, locationId }) {
  const { rows } = await client.query(
    `SELECT supply_id, stock::float8 AS stock FROM supply_stock
      WHERE supply_id = ANY($1::uuid[]) AND location_id = $2
      ORDER BY supply_id FOR UPDATE`,
    [[...supplyIds].sort(), locationId],
  );
  return new Map(rows.map((r) => [r.supply_id, Number(r.stock)]));
}

/**
 * La receta de varios productos a la vez, con la existencia del insumo EN UNA BARRA.
 * Una sola consulta: pedirla producto por producto son N viajes a la base por cada
 * carta que se pinta.
 */
async function recipesFor(runner, { nightclubId, drinkIds, locationId = null }) {
  if (!drinkIds || drinkIds.length === 0) return new Map();
  const { rows } = await runner.query(
    `SELECT ds.drink_id, ds.supply_id, ds.quantity::float8 AS quantity,
            s.name, s.unit, s.package_size::float8 AS package_size,
            s.package_label, s.active,
            COALESCE(ss.stock, 0)::float8 AS stock
       FROM drink_supplies ds
       JOIN supplies s ON s.id = ds.supply_id
       LEFT JOIN supply_stock ss ON ss.supply_id = s.id AND ss.location_id = $3
      WHERE ds.drink_id = ANY($1::uuid[]) AND s.nightclub_id = $2
      ORDER BY s.name`,
    [drinkIds, nightclubId, locationId],
  );
  const byDrink = new Map();
  for (const row of rows) {
    if (!byDrink.has(row.drink_id)) byDrink.set(row.drink_id, []);
    byDrink.get(row.drink_id).push(row);
  }
  return byDrink;
}

/**
 * Cuantas unidades de un producto se pueden servir con lo que hay en esa barra.
 *
 * Es el minimo entre sus ingredientes: con 200 ml de whisky y refresco de sobra,
 * alcanza para seis tragos de 30 ml, no para los que diga el refresco.
 *
 * `null` = el producto no lleva receta y no se le controla existencia. Es distinto
 * de 0, que significa que se acabo.
 */
function servingsFor(recipe) {
  if (!recipe || recipe.length === 0) return null;
  let min = Infinity;
  for (const line of recipe) {
    if (!line.active) return 0;
    const qty = Number(line.quantity);
    if (!(qty > 0)) return 0;
    min = Math.min(min, Math.floor(Number(line.stock) / qty));
  }
  return Math.max(0, min === Infinity ? 0 : min);
}

/**
 * Suma lo que un pedido consume de cada insumo. Varios renglones del pedido pueden
 * tocar el mismo insumo -dos tragos del mismo whisky- y hay que bloquear y
 * descontar una sola vez, o el segundo descuento leeria un saldo viejo.
 */
function neededBySupply(items, recipes) {
  const needed = new Map();
  for (const item of items) {
    const recipe = recipes.get(item.drink_id);
    if (!recipe || recipe.length === 0) continue;
    for (const line of recipe) {
      const total = round3(Number(line.quantity) * item.quantity);
      const prev = needed.get(line.supply_id);
      if (prev) prev.quantity = round3(prev.quantity + total);
      else needed.set(line.supply_id, { supply: line, quantity: total });
    }
  }
  return needed;
}

/**
 * Descuenta de UNA barra lo que consume un pedido, dentro de la transaccion de
 * quien llama.
 *
 * Si algo no alcanza, el error nombra EL INSUMO, LA BARRA y lo que queda de verdad
 * ("quedan 130 ml de Buchanan's 12 en la barra de arriba"), no un "sin existencias"
 * que obliga al cantinero a adivinar cual de los cinco ingredientes falto ni de
 * donde tiene que traerlo.
 */
async function consume(client, { nightclubId, locationId, items, orderId, userId }) {
  const drinkIds = [...new Set(items.map((i) => i.drink_id))];
  const recipes = await recipesFor(client, { nightclubId, drinkIds, locationId });
  const needed = neededBySupply(items, recipes);
  if (needed.size === 0) return [];
  if (!locationId) throw ApiError.unprocessable('Este pedido no tiene barra asignada');

  const stock = await lockStock(client, { supplyIds: needed.keys(), locationId });

  const short = [];
  for (const [supplyId, want] of needed) {
    const have = stock.has(supplyId) ? round3(stock.get(supplyId)) : 0;
    if (!want.supply.active) {
      short.push({ supply_id: supplyId, name: want.supply.name, reason: 'unavailable' });
    } else if (have < want.quantity) {
      short.push({
        supply_id: supplyId,
        name: want.supply.name,
        reason: 'out_of_stock',
        needed: want.quantity,
        available: have,
        unit: want.supply.unit,
      });
    }
  }
  if (short.length > 0) {
    throw ApiError.conflict('No alcanza el inventario de la barra',
      { supplies: short, location_id: locationId });
  }

  const applied = [];
  for (const supplyId of [...needed.keys()].sort()) {
    const want = needed.get(supplyId);
    const mov = await move(client, {
      nightclubId, supplyId, locationId, kind: 'consumption', quantity: -want.quantity,
      referenceType: 'drink_order', referenceId: orderId, userId,
    });
    applied.push({ supply_id: supplyId, quantity: want.quantity, movement_id: mov.id });
  }
  return applied;
}

/**
 * Devuelve al inventario lo que un pedido cancelado habia consumido.
 *
 * Lee del kardex lo que de verdad salio por ese pedido -y de que barra salio- y lo
 * repone ahi mismo, en vez de volver a calcular la receta: si la receta cambio
 * entremedio, recalcular devolveria una cantidad que nunca se sirvio. Y descuenta
 * lo ya devuelto, para que cancelar dos veces no regale producto.
 */
async function restore(client, { nightclubId, orderId, userId, reason = null }) {
  const { rows } = await client.query(
    `SELECT supply_id, location_id,
            -sum(quantity) FILTER (WHERE kind = 'consumption')::float8 AS consumed,
            COALESCE(sum(quantity) FILTER (WHERE kind = 'return'), 0)::float8 AS returned
       FROM supply_movements
      WHERE nightclub_id = $1 AND reference_type = 'drink_order' AND reference_id = $2
      GROUP BY supply_id, location_id
      ORDER BY supply_id`,
    [nightclubId, orderId],
  );

  const restored = [];
  for (const row of rows) {
    const pending = round3(Number(row.consumed || 0) - Number(row.returned || 0));
    if (pending <= 0) continue;
    await lockStock(client, { supplyIds: [row.supply_id], locationId: row.location_id });
    await move(client, {
      nightclubId, supplyId: row.supply_id, locationId: row.location_id,
      kind: 'return', quantity: pending,
      referenceType: 'drink_order', referenceId: orderId, reason, userId,
    });
    restored.push({ supply_id: row.supply_id, location_id: row.location_id, quantity: pending });
  }
  return restored;
}

/**
 * Entrada de mercancia: sube la existencia de un lugar y recalcula el costo
 * promedio ponderado del insumo.
 *
 * El promedio se pondera por cantidad, no por numero de compras: veinte botellas a
 * $900 y una a $1,400 no dan un costo de $1,150. Se pondera contra la existencia
 * TOTAL del insumo (la de todos los lugares), porque el costo es del producto, no
 * del estante en el que este parado.
 */
async function receive(client, { nightclubId, supplyId, locationId, quantity, unitCost,
  referenceType = null, referenceId = null, reason = null, userId = null, authorizedBy = null,
  supplierId = null, receiptGroup = null }) {
  const qty = round3(quantity);
  if (!(qty > 0)) throw ApiError.unprocessable('La cantidad recibida tiene que ser mayor que cero');

  const { rows } = await client.query(
    `SELECT s.id, s.avg_cost::float8 AS avg_cost,
            COALESCE((SELECT sum(stock) FROM supply_stock WHERE supply_id = s.id), 0)::float8 AS total_stock
       FROM supplies s WHERE s.id = $1 AND s.nightclub_id = $2 FOR UPDATE OF s`,
    [supplyId, nightclubId],
  );
  if (rows.length === 0) throw ApiError.notFound('Insumo no encontrado');
  const before = rows[0];
  await lockStock(client, { supplyIds: [supplyId], locationId });

  const cost = unitCost === null || unitCost === undefined ? null : Number(unitCost);
  if (cost !== null) {
    const previous = Math.max(0, Number(before.total_stock));
    const next = previous > 0 && Number(before.avg_cost) > 0
      ? (previous * Number(before.avg_cost) + qty * cost) / (previous + qty)
      : cost;
    await client.query('UPDATE supplies SET avg_cost = $2, updated_at = now() WHERE id = $1',
      [supplyId, next.toFixed(6)]);
  }

  return move(client, {
    nightclubId, supplyId, locationId, kind: 'receipt', quantity: qty, unitCost: cost,
    referenceType, referenceId, reason, userId, authorizedBy, supplierId, receiptGroup,
  });
}

/**
 * Traspaso entre lugares: lo que sale del almacen entra en la barra, en la misma
 * transaccion y con el mismo folio.
 *
 * Los dos renglones comparten `transfer_group`, asi que el kardex puede contestar
 * "de donde salio esto" sin adivinar por la hora. Y se valida que haya de verdad:
 * un traspaso que deja el almacen en negativo es un traspaso que no ocurrio.
 */
async function transfer(client, { nightclubId, supplyId, fromLocationId, toLocationId,
  quantity, reason = null, userId = null, authorizedBy = null, requestId = null }) {
  const qty = round3(quantity);
  if (!(qty > 0)) throw ApiError.unprocessable('La cantidad del traspaso tiene que ser mayor que cero');
  if (fromLocationId === toLocationId) {
    throw ApiError.unprocessable('El origen y el destino del traspaso son el mismo lugar');
  }

  // Siempre en el mismo orden, para que dos traspasos cruzados no se traben.
  const [first, second] = [fromLocationId, toLocationId].sort();
  await client.query(
    `SELECT 1 FROM supply_stock WHERE supply_id = $1 AND location_id IN ($2,$3)
      ORDER BY location_id FOR UPDATE`,
    [supplyId, first, second],
  );

  const { rows } = await client.query(
    `SELECT COALESCE(stock, 0)::float8 AS stock FROM supply_stock
      WHERE supply_id = $1 AND location_id = $2`,
    [supplyId, fromLocationId],
  );
  const available = rows.length ? round3(rows[0].stock) : 0;
  if (available < qty) {
    const name = await client.query('SELECT name, unit FROM supplies WHERE id = $1', [supplyId]);
    throw ApiError.conflict('No hay suficiente en el origen del traspaso', {
      supply_id: supplyId,
      name: name.rows[0] ? name.rows[0].name : null,
      unit: name.rows[0] ? name.rows[0].unit : null,
      needed: qty,
      available,
    });
  }

  const group = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
  const out = await move(client, {
    nightclubId, supplyId, locationId: fromLocationId, kind: 'transfer_out', quantity: -qty,
    counterpartLocationId: toLocationId, transferGroup: group, reason, userId, authorizedBy,
    requestId,
  });
  const into = await move(client, {
    nightclubId, supplyId, locationId: toLocationId, kind: 'transfer_in', quantity: qty,
    counterpartLocationId: fromLocationId, transferGroup: group, reason, userId, authorizedBy,
    requestId,
  });
  return { transfer_group: group, out, in: into };
}

/**
 * Ajuste a mano: merma, cortesia, salida, correccion. Exige motivo: un saldo
 * corregido sin explicacion es indistinguible de un robo, y separar esas dos cosas
 * es justo para lo que sirve esta bitacora.
 *
 * Merma, cortesia y salida siempre restan, por mas que quien captura escriba el
 * numero en positivo: nadie "merma" producto hacia adentro, y aceptar el signo tal
 * cual seria dejar que un dedo equivocado suba el inventario.
 */
async function adjust(client, { nightclubId, supplyId, locationId, kind, quantity, reason,
  userId = null, authorizedBy = null }) {
  if (!MANUAL_KINDS.includes(kind) || kind === 'count') {
    throw ApiError.unprocessable('Ese tipo de movimiento no se captura a mano');
  }
  if (!reason || !String(reason).trim()) {
    throw ApiError.unprocessable('Escribe el motivo del movimiento');
  }
  const magnitude = Math.abs(round3(quantity));
  if (magnitude === 0) throw ApiError.unprocessable('La cantidad no puede ser cero');
  const delta = kind === 'adjustment' ? round3(quantity) : -magnitude;

  const stock = await lockStock(client, { supplyIds: [supplyId], locationId });
  const available = round3(stock.get(supplyId) || 0);
  if (delta < 0 && available < magnitude) {
    const name = await client.query('SELECT name, unit FROM supplies WHERE id = $1', [supplyId]);
    throw ApiError.conflict('No hay suficiente en ese lugar', {
      supply_id: supplyId,
      name: name.rows[0] ? name.rows[0].name : null,
      unit: name.rows[0] ? name.rows[0].unit : null,
      needed: magnitude,
      available,
    });
  }

  return move(client, {
    nightclubId, supplyId, locationId, kind, quantity: delta,
    reason: String(reason).trim(), userId, authorizedBy,
  });
}

/**
 * Conteo fisico: se captura lo que hay en el estante y el sistema calcula la
 * diferencia. Se guarda la DIFERENCIA, no el numero contado, para que el kardex
 * siga sumando a lo largo de la noche.
 */
async function count(client, { nightclubId, supplyId, locationId, counted, reason,
  userId = null, authorizedBy = null }) {
  const exists = await client.query(
    'SELECT 1 FROM supplies WHERE id = $1 AND nightclub_id = $2', [supplyId, nightclubId]);
  if (exists.rowCount === 0) throw ApiError.notFound('Insumo no encontrado');

  const stock = await lockStock(client, { supplyIds: [supplyId], locationId });
  const before = round3(stock.get(supplyId) || 0);
  const diff = round3(Number(counted) - before);
  if (diff === 0) return { movement: null, difference: 0, stock: before };
  const movement = await move(client, {
    nightclubId, supplyId, locationId, kind: 'count', quantity: diff,
    reason: (reason && String(reason).trim()) || 'Conteo fisico', userId, authorizedBy,
  });
  return { movement, difference: diff, stock: movement.balance_after };
}

/**
 * Que barra atiende a una mesa. El pedido de la mesa 39 baja de la barra que
 * atiende su zona, y si esa zona no tiene barra asignada, de la barra de su planta.
 *
 * Devuelve `null` cuando el club todavia no tiene barras: en ese caso el pedido no
 * descuenta nada y se dice, en vez de fingir que salio de algun lado.
 */
async function barForTable(runner, { nightclubId, tableId }) {
  const { rows } = await runner.query(
    `SELECT COALESCE(zb.location_id, byfloor.id) AS location_id
       FROM tables t
       LEFT JOIN zone_bars zb
              ON zb.nightclub_id = t.nightclub_id AND zb.section = t.section
       LEFT JOIN LATERAL (
         SELECT l.id FROM supply_locations l
          WHERE l.nightclub_id = t.nightclub_id AND l.kind = 'bar' AND l.active
            AND (l.floor = t.floor OR l.floor IS NULL)
          ORDER BY (l.floor = t.floor) DESC, l.sort_order, l.code
          LIMIT 1
       ) byfloor ON true
      WHERE t.id = $1 AND t.nightclub_id = $2`,
    [tableId, nightclubId],
  );
  return rows.length ? rows[0].location_id : null;
}

/** La barra por omision del club: la primera activa. Para venta en barra sin mesa. */
async function defaultBar(runner, { nightclubId }) {
  const { rows } = await runner.query(
    `SELECT id FROM supply_locations
      WHERE nightclub_id = $1 AND kind = 'bar' AND active
      ORDER BY sort_order, code LIMIT 1`,
    [nightclubId],
  );
  return rows.length ? rows[0].id : null;
}

module.exports = {
  UNITS,
  MOVEMENT_KINDS,
  MANUAL_KINDS,
  round3,
  move,
  lockStock,
  recipesFor,
  servingsFor,
  neededBySupply,
  consume,
  restore,
  receive,
  transfer,
  adjust,
  count,
  barForTable,
  defaultBar,
};
