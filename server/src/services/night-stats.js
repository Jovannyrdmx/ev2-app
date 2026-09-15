/**
 * Cómo salió una noche.
 *
 * El tablero que ya existía es de AHORA MISMO: mesas ocupadas, pedidos en curso,
 * ingreso del día. Se borra al día siguiente. Esto es lo otro: el corte de una
 * noche concreta, con lo que de verdad se pregunta al día siguiente — cuántas
 * mesas se apartaron y cuántas llegaron, qué zona se llenó y cuál se quedó vacía,
 * cuánto se vendió en cada barra, y cuánto producto se fue sin venderse.
 *
 * ---------------------------------------------------------------------------
 * De dónde sale la venta
 * ---------------------------------------------------------------------------
 * De **nuestro POS**. El plan original sincronizaba con SoftRestaurant11 y el
 * dueño decidió no hacer esa integración por ahora, así que `drink_orders` y
 * `transactions` son la fuente completa y no una parte. Eso quiere decir que el
 * total del corte es el total real del club, y la pantalla no tiene que advertir
 * de nada. El día que se conecte un POS externo, esto tendrá que decir de dónde
 * viene cada peso.
 *
 * ---------------------------------------------------------------------------
 * Las tres decisiones que importan
 * ---------------------------------------------------------------------------
 *
 * 1. **Cancelado no es vendido, y no-show no es ocupado.** Una reservación
 *    cancelada no cuenta como mesa usada aunque exista la fila; un pedido
 *    cancelado no cuenta como venta aunque tenga subtotal. Confundirlos infla la
 *    noche y vuelve inútil la comparación entre dos viernes, que es para lo que
 *    existe todo esto.
 *
 * 2. **Cada bloque es su propia consulta.** Un `JOIN` de todo contra todo
 *    multiplica filas —una reservación con tres pedidos contaría la reservación
 *    tres veces— y ese error no revienta: solo da un número más grande. Así que
 *    van por separado y se juntan en JavaScript.
 *
 * 3. **Una noche sin actividad da ceros, no `null`.** El corte de un martes
 *    muerto es un dato válido; `null` obligaría a cada pantalla a decidir qué
 *    hacer, y alguna decidiría mal.
 */
'use strict';

const { pool } = require('../db/pool');
const { ApiError } = require('../middleware/errors');

/** Redondeo a centavos. El dinero del corte se compara, así que no puede flotar. */
const money = (n) => Math.round(Number(n || 0) * 100) / 100;
const int = (n) => Number(n || 0);

/**
 * La noche, con su ventana de tiempo.
 *
 * La ventana va de que abren puertas a que cierra, y cuando no hay hora de cierre
 * se toman 12 horas. Es lo que hace que un pedido de las 3 de la mañana cuente en
 * la noche del viernes y no en la del sábado — que es como lo cuenta el club, y
 * cualquier otra cosa parte la noche a la mitad.
 */
async function loadNight({ nightclubId, eventId, runner = pool }) {
  const { rows } = await runner.query(
    `SELECT id, name, event_date, doors_open_at, closes_at, ticket_price, currency, status
       FROM events_calendar WHERE id = $1 AND nightclub_id = $2`,
    [eventId, nightclubId],
  );
  if (rows.length === 0) throw ApiError.notFound('Esa noche no existe');
  const night = rows[0];
  const from = new Date(night.doors_open_at);
  const to = night.closes_at
    ? new Date(night.closes_at)
    : new Date(from.getTime() + 12 * 3_600_000);
  return { night, from, to };
}

/**
 * Reservaciones: apartadas, llegadas, no-show, y el dinero comprometido.
 *
 * `seated` y `completed` son las que llegaron. `no_show` es la que se apartó y no
 * llegó — y es el número que de verdad duele, porque esa mesa no se vendió dos
 * veces. `confirmed` y `pending_payment` que ya pasaron su hora sin sentarse no se
 * cuentan como llegadas ni como no-show: la puerta las marca, y si nadie las marcó
 * quedan como apartadas y punto. Inventar el estado aquí sería inventar quién
 * llegó al club.
 */
async function reservations({ nightclubId, eventId, runner = pool }) {
  const { rows } = await runner.query(
    `SELECT count(*)::int AS booked,
            count(*) FILTER (WHERE status IN ('seated','completed'))::int AS arrived,
            count(*) FILTER (WHERE status = 'no_show')::int             AS no_show,
            count(*) FILTER (WHERE status = 'cancelled')::int           AS cancelled,
            COALESCE(sum(guest_count) FILTER (WHERE status IN ('seated','completed')), 0)::int
              AS guests_arrived,
            COALESCE(sum(total_estimated) FILTER (WHERE status IN ('seated','completed')), 0)::float8
              AS revenue,
            COALESCE(sum(deposit_amount) FILTER (WHERE status <> 'cancelled'), 0)::float8
              AS deposits,
            COALESCE(sum(refund_amount) FILTER (WHERE status = 'cancelled'), 0)::float8
              AS refunds
       FROM reservations
      WHERE nightclub_id = $1 AND event_id = $2`,
    [nightclubId, eventId],
  );
  const r = rows[0];
  return {
    booked: int(r.booked),
    arrived: int(r.arrived),
    no_show: int(r.no_show),
    cancelled: int(r.cancelled),
    guests_arrived: int(r.guests_arrived),
    revenue: money(r.revenue),
    deposits: money(r.deposits),
    refunds: money(r.refunds),
  };
}

/**
 * Las zonas: cuántas mesas hay, cuántas se usaron, y cuánto dejó cada una.
 *
 * Se cuenta sobre `tables`, no sobre las reservaciones, para que una zona que no
 * vendió nada APAREZCA con cero. Una zona vacía que no sale en el reporte es una
 * zona de la que nadie se acuerda de preguntar, y son justo las que hay que
 * repensar.
 */
async function zones({ nightclubId, eventId, runner = pool }) {
  const { rows } = await runner.query(
    `SELECT t.section,
            count(DISTINCT t.id)::int AS tables_total,
            count(DISTINCT r.table_id) FILTER (
              WHERE r.status IN ('seated','completed'))::int AS tables_used,
            COALESCE(sum(r.guest_count) FILTER (
              WHERE r.status IN ('seated','completed')), 0)::int AS guests,
            COALESCE(sum(r.total_estimated) FILTER (
              WHERE r.status IN ('seated','completed')), 0)::float8 AS revenue,
            count(r.id) FILTER (WHERE r.status = 'no_show')::int AS no_show
       FROM tables t
       LEFT JOIN reservations r
              ON r.table_id = t.id AND r.event_id = $2 AND r.nightclub_id = t.nightclub_id
      WHERE t.nightclub_id = $1 AND t.active
      GROUP BY t.section
      ORDER BY t.section`,
    [nightclubId, eventId],
  );
  return rows.map((z) => ({
    section: z.section,
    tables_total: int(z.tables_total),
    tables_used: int(z.tables_used),
    guests: int(z.guests),
    revenue: money(z.revenue),
    no_show: int(z.no_show),
    // El porcentaje se calcula aquí y no en la pantalla: es la cifra por la que
    // el gerente decide subir o bajar el precio de una zona, y calcularla en dos
    // lugares es tenerla distinta en dos lugares.
    occupancy: int(z.tables_total) > 0
      ? Math.round((int(z.tables_used) / int(z.tables_total)) * 100) : 0,
  }));
}

/**
 * La barra: pedidos entregados, su importe, y el desglose por categoría y por
 * barra.
 *
 * Solo los `delivered`: un pedido cancelado no es venta, y uno que se quedó en
 * preparación cuando cerraron tampoco. Contarlos como venta es lo que hace que el
 * corte no cuadre con la caja, y entonces nadie vuelve a creerle al corte.
 */
async function bar({ nightclubId, from, to, runner = pool }) {
  const totales = await runner.query(
    `SELECT count(*)::int AS orders,
            COALESCE(sum(subtotal), 0)::float8 AS revenue,
            count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
            COALESCE(sum(subtotal) FILTER (WHERE status = 'cancelled'), 0)::float8 AS cancelled_value
       FROM drink_orders
      WHERE nightclub_id = $1 AND created_at >= $2 AND created_at < $3
        AND status = 'delivered'`,
    [nightclubId, from, to],
  );
  const cancelados = await runner.query(
    `SELECT count(*)::int AS cancelled,
            COALESCE(sum(subtotal), 0)::float8 AS value
       FROM drink_orders
      WHERE nightclub_id = $1 AND created_at >= $2 AND created_at < $3
        AND status = 'cancelled'`,
    [nightclubId, from, to],
  );

  const porCategoria = await runner.query(
    `SELECT COALESCE(d.category, 'Sin categoría') AS category,
            COALESCE(sum(i.quantity), 0)::int AS units,
            COALESCE(sum(i.quantity * i.unit_price), 0)::float8 AS revenue
       FROM drink_order_items i
       JOIN drink_orders o ON o.id = i.order_id
       JOIN drinks d ON d.id = i.drink_id
      WHERE o.nightclub_id = $1 AND o.created_at >= $2 AND o.created_at < $3
        AND o.status = 'delivered'
      GROUP BY COALESCE(d.category, 'Sin categoría')
      ORDER BY revenue DESC`,
    [nightclubId, from, to],
  );

  // Por barra: de qué estante salió el producto. Sale del kardex y no del pedido,
  // porque el pedido dice a qué mesa fue y el kardex dice de dónde bajó — que es
  // la pregunta cuando una barra vende el doble que la otra.
  const porBarra = await runner.query(
    `SELECT l.id AS location_id, l.name,
            count(DISTINCT m.reference_id)::int AS orders,
            COALESCE(sum(-m.quantity * s.avg_cost), 0)::float8 AS cost
       FROM supply_movements m
       JOIN supply_locations l ON l.id = m.location_id
       JOIN supplies s ON s.id = m.supply_id
      WHERE m.nightclub_id = $1 AND m.created_at >= $2 AND m.created_at < $3
        AND m.kind = 'consumption' AND l.kind = 'bar'
      GROUP BY l.id, l.name
      ORDER BY l.name`,
    [nightclubId, from, to],
  );

  return {
    orders: int(totales.rows[0].orders),
    revenue: money(totales.rows[0].revenue),
    cancelled: int(cancelados.rows[0].cancelled),
    cancelled_value: money(cancelados.rows[0].value),
    by_category: porCategoria.rows.map((c) => ({
      category: c.category, units: int(c.units), revenue: money(c.revenue),
    })),
    by_bar: porBarra.rows.map((b) => ({
      location_id: b.location_id, name: b.name, orders: int(b.orders), cost: money(b.cost),
    })),
  };
}

/** La puerta: cover general, extras de mesa, y cuánta gente entró pagando. */
async function door({ nightclubId, eventId, runner = pool }) {
  const { rows } = await runner.query(
    `SELECT COALESCE(sum(quantity), 0)::int AS people,
            COALESCE(sum(total), 0)::float8 AS revenue,
            COALESCE(sum(quantity) FILTER (WHERE kind = 'general'), 0)::int AS general,
            COALESCE(sum(total) FILTER (WHERE kind = 'general'), 0)::float8 AS general_revenue,
            COALESCE(sum(quantity) FILTER (WHERE kind = 'vip_extra'), 0)::int AS extras,
            COALESCE(sum(total) FILTER (WHERE kind = 'vip_extra'), 0)::float8 AS extras_revenue
       FROM door_admissions
      WHERE nightclub_id = $1 AND event_id = $2`,
    [nightclubId, eventId],
  );
  const d = rows[0];
  return {
    people: int(d.people),
    revenue: money(d.revenue),
    general: int(d.general),
    general_revenue: money(d.general_revenue),
    extras: int(d.extras),
    extras_revenue: money(d.extras_revenue),
  };
}

/**
 * Propinas de la noche, y a quién le tocaron.
 *
 * Van en el corte pero NO en el ingreso del club: son de la persona. Sumarlas al
 * total del club infla la noche con dinero que nunca fue del club, y es el error
 * más fácil de cometer en un reporte como este.
 */
async function tips({ nightclubId, from, to, runner = pool }) {
  const total = await runner.query(
    `SELECT COALESCE(sum(amount), 0)::float8 AS total, count(*)::int AS count
       FROM tips WHERE nightclub_id = $1 AND created_at >= $2 AND created_at < $3`,
    [nightclubId, from, to],
  );
  const porPersona = await runner.query(
    `SELECT t.to_user_id AS user_id, u.display_name, u.role,
            COALESCE(sum(t.amount), 0)::float8 AS total, count(*)::int AS count
       FROM tips t JOIN users u ON u.id = t.to_user_id
      WHERE t.nightclub_id = $1 AND t.created_at >= $2 AND t.created_at < $3
      GROUP BY t.to_user_id, u.display_name, u.role
      ORDER BY total DESC`,
    [nightclubId, from, to],
  );
  return {
    total: money(total.rows[0].total),
    count: int(total.rows[0].count),
    by_person: porPersona.rows.map((p) => ({
      user_id: p.user_id, display_name: p.display_name, role: p.role,
      total: money(p.total), count: int(p.count),
    })),
  };
}

/**
 * Lo que se fue sin venderse: la merma de la noche, valuada al costo.
 *
 * Sale de los movimientos `count` negativos (lo que el conteo físico reveló que
 * faltaba) más la merma capturada a mano. Al COSTO y nunca al precio de venta:
 * valuar una botella rota a precio de trago convierte una pérdida de $900 en una
 * de $6,000 y hace imposible tomarse el número en serio.
 */
async function shrinkage({ nightclubId, from, to, runner = pool }) {
  const { rows } = await runner.query(
    `SELECT COALESCE(sum(-m.quantity * s.avg_cost) FILTER (
              WHERE m.kind = 'count' AND m.quantity < 0), 0)::float8 AS counted,
            COALESCE(sum(-m.quantity * s.avg_cost) FILTER (
              WHERE m.kind = 'waste'), 0)::float8 AS waste,
            COALESCE(sum(-m.quantity * s.avg_cost) FILTER (
              WHERE m.kind = 'courtesy'), 0)::float8 AS courtesy
       FROM supply_movements m JOIN supplies s ON s.id = m.supply_id
      WHERE m.nightclub_id = $1 AND m.created_at >= $2 AND m.created_at < $3`,
    [nightclubId, from, to],
  );
  const s = rows[0];
  return {
    // Solo el faltante del conteo y la merma cuentan como pérdida. La cortesía se
    // reporta aparte: salió del inventario igual, pero el club la autorizó, y
    // mezclarlas hace que una promoción parezca un robo.
    value: money(Number(s.counted) + Number(s.waste)),
    counted: money(s.counted),
    waste: money(s.waste),
    courtesy: money(s.courtesy),
  };
}

/** Quién estuvo: asignados por el gerente, y quién de verdad marcó entrada. */
async function staff({ nightclubId, eventId, from, to, runner = pool }) {
  const { rows } = await runner.query(
    `SELECT a.user_id, u.display_name, a.role,
            array_remove(array_agg(DISTINCT a.section), NULL)     AS sections,
            array_remove(array_agg(DISTINCT l.name), NULL)        AS bars,
            EXISTS (
              SELECT 1 FROM staff_shifts s
               WHERE s.user_id = a.user_id
                 AND s.started_at < $4 AND COALESCE(s.ended_at, now()) > $3
            ) AS showed_up
       FROM shift_assignments a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN supply_locations l ON l.id = a.location_id
      WHERE a.nightclub_id = $1 AND a.event_id = $2
      GROUP BY a.user_id, u.display_name, a.role
      ORDER BY a.role, u.display_name`,
    [nightclubId, eventId, from, to],
  );
  return {
    assigned: rows.length,
    // Asignado y presente son dos cosas distintas, y esta es la única lista que
    // lo dice: quien quedó en el rol y no marcó entrada no llegó.
    showed_up: rows.filter((r) => r.showed_up).length,
    people: rows.map((r) => ({
      user_id: r.user_id,
      display_name: r.display_name,
      role: r.role,
      sections: r.sections || [],
      bars: r.bars || [],
      showed_up: r.showed_up === true,
    })),
  };
}

/**
 * El corte completo de una noche, calculado ahora.
 *
 * Los bloques se piden en paralelo porque no dependen entre sí, y cada uno es una
 * consulta propia a propósito: un `JOIN` de reservaciones con pedidos multiplica
 * filas y ese error no revienta, solo da un número más grande.
 */
async function nightStats({ nightclubId, eventId, runner = pool }) {
  const { night, from, to } = await loadNight({ nightclubId, eventId, runner });

  const [res, zonas, barra, puerta, propinas, merma, personal] = await Promise.all([
    reservations({ nightclubId, eventId, runner }),
    zones({ nightclubId, eventId, runner }),
    bar({ nightclubId, from, to, runner }),
    door({ nightclubId, eventId, runner }),
    tips({ nightclubId, from, to, runner }),
    shrinkage({ nightclubId, from, to, runner }),
    staff({ nightclubId, eventId, from, to, runner }),
  ]);

  const tablesTotal = zonas.reduce((n, z) => n + z.tables_total, 0);
  const tablesUsed = zonas.reduce((n, z) => n + z.tables_used, 0);

  // El ingreso del CLUB: mesas + barra + puerta. Las propinas NO entran: son de
  // la persona, y sumarlas infla la noche con dinero que nunca fue del club.
  const revenueTotal = money(res.revenue + barra.revenue + puerta.revenue);

  return {
    event: {
      id: night.id,
      name: night.name,
      event_date: night.event_date,
      doors_open_at: night.doors_open_at,
      closes_at: night.closes_at,
      status: night.status,
      ticket_price: money(night.ticket_price),
    },
    window: { from, to },
    currency: night.currency,
    revenue: {
      total: revenueTotal,
      tables: res.revenue,
      bar: barra.revenue,
      door: puerta.revenue,
      deposits: res.deposits,
      refunds: res.refunds,
      // Aparte y con nombre, para que nadie lo sume al total por descuido.
      tips_not_club_revenue: propinas.total,
    },
    attendance: {
      // Los que entraron pagando puerta más los invitados que llegaron con mesa.
      total: puerta.people + res.guests_arrived,
      door: puerta.people,
      table_guests: res.guests_arrived,
    },
    reservations: res,
    tables: {
      total: tablesTotal,
      used: tablesUsed,
      occupancy: tablesTotal > 0 ? Math.round((tablesUsed / tablesTotal) * 100) : 0,
    },
    zones: zonas,
    bar: barra,
    door: puerta,
    tips: propinas,
    shrinkage: merma,
    staff: personal,
    // Ticket promedio por persona que entró. Con cero asistencia es 0 y no una
    // división por cero disfrazada de infinito.
    per_person: (puerta.people + res.guests_arrived) > 0
      ? money(revenueTotal / (puerta.people + res.guests_arrived)) : 0,
  };
}

/** Las columnas que se guardan al cerrar, sacadas del corte calculado. */
function closingRow(stats) {
  return {
    event_date: stats.event.event_date,
    currency: stats.currency,
    revenue_total: stats.revenue.total,
    revenue_bar: stats.bar.revenue,
    revenue_door: stats.door.revenue,
    revenue_tables: stats.reservations.revenue,
    tips_total: stats.tips.total,
    attendance: stats.attendance.total,
    reservations_booked: stats.reservations.booked,
    reservations_arrived: stats.reservations.arrived,
    reservations_no_show: stats.reservations.no_show,
    tables_total: stats.tables.total,
    tables_used: stats.tables.used,
    orders_count: stats.bar.orders,
    shrinkage_value: stats.shrinkage.value,
    detail: {
      zones: stats.zones,
      by_category: stats.bar.by_category,
      by_bar: stats.bar.by_bar,
      door: stats.door,
      tips: stats.tips,
      shrinkage: stats.shrinkage,
      staff: stats.staff,
      per_person: stats.per_person,
      window: stats.window,
    },
  };
}

/**
 * Congela el corte de una noche.
 *
 * Se niega a cerrar una noche que todavía no abrió: un corte de una noche que no
 * ha pasado son ceros presentados como hechos. Y se niega a cerrar dos veces --
 * dos cortes de la misma noche significan que ninguno de los dos es el corte.
 */
async function closeNight({ nightclubId, eventId, userId, note = null, now = new Date(),
  runner = pool }) {
  const stats = await nightStats({ nightclubId, eventId, runner });
  if (new Date(stats.event.doors_open_at) > now) {
    throw ApiError.unprocessable('Esa noche todavía no empieza: no hay nada que cortar');
  }

  const row = closingRow(stats);
  let created;
  try {
    created = await runner.query(
      `INSERT INTO night_closings (
         nightclub_id, event_id, event_date, currency,
         revenue_total, revenue_bar, revenue_door, revenue_tables, tips_total,
         attendance, reservations_booked, reservations_arrived, reservations_no_show,
         tables_total, tables_used, orders_count, shrinkage_value,
         detail, closed_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [nightclubId, eventId, row.event_date, row.currency,
        row.revenue_total, row.revenue_bar, row.revenue_door, row.revenue_tables,
        row.tips_total, row.attendance, row.reservations_booked, row.reservations_arrived,
        row.reservations_no_show, row.tables_total, row.tables_used, row.orders_count,
        row.shrinkage_value, JSON.stringify(row.detail), userId, note],
    );
  } catch (err) {
    if (err.code === '23505') {
      throw ApiError.conflict('Esa noche ya está cerrada', { event_id: eventId });
    }
    throw err;
  }
  return created.rows[0];
}

/** Los cortes guardados, para comparar noches. */
async function closings({ nightclubId, limit = 20, offset = 0, runner = pool }) {
  const { rows } = await runner.query(
    `SELECT c.*, e.name AS event_name, u.display_name AS closed_by_name
       FROM night_closings c
       JOIN events_calendar e ON e.id = c.event_id
       LEFT JOIN users u ON u.id = c.closed_by
      WHERE c.nightclub_id = $1
      ORDER BY c.event_date DESC, c.closed_at DESC
      LIMIT $2 OFFSET $3`,
    [nightclubId, limit, offset],
  );
  return rows;
}

module.exports = {
  money,
  loadNight,
  reservations,
  zones,
  bar,
  door,
  tips,
  shrinkage,
  staff,
  nightStats,
  closingRow,
  closeNight,
  closings,
};
