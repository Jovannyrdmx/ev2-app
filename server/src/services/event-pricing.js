// Reservation pricing for EV2 Clandestinoz.
//
// A table is sold for the whole night, never by the hour:
//
//     total = zone base price + (extra guests x that night's ticket price) + add-ons
//
// Each zone's base price covers a number of tickets ("8 personas") and allows a capped
// number of extras ("2 extras", or none at all). The ticket price belongs to the event,
// so the same table costs different amounts on different nights, and the manager can
// override any zone's price, included tickets or extras for one specific event.
//
// Prices are always computed here, on the server, and frozen onto the reservation at
// booking time so a later price change never alters what a guest already agreed to pay.
'use strict';

const { pool } = require('../db/pool');
const { ApiError } = require('../middleware/errors');

/**
 * Effective pricing for every zone on a given event: the standing zone_pricing row
 * with any event override applied on top (COALESCE, so a NULL override falls back).
 */
async function getEventPricing({ nightclubId, eventId, runner = pool }) {
  const event = await runner.query(
    // `deposit_pct` va aquí a proposito: sin el, el `event` que sale de esta
    // funcion no lo trae y la sobrescritura de la noche se ignora EN SILENCIO --
    // la cotizacion cobraria el anticipo del club y nadie se enteraria.
    `SELECT id, name, event_date, doors_open_at, closes_at, ticket_price, currency,
            arrival_deadline_minutes, status, deposit_pct
       FROM events_calendar WHERE id = $1 AND nightclub_id = $2`,
    [eventId, nightclubId],
  );
  if (event.rowCount === 0) throw ApiError.notFound('Event not found');

  const zones = await runner.query(
    `SELECT z.section,
            COALESCE(z.display_name, z.section)              AS display_name,
            COALESCE(o.base_price, z.base_price)             AS base_price,
            COALESCE(o.included_tickets, z.included_tickets) AS included_tickets,
            COALESCE(o.max_extras, z.max_extras)             AS max_extras,
            COALESCE(o.reservable, z.reservable)             AS reservable,
            z.currency, z.color, z.includes, z.sort_order,
            (o.id IS NOT NULL)                               AS overridden,
            o.note                                           AS override_note
       FROM zone_pricing z
       LEFT JOIN event_zone_pricing o ON o.section = z.section AND o.event_id = $2
      WHERE z.nightclub_id = $1 AND z.active
      ORDER BY z.sort_order, z.section`,
    [nightclubId, eventId],
  );

  return { event: event.rows[0], zones: zones.rows };
}

/** Zone pricing for one section on one event, or null when the zone has no price. */
async function zoneFor({ nightclubId, eventId, section, runner = pool }) {
  const { zones, event } = await getEventPricing({ nightclubId, eventId, runner });
  const zone = zones.find((z) => z.section === section) || null;
  return { event, zone };
}

/**
 * What a booking costs.
 *
 * @param {object} zone   effective zone pricing (base_price, included_tickets, max_extras)
 * @param {object} event  the night (ticket_price, currency)
 * @param {number} guests how many people are coming
 * @param {Array}  addons [{ price, quantity }]
 */
function quote({ zone, event, guests, addons = [] }) {
  const included = Number(zone.included_tickets);
  const maxExtras = Number(zone.max_extras);
  const basePrice = Number(zone.base_price);
  const ticket = Number(event.ticket_price);

  if (zone.reservable === false) {
    throw ApiError.unprocessable(`La zona ${zone.section} no se reserva`);
  }

  const extras = Math.max(0, guests - included);
  if (extras > maxExtras) {
    throw ApiError.unprocessable(
      maxExtras === 0
        ? `${zone.display_name || zone.section} incluye ${included} personas y no admite extras`
        : `${zone.display_name || zone.section} incluye ${included} personas y admite hasta ${maxExtras} extras (máximo ${included + maxExtras})`,
      { included_tickets: included, max_extras: maxExtras, max_guests: included + maxExtras, guests },
    );
  }

  const extrasTotal = extras * ticket;
  const addonsTotal = addons.reduce((sum, a) => sum + Number(a.price) * Number(a.quantity || 1), 0);
  const total = basePrice + extrasTotal + addonsTotal;

  return {
    zone: {
      section: zone.section,
      display_name: zone.display_name || zone.section,
      base_price: round(basePrice),
      included_tickets: included,
      max_extras: maxExtras,
      max_guests: included + maxExtras,
      overridden: !!zone.overridden,
    },
    event: {
      id: event.id,
      name: event.name,
      event_date: event.event_date,
      ticket_price: round(ticket),
    },
    guests,
    extra_guests: extras,
    ticket_price: round(ticket),
    extras_total: round(extrasTotal),
    addons_total: round(addonsTotal),
    subtotal: round(total),
    currency: zone.currency || event.currency,
  };
}

/** Deadline after which an unclaimed table is released with no refund. */
function arrivalDeadline(event) {
  const minutes = Number(event.arrival_deadline_minutes || 180);
  return new Date(new Date(event.doors_open_at).getTime() + minutes * 60_000);
}

/** Cuándo termina la noche: el cierre publicado, o 8 horas después de abrir. */
function nightEnd(event) {
  return event.closes_at
    ? new Date(event.closes_at)
    : new Date(new Date(event.doors_open_at).getTime() + 8 * 3_600_000);
}

/** Si la noche ya terminó. Es lo ÚNICO que cierra las reservaciones de esa noche. */
const nightIsOver = (event, now = new Date()) => now >= nightEnd(event);

/**
 * La hora límite para llegar de UNA reservación, según cuándo se hizo.
 *
 * Hasta el 2026-09-21 las reservaciones cerraban dos horas antes de abrir, así que la
 * hora límite de la noche (abrir + `arrival_deadline_minutes`) servía para todas. Ahora
 * se puede reservar con el evento en curso, y con esa hora fija quien reserva a la una
 * de la mañana nacía YA vencido: el siguiente repaso de "no llegó" lo marcaba `no_show`
 * y se quedaba con su anticipo. Por eso cada quien tiene, al menos, el mismo tiempo para
 * llegar que la noche le da a todos, contado desde que reservó — nunca más allá del
 * cierre.
 */
function bookingArrivalDeadline(event, now = new Date()) {
  const minutes = Number(event.arrival_deadline_minutes || 180);
  const deLaNoche = arrivalDeadline(event);
  const desdeAhora = new Date(Math.min(now.getTime() + minutes * 60_000, nightEnd(event).getTime()));
  return desdeAhora > deLaNoche ? desdeAhora : deLaNoche;
}

function round(n) {
  return Number(Number(n).toFixed(2));
}

/**
 * El anticipo que le toca a una noche, en por ciento.
 *
 * La noche manda sobre la regla del club: un 31 de diciembre puede pedir el 100%
 * y un martes de temporada baja el 10%, sin mover la lista vigente ni tener que
 * acordarse de volverla a poner (migración 020).
 *
 * `null` en el evento significa "usa la regla del club", NO "cero por ciento".
 * Distinguir esas dos cosas es todo el punto de la columna: confundirlas
 * regala mesas, porque una noche sin nada especial pasaría a apartarse gratis.
 * De ahí el `== null` en vez de un `||`: con `||`, un 0 legítimamente capturado
 * por el gerente —"esta noche se aparta sin anticipo"— se caería a la regla del
 * club y cobraría el 30%.
 */
function depositPctFor(event, rules) {
  const delEvento = event && event.deposit_pct;
  if (delEvento != null && delEvento !== '') return Number(delEvento);
  const delClub = rules && rules.deposit_pct;
  return delClub == null ? 0 : Number(delClub);
}

/** El monto del anticipo de un total, con el porcentaje que le toca a esa noche. */
function depositFor(total, event, rules) {
  return round(Number(total) * depositPctFor(event, rules) / 100);
}

module.exports = {
  getEventPricing, zoneFor, quote, arrivalDeadline, round, depositPctFor, depositFor,
  nightEnd, nightIsOver, bookingArrivalDeadline,
};
