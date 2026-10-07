// Push notifications to phones (D90).
//
// The domain already announces everything through the `events` outbox; this module
// turns a few of those events into a notification on the right phones. It runs
// behind the realtime relay (one leader for the whole deployment), so each event is
// considered exactly once.
//
// Who gets a notice is decided HERE, per type, and never wider than the event's own
// audience: `order_ready` is addressed to every waiter on the socket (their lists
// refresh), but only the waiter who took the order — or, for a guest's phone order,
// the waiters of that zone — gets a phone buzzing. A notice for everyone is a notice
// nobody reads.
//
// Rules approved with the owner:
//   * staff only while on shift; managers only while a night is in progress (they do
//     not clock in);
//   * guests always, once they turned notifications on;
//   * on the lock screen, personal things are generic (Conecta, payments): no names,
//     no amounts. Orders, the car and the taxi carry their detail.
'use strict';

const webpush = require('web-push');
const { pool } = require('../db/pool');
const { matchesAudience } = require('./events');

// ---------------------------------------------------------------- configuration

function config() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || '';
  const privateKey = process.env.VAPID_PRIVATE_KEY || '';
  const subject = process.env.VAPID_SUBJECT || '';
  return {
    publicKey, privateKey, subject,
    enabled: Boolean(publicKey && privateKey && /^(mailto:|https:\/\/)/.test(subject)),
  };
}

let configured = null;
function ensureConfigured() {
  const c = config();
  if (!c.enabled) return false;
  if (configured !== c.publicKey) {
    webpush.setVapidDetails(c.subject, c.publicKey, c.privateKey);
    configured = c.publicKey;
  }
  return true;
}

// A notice about a drink is useless ten minutes later: the push service drops it
// instead of delivering a stale buzz when the phone comes back online.
const TTL_SECONDS = 300;
// Failures in a row (not "gone") before a device is dropped.
const MAX_FAILURES = 5;
// Hours before the doors open in which a manager already counts as "on duty", and how
// long a night lasts when it has no closing time (same rule as the tills).
const MANAGER_BEFORE_DOORS_HOURS = 2;
// The same night window the tills use (services/till.js): the roster of a night
// applies from twelve hours before its doors, and a night without a closing time
// lasts eight hours.
const ROSTER_BEFORE_DOORS_HOURS = 12;
const DEFAULT_NIGHT_HOURS = 8;

const MANAGER_ROLES = ['manager', 'admin'];

// Where a tap on the notice takes each role.
const ROLE_HOME = {
  guest: 'index.html',
  waiter: 'staff.html',
  hostess: 'staff.html',
  bartender: 'bartender.html',
  cashier: 'caja.html',
  valet: 'valet.html',
  dj: 'employee-portal.html',
  dancer: 'employee-portal.html',
  light_tech: 'employee-portal.html',
  manager: 'manager.html',
  admin: 'manager.html',
};

// ---------------------------------------------------------------- the texts

const TEXTS = {
  es: {
    orderReadyWaiter: ['Trago listo', '{place} · recoger en {bar}'],
    orderReadyWaiterNoBar: ['Trago listo', '{place}'],
    orderReadyGuest: ['Tu pedido está listo', 'Ya va en camino.'],
    orderNewBar: ['Pedido nuevo', '{place} · {items}'],
    orderToCharge: ['Pedido por cobrar', '{place} · {total}'],
    orderReturned: ['Trago devuelto', 'Se devolvió un trago invitado.'],
    paymentConfirmed: ['Pago confirmado', 'Tu pago quedó registrado.'],
    paymentRejected: ['Pago no aprobado', 'Revisa tu cuenta en la app.'],
    reservationConfirmed: ['Reservación confirmada', 'Tu pase ya está en la app.'],
    reservationNew: ['Reservación nueva', 'Revisa la lista de la puerta.'],
    valetRequested: ['Piden un auto', 'Boleto {code}'],
    valetRequestedPlate: ['Piden un auto', 'Boleto {code} · {plate}'],
    valetReady: ['Tu auto está listo', 'Te espera en {point}.'],
    valetReadyNoPoint: ['Tu auto está listo', 'Pasa por él a la entrada.'],
    taxiAssigned: ['Tu taxi va en camino', '{driver} · {plate}'],
    taxiAssignedEta: ['Tu taxi va en camino', '{driver} · {plate} · {eta} min'],
    taxiArrived: ['Tu conductor llegó', 'Te espera en {pickup}.'],
    taxiNoDriver: ['Taxi sin conductor', 'Un viaje se quedó sin conductor.'],
    lostMatched: ['Encontramos tu objeto', 'Pasa a recogerlo con el código que está en la app.'],
    flirtReceived: ['Conecta', 'Alguien te mandó algo.'],
    departureRequested: ['Salida por confirmar', '{guest} espera en la puerta.'],
    songRequested: ['Canción pedida', '{song}'],
    staffDrink: ['Te invitaron un trago', 'Desde la mesa {table}.'],
    userReported: ['Reporte de un usuario', 'Revísalo en Moderación.'],
    printFailed: ['Falló una impresión', 'Revisa Impresoras.'],
    terminalRejected: ['Cobro con terminal rechazado', '{detail}'],
    table: 'Mesa {code}',
    noPlace: 'Sin mesa',
    drinks: '{n} tragos',
    drink1: '1 trago',
    test: ['EV2', 'Las notificaciones están activas en este teléfono.'],
  },
  en: {
    orderReadyWaiter: ['Drink ready', '{place} · pick up at {bar}'],
    orderReadyWaiterNoBar: ['Drink ready', '{place}'],
    orderReadyGuest: ['Your order is ready', "It's on its way."],
    orderNewBar: ['New order', '{place} · {items}'],
    orderToCharge: ['Order to collect', '{place} · {total}'],
    orderReturned: ['Drink returned', 'A gifted drink was returned.'],
    paymentConfirmed: ['Payment confirmed', 'Your payment is recorded.'],
    paymentRejected: ['Payment not approved', 'Check your account in the app.'],
    reservationConfirmed: ['Booking confirmed', 'Your pass is in the app.'],
    reservationNew: ['New booking', 'Check the door list.'],
    valetRequested: ['Car requested', 'Ticket {code}'],
    valetRequestedPlate: ['Car requested', 'Ticket {code} · {plate}'],
    valetReady: ['Your car is ready', 'It is waiting at {point}.'],
    valetReadyNoPoint: ['Your car is ready', 'Pick it up at the entrance.'],
    taxiAssigned: ['Your taxi is on its way', '{driver} · {plate}'],
    taxiAssignedEta: ['Your taxi is on its way', '{driver} · {plate} · {eta} min'],
    taxiArrived: ['Your driver is here', 'Waiting at {pickup}.'],
    taxiNoDriver: ['Taxi without a driver', 'A ride was left without a driver.'],
    lostMatched: ['We found your item', 'Pick it up with the code in the app.'],
    flirtReceived: ['Connect', 'Someone sent you something.'],
    departureRequested: ['Exit to confirm', '{guest} is waiting at the door.'],
    songRequested: ['Song requested', '{song}'],
    staffDrink: ['You were sent a drink', 'From table {table}.'],
    userReported: ['A user was reported', 'Review it in Moderation.'],
    printFailed: ['A print failed', 'Check Printers.'],
    terminalRejected: ['Terminal charge declined', '{detail}'],
    table: 'Table {code}',
    noPlace: 'No table',
    drinks: '{n} drinks',
    drink1: '1 drink',
    test: ['EV2', 'Notifications are on for this phone.'],
  },
};

const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g,
  (m, k) => (vars && vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));

/** Title and body of a notice in a language. Unknown keys fall back to Spanish. */
function render(key, lang, vars) {
  const pack = TEXTS[lang] || TEXTS.es;
  const pair = pack[key] || TEXTS.es[key];
  if (!pair) return null;
  return { title: fill(pair[0], vars), body: fill(pair[1], vars) };
}

function word(key, lang, vars) {
  const pack = TEXTS[lang] || TEXTS.es;
  return fill(pack[key] || TEXTS.es[key], vars);
}

function money(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  return `${currency === 'USD' ? 'US$' : '$'}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------- who is on duty

/** Staff with an open shift, from a list of ids. */
async function onShift(db, nightclubId, userIds) {
  if (!userIds.length) return new Set();
  const { rows } = await db.query(
    `SELECT DISTINCT user_id FROM staff_shifts
      WHERE nightclub_id = $1 AND user_id = ANY($2::uuid[]) AND ended_at IS NULL`,
    [nightclubId, userIds]);
  return new Set(rows.map((r) => r.user_id));
}

/** Is a night in progress (or about to open)? The manager's "shift". */
async function nightInProgress(db, nightclubId) {
  const { rows } = await db.query(
    `SELECT 1 FROM events_calendar e
      WHERE e.nightclub_id = $1 AND e.status NOT IN ('cancelled', 'finished', 'draft')
        AND e.doors_open_at <= now() + make_interval(hours => $2::int)
        AND COALESCE(e.closes_at, e.doors_open_at + make_interval(hours => $3::int)) > now()
      LIMIT 1`,
    [nightclubId, MANAGER_BEFORE_DOORS_HOURS, DEFAULT_NIGHT_HOURS]);
  return rows.length > 0;
}

/** Users of some roles in the club (active accounts). */
async function usersWithRoles(db, nightclubId, roles) {
  const { rows } = await db.query(
    `SELECT id, role FROM users WHERE nightclub_id = $1 AND role = ANY($2::text[]) AND status = 'active'`,
    [nightclubId, roles]);
  return rows;
}

async function usersByIds(db, nightclubId, ids) {
  const clean = [...new Set((ids || []).filter(Boolean))];
  if (!clean.length) return [];
  const { rows } = await db.query(
    `SELECT id, role FROM users WHERE nightclub_id = $1 AND id = ANY($2::uuid[]) AND status = 'active'`,
    [nightclubId, clean]);
  return rows;
}

/**
 * Staff assigned tonight to a bar or a zone (the night's roster, D58). Empty when the
 * roster has nobody there: the caller then falls back to everyone of that role.
 */
async function assignedTonight(db, nightclubId, { role, locationId = null, section = null }) {
  const { rows } = await db.query(
    `SELECT DISTINCT a.user_id AS id, u.role
       FROM shift_assignments a
       JOIN events_calendar e ON e.id = a.event_id
       JOIN users u ON u.id = a.user_id AND u.status = 'active'
      WHERE a.nightclub_id = $1 AND a.role = $2::text
        AND ($3::uuid IS NULL OR a.location_id = $3::uuid)
        AND ($4::text IS NULL OR a.section = $4::text)
        AND e.status NOT IN ('cancelled', 'finished')
        AND e.doors_open_at <= now() + make_interval(hours => $5::int)
        AND COALESCE(e.closes_at, e.doors_open_at + make_interval(hours => $6::int)) > now()`,
    [nightclubId, role, locationId, section, ROSTER_BEFORE_DOORS_HOURS, DEFAULT_NIGHT_HOURS]);
  return rows;
}

/** The roster's people for a bar or zone, or everyone with that role. */
async function staffFor(db, nightclubId, { role, locationId = null, section = null }) {
  if (locationId || section) {
    const assigned = await assignedTonight(db, nightclubId, { role, locationId, section });
    if (assigned.length) return assigned;
  }
  return usersWithRoles(db, nightclubId, [role]);
}

/** The cashier whose till is open at a bar (D77). */
async function cashierAt(db, nightclubId, locationId) {
  if (!locationId) return [];
  const { rows } = await db.query(
    `SELECT DISTINCT s.user_id AS id, u.role FROM staff_shifts s JOIN users u ON u.id = s.user_id
      WHERE s.nightclub_id = $1 AND s.location_id = $2 AND s.ended_at IS NULL AND u.role = 'cashier'`,
    [nightclubId, locationId]);
  return rows;
}

async function loadOrder(db, nightclubId, orderId) {
  if (!orderId) return null;
  const { rows } = await db.query(
    `SELECT o.id, o.sender_id, su.role AS sender_role, o.taken_by, o.pay_at_till, o.subtotal::text AS subtotal,
            o.currency, o.bar_location_id, bar.name AS bar_name, t.code AS table_code, t.section AS table_section,
            dp.name AS point_name,
            (SELECT COALESCE(sum(quantity), 0)::int FROM drink_order_items WHERE order_id = o.id) AS items
       FROM drink_orders o
       LEFT JOIN users su ON su.id = o.sender_id
       LEFT JOIN supply_locations bar ON bar.id = o.bar_location_id
       LEFT JOIN tables t ON t.id = o.table_id
       LEFT JOIN delivery_points dp ON dp.id = o.delivery_point_id
      WHERE o.id = $1 AND o.nightclub_id = $2`,
    [orderId, nightclubId]);
  return rows[0] || null;
}

const place = (order, lang) => {
  if (order.table_code) return word('table', lang, { code: order.table_code });
  return order.point_name || word('noPlace', lang);
};
const itemsText = (n, lang) => (Number(n) === 1 ? word('drink1', lang) : word('drinks', lang, { n }));

// ---------------------------------------------------------------- the catalog

/**
 * For each event type that becomes a notice: who receives it and what it says.
 * `recipients` returns [{ id, role, key, vars? }]; `vars` may be a function of the
 * language so place names come out translated. Types not listed are not notified.
 */
const CATALOG = {
  async order_ready(db, ev) {
    const o = await loadOrder(db, ev.nightclub_id, ev.payload.order_id);
    if (!o) return [];
    const out = [];
    const vars = (lang) => ({ place: place(o, lang), bar: o.bar_name });
    if (o.sender_role === 'guest') out.push({ id: o.sender_id, role: 'guest', key: 'orderReadyGuest', tag: `order-${o.id}` });
    const waiterKey = o.bar_name ? 'orderReadyWaiter' : 'orderReadyWaiterNoBar';
    if (o.taken_by) {
      out.push(...(await usersByIds(db, ev.nightclub_id, [o.taken_by]))
        .map((u) => ({ ...u, key: waiterKey, vars, tag: `order-${o.id}` })));
    } else {
      // A guest's phone order: nobody took it, so the waiters of that zone carry it.
      const waiters = await staffFor(db, ev.nightclub_id, { role: 'waiter', section: o.table_section });
      out.push(...waiters.map((u) => ({ ...u, key: waiterKey, vars, tag: `order-${o.id}` })));
    }
    return out;
  },

  // A waiter's order enters the bar when it is taken (D77); the rest when it is paid.
  async order_created(db, ev) {
    if (!ev.payload.pay_at_till) return [];
    const o = await loadOrder(db, ev.nightclub_id, ev.payload.order_id);
    if (!o) return [];
    const bartenders = await staffFor(db, ev.nightclub_id, { role: 'bartender', locationId: o.bar_location_id });
    const cashiers = await cashierAt(db, ev.nightclub_id, o.bar_location_id);
    return [
      ...bartenders.map((u) => ({
        ...u, key: 'orderNewBar', tag: `order-${o.id}`,
        vars: (lang) => ({ place: place(o, lang), items: itemsText(o.items, lang) }),
      })),
      ...cashiers.map((u) => ({
        ...u, key: 'orderToCharge', tag: `charge-${o.id}`,
        vars: (lang) => ({ place: place(o, lang), total: money(o.subtotal, o.currency) }),
      })),
    ];
  },

  async order_paid(db, ev) {
    const o = await loadOrder(db, ev.nightclub_id, ev.payload.order_id);
    if (!o || o.pay_at_till) return [];
    const bartenders = await staffFor(db, ev.nightclub_id, { role: 'bartender', locationId: o.bar_location_id });
    return bartenders.map((u) => ({
      ...u, key: 'orderNewBar', tag: `order-${o.id}`,
      vars: (lang) => ({ place: place(o, lang), items: itemsText(o.items, lang) }),
    }));
  },

  async order_returned(db, ev) {
    const o = await loadOrder(db, ev.nightclub_id, ev.payload.order_id);
    if (!o) return [];
    const bartenders = await staffFor(db, ev.nightclub_id, { role: 'bartender', locationId: o.bar_location_id });
    return bartenders.map((u) => ({ ...u, key: 'orderReturned', tag: `returned-${o.id}` }));
  },

  async payment_confirmed(db, ev) {
    const people = await usersByIds(db, ev.nightclub_id, ev.audience.userIds);
    return people.filter((u) => u.role === 'guest').map((u) => ({ ...u, key: 'paymentConfirmed' }));
  },

  async payment_rejected(db, ev) {
    const people = await usersByIds(db, ev.nightclub_id, ev.audience.userIds);
    return people.filter((u) => u.role === 'guest').map((u) => ({ ...u, key: 'paymentRejected' }));
  },

  async reservation_confirmed(db, ev) {
    const people = await usersByIds(db, ev.nightclub_id, ev.audience.userIds);
    return people.filter((u) => u.role === 'guest')
      .map((u) => ({ ...u, key: 'reservationConfirmed', tag: `res-${ev.payload.reservation_id}` }));
  },

  async reservation_created(db, ev) {
    const hostesses = await usersWithRoles(db, ev.nightclub_id, ['hostess']);
    return hostesses.map((u) => ({ ...u, key: 'reservationNew', tag: 'reservations' }));
  },

  async valet_requested(db, ev) {
    const valets = await usersWithRoles(db, ev.nightclub_id, ['valet']);
    const p = ev.payload;
    return valets.map((u) => ({
      ...u, key: p.plate ? 'valetRequestedPlate' : 'valetRequested',
      vars: { code: p.code, plate: p.plate }, tag: `valet-${p.ticket_id}`,
    }));
  },

  async valet_ready(db, ev) {
    const people = await usersByIds(db, ev.nightclub_id, ev.audience.userIds);
    const p = ev.payload;
    return people.filter((u) => u.role === 'guest').map((u) => ({
      ...u, key: p.handover_point ? 'valetReady' : 'valetReadyNoPoint',
      vars: { point: p.handover_point }, tag: `valet-${p.ticket_id}`,
    }));
  },

  async taxi_assigned(db, ev) {
    const people = await usersByIds(db, ev.nightclub_id, ev.audience.userIds);
    const p = ev.payload;
    return people.filter((u) => u.role === 'guest').map((u) => ({
      ...u, key: p.eta_minutes ? 'taxiAssignedEta' : 'taxiAssigned',
      vars: { driver: p.driver_name || '', plate: p.vehicle_plate || '', eta: p.eta_minutes },
      tag: `taxi-${p.ride_id}`,
    }));
  },

  async taxi_driver_arrived(db, ev) {
    const people = await usersByIds(db, ev.nightclub_id, ev.audience.userIds);
    const p = ev.payload;
    return people.filter((u) => u.role === 'guest').map((u) => ({
      ...u, key: 'taxiArrived', vars: { pickup: p.pickup_location || '' }, tag: `taxi-${p.ride_id}`,
    }));
  },

  async taxi_no_driver(db, ev) {
    const managers = await usersWithRoles(db, ev.nightclub_id, MANAGER_ROLES);
    return managers.map((u) => ({ ...u, key: 'taxiNoDriver', tag: `taxi-${ev.payload.ride_id}` }));
  },

  async lost_item_matched(db, ev) {
    const people = await usersByIds(db, ev.nightclub_id, ev.audience.userIds);
    // The handover code never goes on the lock screen: it is what proves the item is yours.
    return people.filter((u) => u.role === 'guest')
      .map((u) => ({ ...u, key: 'lostMatched', tag: `lost-${ev.payload.item_id}` }));
  },

  async flirt_received(db, ev) {
    const people = await usersByIds(db, ev.nightclub_id, ev.audience.userIds);
    return people.filter((u) => u.role === 'guest').map((u) => ({ ...u, key: 'flirtReceived', tag: 'flirt' }));
  },

  async departure_requested(db, ev) {
    const hostesses = await usersWithRoles(db, ev.nightclub_id, ['hostess']);
    return hostesses.map((u) => ({
      ...u, key: 'departureRequested', vars: { guest: ev.payload.guest || '' },
      tag: `departure-${ev.payload.departure_id}`,
    }));
  },

  async song_requested(db, ev) {
    const people = await usersByIds(db, ev.nightclub_id, ev.audience.userIds);
    const p = ev.payload;
    const song = [p.title, p.artist].filter(Boolean).join(' — ');
    return people.filter((u) => u.role === 'dj')
      .map((u) => ({ ...u, key: 'songRequested', vars: { song }, tag: `song-${p.song_request_id}` }));
  },

  async staff_drink_received(db, ev) {
    const people = await usersByIds(db, ev.nightclub_id, ev.audience.userIds);
    return people.filter((u) => u.role !== 'guest').map((u) => ({
      ...u, key: 'staffDrink', vars: { table: ev.payload.from_table || '' },
      tag: `staff-drink-${ev.payload.staff_drink_id}`,
    }));
  },

  async user_reported(db, ev) {
    const managers = await usersWithRoles(db, ev.nightclub_id, MANAGER_ROLES);
    return managers.map((u) => ({ ...u, key: 'userReported', tag: 'reports' }));
  },

  async print_job_failed(db, ev) {
    const managers = await usersWithRoles(db, ev.nightclub_id, MANAGER_ROLES);
    return managers.map((u) => ({ ...u, key: 'printFailed', tag: 'printing' }));
  },

  async terminal_charge_updated(db, ev) {
    const p = ev.payload;
    if (p.status !== 'failed') return [];
    const managers = await usersWithRoles(db, ev.nightclub_id, MANAGER_ROLES);
    const starter = await usersByIds(db, ev.nightclub_id, [p.started_by]);
    const detail = [p.terminal, p.amount ? money(p.amount, p.currency) : null].filter(Boolean).join(' · ');
    return [...managers, ...starter.filter((u) => u.role !== 'guest')]
      .map((u) => ({ ...u, key: 'terminalRejected', vars: { detail }, tag: `terminal-${p.charge_id}` }));
  },
};

// ---------------------------------------------------------------- deciding

/**
 * The notices an event produces, already filtered:
 *   * never outside the event's own audience (fails closed, like the sockets);
 *   * staff only while on shift, managers only while a night is in progress;
 *   * one notice per person even if two rules picked them.
 */
async function noticesFor(event, { db = pool } = {}) {
  const rule = CATALOG[event.type];
  if (!rule) return [];
  const ev = { ...event, payload: event.payload || {}, audience: event.audience || {} };
  const picked = await rule(db, ev);
  const seen = new Set();
  const inAudience = picked.filter((r) => {
    if (!r || !r.id || seen.has(r.id)) return false;
    seen.add(r.id);
    return matchesAudience(ev.audience, { id: r.id, role: r.role });
  });
  if (!inAudience.length) return [];

  const staff = inAudience.filter((r) => r.role !== 'guest' && !MANAGER_ROLES.includes(r.role));
  const working = await onShift(db, ev.nightclub_id, staff.map((r) => r.id));
  const managersOn = inAudience.some((r) => MANAGER_ROLES.includes(r.role))
    ? await nightInProgress(db, ev.nightclub_id) : false;

  return inAudience.filter((r) => {
    if (r.role === 'guest') return true;
    if (MANAGER_ROLES.includes(r.role)) return managersOn;
    return working.has(r.id);
  });
}

/** The JSON the service worker receives for one device. */
function payloadFor(notice, lang, event) {
  const vars = typeof notice.vars === 'function' ? notice.vars(lang) : (notice.vars || {});
  const text = render(notice.key, lang, vars);
  if (!text) return null;
  return {
    title: text.title,
    body: text.body,
    url: ROLE_HOME[notice.role] || 'index.html',
    tag: notice.tag || `${event.type}-${event.id}`,
    type: event.type,
    event_id: event.id ? String(event.id) : null,
  };
}

// ---------------------------------------------------------------- sending

async function subscriptionsOf(db, nightclubId, userIds) {
  if (!userIds.length) return [];
  const { rows } = await db.query(
    `SELECT id, user_id, endpoint, p256dh, auth, lang FROM push_subscriptions
      WHERE nightclub_id = $1 AND user_id = ANY($2::uuid[])`,
    [nightclubId, userIds]);
  return rows;
}

/**
 * Sends one payload to one device and keeps the table honest: a device that is gone
 * (404/410) is deleted at once; repeated other failures delete it after MAX_FAILURES.
 */
async function sendTo(db, sub, payload, { sender = webpush, logger = console } = {}) {
  try {
    await sender.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: TTL_SECONDS, urgency: 'high', topic: String(payload.tag || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined },
    );
    await db.query('UPDATE push_subscriptions SET last_sent_at = now(), failures = 0 WHERE id = $1', [sub.id]);
    return 'sent';
  } catch (err) {
    const code = err && err.statusCode;
    if (code === 404 || code === 410) {
      await db.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
      return 'gone';
    }
    logger.warn?.(`Push failed (${code || err.message}) for subscription ${sub.id}`);
    await db.query(
      `UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1`, [sub.id]);
    await db.query(
      `DELETE FROM push_subscriptions WHERE id = $1 AND failures >= $2`, [sub.id, MAX_FAILURES]);
    return 'failed';
  }
}

/**
 * Called by the relay leader for every live event. Never throws: a push service that
 * is down must not slow the relay that feeds every screen in the club.
 */
async function dispatch(event, { db = pool, sender = webpush, logger = console } = {}) {
  try {
    if (!CATALOG[event.type]) return { sent: 0 };
    if (sender === webpush && !ensureConfigured()) return { sent: 0, disabled: true };
    const notices = await noticesFor(event, { db });
    if (!notices.length) return { sent: 0 };
    const byUser = new Map(notices.map((n) => [n.id, n]));
    const subs = await subscriptionsOf(db, event.nightclub_id, [...byUser.keys()]);
    const results = await Promise.all(subs.map((sub) => {
      const payload = payloadFor(byUser.get(sub.user_id), sub.lang, event);
      return payload ? sendTo(db, sub, payload, { sender, logger }) : 'skipped';
    }));
    const sent = results.filter((r) => r === 'sent').length;
    // Una línea por aviso en el registro de la API (D91): en producción es la única
    // forma de saber si un aviso salió, a cuántos teléfonos, o si nadie tenía uno.
    logger.info?.(`Push ${event.type}: ${notices.length} destinatario(s), ${subs.length} teléfono(s), ${sent} enviado(s)`);
    return { sent, results };
  } catch (err) {
    logger.error?.(`Push dispatch failed for event ${event && event.id}: ${err.message}`);
    return { sent: 0, error: err.message };
  }
}

/** "Probar": one notice to every device of this person, right now. */
async function sendTest({ db = pool, nightclubId, userId, sender = webpush, logger = console }) {
  const subs = await subscriptionsOf(db, nightclubId, [userId]);
  const results = await Promise.all(subs.map((sub) => {
    const text = render('test', sub.lang);
    return sendTo(db, sub, { ...text, url: 'index.html', tag: 'test', type: 'test' }, { sender, logger });
  }));
  return { devices: subs.length, sent: results.filter((r) => r === 'sent').length };
}

/**
 * El estado para la pantalla (D91): si el servidor tiene notificaciones, cuántos
 * teléfonos tiene esta persona y si AHORA MISMO le llegarían los avisos de su puesto —
 * con el porqué cuando no: sin teléfonos, fuera de turno, o (gerente) sin noche en curso.
 * Para la gerencia, además, cuántos teléfonos hay por puesto.
 */
async function status({ db = pool, nightclubId, user }) {
  const c = config();
  const mine = await db.query(
    'SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1 AND nightclub_id = $2',
    [user.id, nightclubId]);
  const devices = mine.rows[0].n;
  let reason = null;
  if (!c.enabled) reason = 'server_disabled';
  else if (!devices) reason = 'no_devices';
  else if (MANAGER_ROLES.includes(user.role)) {
    if (!(await nightInProgress(db, nightclubId))) reason = 'no_night';
  } else if (user.role !== 'guest') {
    if (!(await onShift(db, nightclubId, [user.id])).has(user.id)) reason = 'off_shift';
  }
  const out = { enabled: c.enabled, mine: { devices, receiving_now: reason === null, reason } };
  if (MANAGER_ROLES.includes(user.role)) {
    const { rows } = await db.query(
      `SELECT u.role, count(*)::int AS devices, count(DISTINCT u.id)::int AS people,
              max(s.last_sent_at) AS last_sent_at
         FROM push_subscriptions s JOIN users u ON u.id = s.user_id
        WHERE s.nightclub_id = $1
        GROUP BY u.role ORDER BY u.role`,
      [nightclubId]);
    out.by_role = rows;
  }
  return out;
}

module.exports = {
  config, ensureConfigured, dispatch, noticesFor, payloadFor, render, sendTo, sendTest, status,
  CATALOG, TEXTS, ROLE_HOME, TTL_SECONDS, MAX_FAILURES,
};
