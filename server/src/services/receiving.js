/**
 * Recibir mercancía en lote, y surtir una barra contra lo que pidió.
 *
 * `services/inventory.js` sabe mover UNA existencia. Esto de aquí sabe mover
 * VARIAS de golpe sin dejar el inventario a medias, que es un problema distinto y
 * el que de verdad aparece de noche:
 *
 *   - El camión llega con quince renglones. Capturarlos de uno en uno son quince
 *     oportunidades de que el noveno falle y queden ocho adentro y siete afuera —
 *     y nadie sabe cuáles ocho hasta que alguien cuenta el estante a mano.
 *   - El cantinero pide doce cosas. El almacén tiene ocho. Surtir ocho y callar las
 *     cuatro es cómo se pierde media noche esperando producto que nunca iba a
 *     llegar.
 *
 * Todo lo de aquí corre DENTRO de la transacción de quien llama, y toma un
 * `client`, nunca el pool. Un lote a medio aplicar no es un lote: es un inventario
 * que miente.
 *
 * ---------------------------------------------------------------------------
 * Las tres decisiones que importan
 * ---------------------------------------------------------------------------
 *
 * 1. **El lote entra completo o no entra.** Una línea mala aborta las demás, y el
 *    error dice QUÉ línea y por qué, con su número de renglón, para que quien
 *    captura la corrija en vez de volver a empezar.
 *
 * 2. **El costo es por línea.** Cada renglón mueve el costo promedio de SU insumo,
 *    ponderado por cantidad. Repartir un total entre las líneas daría un promedio
 *    que no corresponde a ningún precio real y volvería inútil el margen del trago.
 *
 * 3. **Surtir de menos es un resultado, no un error.** Si el almacén tiene ocho de
 *    los doce que se pidieron, se surten ocho, el pedido queda `partial`, y lo que
 *    faltó queda escrito. Un pedido que se niega entero porque falta un renglón
 *    deja a la barra sin los once que sí había.
 */
'use strict';

const { ApiError } = require('../middleware/errors');
const inventory = require('../services/inventory');

/** Cuántas líneas caben en una captura. Más que esto no es una entrega, es un error. */
const MAX_LINES = 100;

/**
 * Las cantidades de una línea, en la unidad base del insumo.
 *
 * Quien recibe cuenta cajas y botellas, no mililitros. Obligarlo a multiplicar de
 * cabeza es exactamente cómo se capturan entradas de 750 unidades en vez de 750 ml,
 * así que la conversión vive aquí, en un solo lugar, y la base solo ve la unidad
 * base.
 *
 * El costo viaja al revés: la factura dice lo que cuesta la PRESENTACIÓN completa
 * ($900 la botella), y el inventario necesita el costo de la unidad base. Se divide
 * entre `package_size` una sola vez, aquí.
 */
function lineAmounts(line, supply) {
  const packageSize = Number(supply.package_size);
  if (!(packageSize > 0)) {
    throw ApiError.unprocessable(`${supply.name} no tiene una presentación válida`);
  }
  const quantity = line.quantity !== undefined
    ? Number(line.quantity)
    : Number(line.packages) * packageSize;

  let unitCost = null;
  if (line.package_cost !== undefined && line.package_cost !== null) {
    unitCost = Number(line.package_cost) / packageSize;
  } else if (line.unit_cost !== undefined && line.unit_cost !== null) {
    unitCost = Number(line.unit_cost);
  }

  return { quantity: inventory.round3(quantity), unitCost, packageSize };
}

/**
 * Los insumos de un lote, en UNA consulta.
 *
 * Pedirlos de uno en uno son quince viajes a la base por cada entrega, y además
 * abre una ventana: entre el viaje tres y el trece alguien puede haber dado de baja
 * un insumo, y el lote entraría mitad contra un catálogo y mitad contra otro.
 */
async function loadSupplies(client, { nightclubId, supplyIds }) {
  const { rows } = await client.query(
    `SELECT id, name, unit, package_size::float8 AS package_size, package_label, active
       FROM supplies WHERE id = ANY($1::uuid[]) AND nightclub_id = $2`,
    [supplyIds, nightclubId],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Revisa las líneas antes de tocar una sola existencia.
 *
 * Se valida TODO primero y se aplica después, aunque parezca un paso de más: así el
 * error llega antes de que la mitad del lote esté escrito, y aunque la transacción
 * lo revertiría igual, el mensaje puede nombrar las tres líneas malas en vez de
 * morirse en la primera y hacer que quien captura descubra las otras dos de a una.
 */
function checkLines(lines, supplies, { requireCost = false } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw ApiError.unprocessable('La captura no tiene renglones');
  }
  if (lines.length > MAX_LINES) {
    throw ApiError.unprocessable(`Son demasiados renglones de una vez (máximo ${MAX_LINES})`);
  }

  const problems = [];
  const seen = new Map();

  lines.forEach((line, index) => {
    const row = index + 1;
    const supply = supplies.get(line.supply_id);
    if (!supply) {
      problems.push({ row, supply_id: line.supply_id, code: 'unknown_supply' });
      return;
    }
    if (!supply.active) {
      problems.push({ row, supply_id: line.supply_id, name: supply.name, code: 'inactive_supply' });
      return;
    }
    // Un insumo repetido en el mismo lote casi nunca es intencional: es el mismo
    // renglón capturado dos veces, y aceptarlo duplica la entrada en silencio. Si
    // de verdad llegaron dos cajas del mismo whisky, van en un solo renglón.
    if (seen.has(line.supply_id)) {
      problems.push({
        row, supply_id: line.supply_id, name: supply.name,
        code: 'duplicate_supply', first_row: seen.get(line.supply_id),
      });
      return;
    }
    seen.set(line.supply_id, row);

    const { quantity, unitCost } = lineAmounts(line, supply);
    if (!(quantity > 0)) {
      problems.push({ row, supply_id: line.supply_id, name: supply.name, code: 'bad_quantity' });
      return;
    }
    if (requireCost && (unitCost === null || !(unitCost >= 0))) {
      problems.push({ row, supply_id: line.supply_id, name: supply.name, code: 'missing_cost' });
    }
  });

  if (problems.length > 0) {
    throw ApiError.unprocessable('Hay renglones que no se pueden capturar', { lines: problems });
  }
}

// ============================================================================
// Entrada de mercancía en lote
// ============================================================================

/**
 * Mete todas las líneas de una entrega al lugar indicado, con un solo folio.
 *
 * El folio (`receipt_group`) es lo que después deja ver la entrega completa en vez
 * de quince movimientos suel­tos ordenados por hora, y es también el gancho por el
 * que un día se le puede colgar un comprobante con total sin mover nada de esto.
 *
 * `supplierId` es opcional a propósito: una entrada de un proveedor que todavía no
 * está en el catálogo no se puede quedar sin capturar por eso. Pero si viene, se
 * guarda en cada renglón y se actualiza lo que ese proveedor cobró por ese insumo —
 * que es distinto del costo promedio: el promedio valúa el inventario, esto avisa
 * que subió el precio.
 */
async function receiveBatch(client, { nightclubId, locationId, supplierId = null, lines,
  reason = null, referenceType = null, userId = null }) {
  const supplyIds = [...new Set(lines.map((l) => l.supply_id))];
  const supplies = await loadSupplies(client, { nightclubId, supplyIds });
  checkLines(lines, supplies);

  if (supplierId) {
    const { rows } = await client.query(
      'SELECT id FROM suppliers WHERE id = $1 AND nightclub_id = $2 AND active',
      [supplierId, nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Proveedor no encontrado');
  }

  const group = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
  const applied = [];

  // En orden de id y no en el orden capturado: dos entregas simultáneas que toquen
  // los mismos insumos en orden distinto se trabarían la una a la otra.
  const ordered = [...lines].sort((a, b) => String(a.supply_id).localeCompare(String(b.supply_id)));

  for (const line of ordered) {
    const supply = supplies.get(line.supply_id);
    const { quantity, unitCost, packageSize } = lineAmounts(line, supply);

    const movement = await inventory.receive(client, {
      nightclubId,
      supplyId: line.supply_id,
      locationId,
      quantity,
      unitCost,
      referenceType,
      reason: line.reason || reason || null,
      userId,
      // El folio y el proveedor viajan al INSERT, no a un UPDATE posterior:
      // `supply_movements` es solo-inserción por diseño y el disparador rechaza
      // cualquier UPDATE. Es la restricción correcta — un folio que se puede pegar
      // después es un folio que se puede cambiar después.
      supplierId,
      receiptGroup: group,
    });

    if (supplierId) {
      await client.query(
        `INSERT INTO supply_suppliers (supply_id, supplier_id, last_cost, last_bought_at)
         VALUES ($1,$2,$3,now())
         ON CONFLICT (supply_id, supplier_id) DO UPDATE
           SET last_cost = COALESCE(EXCLUDED.last_cost, supply_suppliers.last_cost),
               last_bought_at = now()`,
        [line.supply_id, supplierId,
          unitCost === null ? null : (unitCost * packageSize).toFixed(4)]);
    }

    applied.push({
      supply_id: line.supply_id,
      name: supply.name,
      unit: supply.unit,
      quantity,
      packages: inventory.round3(quantity / packageSize),
      unit_cost: unitCost,
      line_total: unitCost === null ? null : Number((unitCost * quantity).toFixed(2)),
      balance_after: movement.balance_after,
      movement_id: movement.id,
    });
  }

  const total = applied.reduce((sum, l) => sum + (l.line_total || 0), 0);
  return {
    receipt_group: group,
    location_id: locationId,
    supplier_id: supplierId,
    lines: applied,
    // Suma de lo capturado, no un total de factura: solo cuadra con el papel si
    // todas las líneas traían costo. La pantalla lo dice.
    total: Number(total.toFixed(2)),
    total_is_complete: applied.every((l) => l.line_total !== null),
  };
}

// ============================================================================
// Pedidos de barra
// ============================================================================

/** Los estados desde los que un pedido todavía se puede surtir. */
const OPEN_STATUSES = ['open', 'partial'];

/**
 * El pedido con sus renglones, bloqueado para escribir.
 *
 * `FOR UPDATE OF r` y no a secas: la consulta trae un `LEFT JOIN` y Postgres se
 * niega a bloquear el lado nulo de uno (error `0A000`). Es la tercera trampa de
 * `CLAUDE.md`, y ya nos costó tiempo una vez.
 */
async function loadRequest(client, { nightclubId, requestId, lock = false }) {
  const { rows } = await client.query(
    `SELECT r.id, r.nightclub_id, r.location_id, r.status, r.note,
            r.requested_by, r.fulfilled_by, r.created_at, r.fulfilled_at
       FROM bar_requests r
      WHERE r.id = $1 AND r.nightclub_id = $2
      ${lock ? 'FOR UPDATE OF r' : ''}`,
    [requestId, nightclubId],
  );
  if (rows.length === 0) throw ApiError.notFound('Pedido no encontrado');

  const { rows: lines } = await client.query(
    `SELECT bl.id, bl.supply_id, bl.quantity::float8 AS quantity,
            bl.fulfilled::float8 AS fulfilled,
            s.name, s.unit, s.package_size::float8 AS package_size, s.package_label
       FROM bar_request_lines bl
       JOIN supplies s ON s.id = bl.supply_id
      WHERE bl.request_id = $1
      ORDER BY s.name`,
    [requestId],
  );
  return { ...rows[0], lines };
}

/**
 * Crea el pedido de una barra.
 *
 * Quien pide es la barra, no el almacén: el que sabe qué falta es el cantinero
 * mirando su estante a las once de la noche. Y no se valida que haya existencia en
 * el almacén al pedir — pedir algo que no hay es información valiosa: es lo que hay
 * que comprar.
 */
async function createRequest(client, { nightclubId, locationId, lines, note = null, userId }) {
  const supplyIds = [...new Set(lines.map((l) => l.supply_id))];
  const supplies = await loadSupplies(client, { nightclubId, supplyIds });
  checkLines(lines, supplies);

  const { rows } = await client.query(
    `INSERT INTO bar_requests (nightclub_id, location_id, note, requested_by)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [nightclubId, locationId, note, userId],
  );
  const requestId = rows[0].id;

  for (const line of lines) {
    const supply = supplies.get(line.supply_id);
    const { quantity } = lineAmounts(line, supply);
    await client.query(
      'INSERT INTO bar_request_lines (request_id, supply_id, quantity) VALUES ($1,$2,$3)',
      [requestId, line.supply_id, quantity]);
  }

  return loadRequest(client, { nightclubId, requestId });
}

/**
 * Surte un pedido desde el almacén.
 *
 * Lo que se surte de cada renglón se puede recortar: `lines` trae lo que el
 * almacenista de verdad va a mandar, y lo que no venga se toma como que no se surte
 * esta vez. Si no viene `lines`, se intenta surtir todo lo que falta.
 *
 * Surtir de menos de lo que hay NO es un error: se manda lo que haya, el pedido
 * queda `partial` y el faltante queda escrito. Negar el pedido entero porque falta
 * un renglón deja a la barra sin los once que sí había, que es peor para la noche y
 * peor para el control (el cantinero acaba yendo a tomarlo del almacén sin que
 * quede registro).
 */
async function fulfillRequest(client, { nightclubId, requestId, fromLocationId, lines = null,
  userId }) {
  const request = await loadRequest(client, { nightclubId, requestId, lock: true });
  if (!OPEN_STATUSES.includes(request.status)) {
    throw ApiError.conflict(
      request.status === 'cancelled'
        ? 'Ese pedido está cancelado'
        : 'Ese pedido ya se surtió completo',
      { status: request.status });
  }
  if (fromLocationId === request.location_id) {
    throw ApiError.unprocessable('Una barra no se surte a sí misma');
  }

  const porInsumo = new Map(request.lines.map((l) => [l.supply_id, l]));
  const pedido = [];

  if (lines === null) {
    for (const line of request.lines) {
      const pendiente = inventory.round3(line.quantity - line.fulfilled);
      if (pendiente > 0) pedido.push({ line, quantity: pendiente });
    }
  } else {
    const problems = [];
    lines.forEach((entrada, index) => {
      const line = porInsumo.get(entrada.supply_id);
      if (!line) {
        problems.push({ row: index + 1, supply_id: entrada.supply_id, code: 'not_in_request' });
        return;
      }
      const { quantity } = lineAmounts(entrada, line);
      if (!(quantity > 0)) {
        problems.push({ row: index + 1, supply_id: entrada.supply_id, name: line.name,
          code: 'bad_quantity' });
        return;
      }
      const pendiente = inventory.round3(line.quantity - line.fulfilled);
      if (quantity > pendiente) {
        // Surtir MÁS de lo pedido sí se niega: si la barra necesita más, lo pide
        // otra vez. Dejar que el almacén empuje producto de más por encima del
        // pedido es justo lo que este flujo vino a quitar.
        problems.push({
          row: index + 1, supply_id: entrada.supply_id, name: line.name,
          code: 'over_request', requested: line.quantity, already: line.fulfilled,
          pending: pendiente,
        });
        return;
      }
      pedido.push({ line, quantity });
    });
    if (problems.length > 0) {
      throw ApiError.unprocessable('Hay renglones que no se pueden surtir', { lines: problems });
    }
  }

  if (pedido.length === 0) throw ApiError.unprocessable('No queda nada por surtir en ese pedido');

  // Lo que de verdad hay en el almacén, ahora. Se lee una vez, ya con las filas
  // bloqueadas por `inventory.transfer` más abajo.
  const { rows: existencias } = await client.query(
    `SELECT supply_id, stock::float8 AS stock FROM supply_stock
      WHERE supply_id = ANY($1::uuid[]) AND location_id = $2
      ORDER BY supply_id FOR UPDATE`,
    [pedido.map((p) => p.line.supply_id).sort(), fromLocationId],
  );
  const hay = new Map(existencias.map((r) => [r.supply_id, Number(r.stock)]));

  const surtido = [];
  const faltante = [];

  for (const { line, quantity } of pedido.sort(
    (a, b) => String(a.line.supply_id).localeCompare(String(b.line.supply_id)))) {
    const disponible = inventory.round3(hay.get(line.supply_id) || 0);
    const manda = Math.min(quantity, disponible);

    if (manda <= 0) {
      faltante.push({
        supply_id: line.supply_id, name: line.name, unit: line.unit,
        requested: quantity, sent: 0, available: disponible,
      });
      continue;
    }

    const result = await inventory.transfer(client, {
      nightclubId,
      supplyId: line.supply_id,
      fromLocationId,
      toLocationId: request.location_id,
      quantity: manda,
      reason: null,
      userId,
      // Los dos renglones del traspaso quedan ligados al pedido desde el INSERT, así
      // que el kardex puede contestar "esto bajó porque la barra lo pidió" en vez de
      // dejar un traspaso sin causa.
      requestId,
    });

    await client.query(
      'UPDATE bar_request_lines SET fulfilled = fulfilled + $2 WHERE id = $1',
      [line.id, manda]);

    surtido.push({
      supply_id: line.supply_id, name: line.name, unit: line.unit,
      requested: quantity, sent: manda,
      transfer_group: result.transfer_group,
    });
    if (manda < quantity) {
      faltante.push({
        supply_id: line.supply_id, name: line.name, unit: line.unit,
        requested: quantity, sent: manda, available: disponible,
      });
    }
  }

  // El estado se deduce de los renglones, no de lo que se acaba de mandar: un
  // pedido puede llevar dos surtidos parciales y solo el segundo lo completa.
  const { rows: resumen } = await client.query(
    `SELECT bool_and(fulfilled >= quantity) AS completo
       FROM bar_request_lines WHERE request_id = $1`,
    [requestId]);
  const completo = resumen[0].completo === true;

  // `$2::text` en las DOS apariciones, no por adorno: el mismo parámetro usado como
  // valor de una columna `varchar` y en una comparación con un literal hace que
  // Postgres deduzca dos tipos y se niegue con `42P08`. Es la primera trampa de
  // CLAUDE.md, y ya nos costó tiempo dos veces.
  await client.query(
    `UPDATE bar_requests
        SET status = $2::text,
            fulfilled_by = $3,
            fulfilled_at = CASE WHEN $2::text = 'fulfilled' THEN now() ELSE fulfilled_at END
      WHERE id = $1`,
    [requestId, completo ? 'fulfilled' : 'partial', userId]);

  return {
    request: await loadRequest(client, { nightclubId, requestId }),
    sent: surtido,
    short: faltante,
    from_location_id: fromLocationId,
  };
}

/** Cancelar. Exige motivo: un pedido que desaparece sin explicación es un pedido perdido. */
async function cancelRequest(client, { nightclubId, requestId, reason, userId }) {
  const request = await loadRequest(client, { nightclubId, requestId, lock: true });
  if (request.status === 'cancelled') throw ApiError.conflict('Ese pedido ya está cancelado');
  if (request.status === 'fulfilled') throw ApiError.conflict('Ese pedido ya se surtió');
  if (!reason || !String(reason).trim()) {
    throw ApiError.unprocessable('Escribe por qué se cancela el pedido');
  }

  await client.query(
    `UPDATE bar_requests
        SET status = 'cancelled', cancel_reason = $2, cancelled_by = $3, cancelled_at = now()
      WHERE id = $1`,
    [requestId, String(reason).trim().slice(0, 200), userId]);

  // Lo ya surtido antes de cancelar NO se devuelve: esa mercancía está físicamente
  // en la barra. Devolverla en la base dejaría el saldo del almacén diciendo que
  // tiene botellas que están arriba.
  return loadRequest(client, { nightclubId, requestId });
}

/**
 * Lo que una barra debería pedir: sus insumos bajo el mínimo, con lo que hay en el
 * almacén al lado.
 *
 * Es lo que hace que pedir sea de un toque en vez de buscar quince insumos entre
 * doscientos a las once de la noche. Solo mira insumos con mínimo capturado: sin
 * mínimo no hay forma de saber qué es "poco".
 */
async function suggestForBar(runner, { nightclubId, locationId }) {
  const { rows } = await runner.query(
    `SELECT s.id AS supply_id, s.name, s.unit,
            s.package_size::float8 AS package_size, s.package_label,
            ss.stock::float8 AS stock, ss.min_stock::float8 AS min_stock,
            GREATEST(ss.min_stock - ss.stock, 0)::float8 AS missing,
            COALESCE(w.stock, 0)::float8 AS warehouse_stock
       FROM supply_stock ss
       JOIN supplies s ON s.id = ss.supply_id
       LEFT JOIN LATERAL (
         SELECT sum(ws.stock) AS stock
           FROM supply_stock ws
           JOIN supply_locations wl ON wl.id = ws.location_id
          WHERE ws.supply_id = s.id AND wl.kind = 'warehouse' AND wl.active
       ) w ON true
      WHERE ss.location_id = $2 AND s.nightclub_id = $1 AND s.active
        AND ss.min_stock > 0 AND ss.stock <= ss.min_stock
      ORDER BY (ss.stock / NULLIF(ss.min_stock, 0)), s.name`,
    [nightclubId, locationId],
  );

  return rows.map((r) => ({
    ...r,
    // Lo que falta, redondeado HACIA ARRIBA en presentaciones: nadie manda media
    // botella del almacén a la barra.
    suggested_packages: Math.ceil(r.missing / r.package_size),
    // Y si el almacén no tiene, hay que comprarlo, no traspasarlo. Decirlo aquí
    // evita el pedido que nace muerto.
    warehouse_has_enough: Number(r.warehouse_stock) >= Number(r.missing),
  }));
}

module.exports = {
  MAX_LINES,
  OPEN_STATUSES,
  lineAmounts,
  checkLines,
  loadSupplies,
  receiveBatch,
  loadRequest,
  createRequest,
  fulfillRequest,
  cancelRequest,
  suggestForBar,
};
