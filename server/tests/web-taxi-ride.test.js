'use strict';

// Salida segura, los dos lados. Lo que no se puede equivocar: si el cliente tiene que
// bajar ya o esperar arriba, y qué botón le toca al conductor. Un error aquí manda a
// alguien a la banqueta a las 3 de la mañana a esperar un coche que no viene.

const Taxi = require('../../web/js/taxi-ride.js');

const NOW = Date.parse('2026-09-06T05:10:00.000Z');
const inMinutes = (n) => new Date(NOW + n * 60000).toISOString();

const ride = (over = {}) => Object.assign({
  id: 'r1',
  status: 'assigned',
  passengers: 2,
  pickup_location: 'Puerta principal',
  destination: 'Col. Centro',
  quoted_amount: '180.00',
  final_amount: null,
  currency: 'MXN',
  eta_minutes: 10,
  expected_arrival_at: inMinutes(10),
  driver: {
    id: 'd1',
    name: 'Luis',
    company: 'Taxis Nogales',
    phone: '+526311234567',
    vehicle: { plate: 'ABC-123', color: 'blanco', description: 'Nissan Versa' },
  },
  certificate_folio: null,
  certificate_expires_at: null,
}, over);

// ---------------------------------------------------------------- estados

describe('En qué punto va el viaje', () => {
  it('cada estado del servidor tiene una etapa, ninguna inventada', () => {
    // Espejo del CHECK de taxi_requests en la migración 009.
    expect(Taxi.guestStage(ride({ status: 'requested' }))).toBe('searching');
    expect(Taxi.guestStage(ride({ status: 'assigned' }))).toBe('onTheWay');
    expect(Taxi.guestStage(ride({ status: 'driver_arrived' }))).toBe('atExit');
    expect(Taxi.guestStage(ride({ status: 'in_progress' }))).toBe('riding');
    expect(Taxi.guestStage(ride({ status: 'completed' }))).toBe('done');
    expect(Taxi.guestStage(ride({ status: 'cancelled' }))).toBe('cancelled');
    expect(Taxi.guestStage(ride({ status: 'no_driver' }))).toBe('noDriver');
  });

  it('sin viaje, la pantalla arranca en reposo', () => {
    expect(Taxi.guestStage(null)).toBe('idle');
    expect(Taxi.guestStage({})).toBe('idle');
  });

  it('un estado desconocido no rompe la pantalla', () => {
    expect(Taxi.guestStage(ride({ status: 'teletransportado' }))).toBe('idle');
  });

  it('vivo y cerrado no se solapan', () => {
    for (const s of Taxi.LIVE_STATUSES) {
      expect(Taxi.isLive(s)).toBe(true);
      expect(Taxi.isClosed(s)).toBe(false);
    }
    for (const s of Taxi.CLOSED_STATUSES) {
      expect(Taxi.isClosed(s)).toBe(true);
      expect(Taxi.isLive(s)).toBe(false);
    }
  });

  it('cancelar se puede antes de subirse, no después', () => {
    expect(Taxi.canCancel('requested')).toBe(true);
    expect(Taxi.canCancel('assigned')).toBe(true);
    expect(Taxi.canCancel('driver_arrived')).toBe(true);
    // Ya va en el coche: eso se arregla hablando, no con un botón.
    expect(Taxi.canCancel('in_progress')).toBe(false);
    expect(Taxi.canCancel('completed')).toBe(false);
  });
});

// ---------------------------------------------------------------- ¿bajo o espero?

describe('La única pregunta del cliente: ¿bajo o espero?', () => {
  it('con el conductor en la puerta, dice que baje, y es urgente', () => {
    const h = Taxi.guestHeadline(ride({ status: 'driver_arrived' }), null, NOW);
    expect(h.key).toBe('taxi.atExit');
    expect(h.urgent).toBe(true);
  });

  it('faltando diez minutos, no lo manda a la banqueta', () => {
    const h = Taxi.guestHeadline(ride({ expected_arrival_at: inMinutes(10) }), null, NOW);
    expect(h.key).toBe('taxi.arrivesIn');
    expect(h.vars.n).toBe(10);
    expect(h.urgent).toBe(false);
  });

  it('faltando dos minutos o menos, sí', () => {
    const h = Taxi.guestHeadline(ride({ expected_arrival_at: inMinutes(2) }), null, NOW);
    expect(h.key).toBe('taxi.goDownNow');
    expect(h.urgent).toBe(true);
  });

  it('un conductor que aceptó con cero minutos ya está ahí', () => {
    const h = Taxi.guestHeadline(
      ride({ eta_minutes: 0, expected_arrival_at: inMinutes(0) }), null, NOW);
    expect(h.key).toBe('taxi.arrivingNow');
    expect(h.urgent).toBe(true);
  });

  it('si ya se pasó la hora prometida, sigue diciendo que baje, no se queda callado', () => {
    const h = Taxi.guestHeadline(ride({ expected_arrival_at: inMinutes(-4) }), null, NOW);
    expect(h.key).toBe('taxi.arrivingNow');
    expect(h.urgent).toBe(true);
  });

  it('aceptado pero sin hora, no inventa un número', () => {
    const h = Taxi.guestHeadline(
      ride({ eta_minutes: null, expected_arrival_at: null }), null, NOW);
    expect(h.key).toBe('taxi.onTheWay');
    expect(h.vars).toBe(null);
  });

  it('los minutos se redondean hacia arriba: "0 min" con 40 segundos por delante miente', () => {
    const casi = new Date(NOW + 40000).toISOString();
    expect(Taxi.minutesUntilArrival({ expected_arrival_at: casi }, NOW)).toBe(1);
  });

  it('una hora inservible no imprime NaN', () => {
    expect(Taxi.minutesUntilArrival({ expected_arrival_at: 'mañana' }, NOW)).toBe(null);
    expect(Taxi.minutesUntilArrival({}, NOW)).toBe(null);
    expect(Taxi.minutesUntilArrival(null, NOW)).toBe(null);
  });
});

describe('Sin viaje pedido, lo que dice la pantalla', () => {
  const head = (availability) => Taxi.guestHeadline(null, availability, NOW).key;

  it('con el servicio apagado lo dice, en vez de ofrecer un botón que va a fallar', () => {
    expect(head({ enabled: false })).toBe('taxi.disabled');
  });

  it('"hay uno esperando en la salida" solo si de verdad hay uno parado ahí', () => {
    expect(head({ enabled: true, wait_at_exit: true, available_drivers: 2 }))
      .toBe('taxi.someoneWaiting');
    // Disponibles pero ninguno en la puerta: no se promete lo que no hay.
    expect(head({ enabled: true, wait_at_exit: false, available_drivers: 2 }))
      .toBe('taxi.driversAvailable');
  });

  it('sin conductores lo dice, y aun así se puede solicitar', () => {
    expect(head({ enabled: true, wait_at_exit: false, available_drivers: 0 }))
      .toBe('taxi.noDriversNow');
  });

  it('sin haber consultado todavía, no promete nada', () => {
    expect(head(null)).toBe('taxi.noDriversNow');
  });
});

// ---------------------------------------------------------------- el coche

describe('Reconocer el coche desde la banqueta', () => {
  it('color, modelo y placa, en ese orden', () => {
    expect(Taxi.vehicleLabel(ride())).toBe('blanco Nissan Versa · ABC-123');
  });

  it('con datos incompletos muestra lo que hay, no huecos', () => {
    expect(Taxi.vehicleLabel(ride({
      driver: { vehicle: { plate: 'XYZ-9', color: null, description: null } },
    }))).toBe('XYZ-9');
    expect(Taxi.vehicleLabel(ride({
      driver: { vehicle: { plate: null, color: 'rojo', description: 'Tsuru' } },
    }))).toBe('rojo Tsuru');
  });

  it('sin conductor asignado todavía no hay coche que mostrar', () => {
    expect(Taxi.vehicleLabel(ride({ driver: null }))).toBe(null);
    expect(Taxi.vehicleLabel(null)).toBe(null);
  });
});

describe('El precio', () => {
  it('mientras va, el cotizado; al terminar, el cobrado', () => {
    expect(Taxi.fareAmount(ride())).toBe('180.00');
    expect(Taxi.fareAmount(ride({ status: 'completed', final_amount: '200.00' }))).toBe('200.00');
  });

  it('una zona fuera de la lista del club no inventa un número', () => {
    // El servidor cotiza null a propósito: se acuerda con el conductor.
    expect(Taxi.fareAmount(ride({ quoted_amount: null }))).toBe(null);
  });

  it('un cobro de cero es un cobro, no "sin precio"', () => {
    expect(Taxi.fareAmount(ride({ final_amount: '0.00' }))).toBe('0.00');
  });
});

describe('El certificado de salida', () => {
  it('no existe hasta que el viaje empieza', () => {
    expect(Taxi.certificate(ride(), NOW)).toBe(null);
  });

  it('cuando existe, trae folio y si ya venció', () => {
    const vigente = Taxi.certificate(ride({
      certificate_folio: 'EV2-7K4M', certificate_expires_at: inMinutes(120),
    }), NOW);
    expect(vigente).toMatchObject({ folio: 'EV2-7K4M', expired: false });

    const vencido = Taxi.certificate(ride({
      certificate_folio: 'EV2-7K4M', certificate_expires_at: inMinutes(-1),
    }), NOW);
    expect(vencido.expired).toBe(true);
  });

  it('un folio sin fecha de vencimiento no se marca vencido por las dudas', () => {
    expect(Taxi.certificate(ride({ certificate_folio: 'EV2-1' }), NOW).expired).toBe(false);
  });
});

describe('Qué viaje se le muestra al cliente', () => {
  it('el vivo manda sobre cualquier otro', () => {
    const vivo = ride({ id: 'vivo', status: 'assigned' });
    const viejo = ride({ id: 'viejo', status: 'completed', certificate_folio: 'EV2-1', certificate_expires_at: inMinutes(60) });
    expect(Taxi.currentForGuest(vivo, [viejo, vivo], NOW).id).toBe('vivo');
  });

  it('terminado el viaje, se sigue mostrando mientras el comprobante valga', () => {
    // Si la pantalla lo soltara al terminar, el cliente perdería el folio justo cuando
    // le sirve: es lo único que prueba a qué hora y con quién salió.
    const terminado = ride({
      id: 'r1', status: 'completed',
      certificate_folio: 'EV2-QUKY', certificate_expires_at: inMinutes(120),
    });
    expect(Taxi.currentForGuest(null, [terminado], NOW).id).toBe('r1');
  });

  it('con el comprobante vencido ya no ocupa la pantalla', () => {
    const viejo = ride({
      id: 'r1', status: 'completed',
      certificate_folio: 'EV2-QUKY', certificate_expires_at: inMinutes(-1),
    });
    expect(Taxi.currentForGuest(null, [viejo], NOW)).toBe(null);
  });

  it('un viaje cancelado, que nunca tuvo comprobante, no se queda pegado', () => {
    expect(Taxi.currentForGuest(null, [ride({ status: 'cancelled' })], NOW)).toBe(null);
  });

  it('sin viajes no muestra nada', () => {
    expect(Taxi.currentForGuest(null, [], NOW)).toBe(null);
    expect(Taxi.currentForGuest(null, null, NOW)).toBe(null);
  });
});

// ---------------------------------------------------------------- el conductor

describe('Qué le toca al conductor', () => {
  it('un botón por estado, en el orden que el servidor acepta', () => {
    expect(Taxi.driverAction('requested')).toMatchObject({ action: 'accept', needsEta: true });
    expect(Taxi.driverAction('assigned')).toMatchObject({ action: 'arrived' });
    expect(Taxi.driverAction('driver_arrived')).toMatchObject({ action: 'start' });
    expect(Taxi.driverAction('in_progress')).toMatchObject({ action: 'finish', needsAmount: true });
  });

  it('solo al aceptar se le piden los minutos, y solo al terminar el cobro', () => {
    expect(Taxi.driverAction('assigned').needsEta).toBe(false);
    expect(Taxi.driverAction('driver_arrived').needsAmount).toBeUndefined();
  });

  it('un viaje cerrado no ofrece nada', () => {
    expect(Taxi.driverAction('completed')).toBe(null);
    expect(Taxi.driverAction('cancelled')).toBe(null);
  });

  it('los minutos que puede declarar son los que el servidor acepta', () => {
    // El servidor valida 0..120; estas son las opciones que se le ofrecen de un toque.
    expect(Taxi.ETA_CHOICES).toContain(0);
    expect(Math.max(...Taxi.ETA_CHOICES)).toBeLessThanOrEqual(120);
    expect(Taxi.ETA_CHOICES.every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
  });

  it('con un viaje en curso NO se le muestran ofertas', () => {
    // Un índice único en la base impide dos viajes vivos por conductor: ofrecerle otro
    // solo produce un error mientras maneja.
    const view = Taxi.driverView(ride({ status: 'in_progress' }), [ride({ id: 'r2', status: 'requested' })]);
    expect(view.mode).toBe('ride');
    expect(view.offers).toEqual([]);
  });

  it('sin viaje en curso ve las ofertas', () => {
    const offers = [ride({ id: 'r2', status: 'requested' })];
    expect(Taxi.driverView(null, offers)).toMatchObject({ mode: 'offers', ride: null });
    expect(Taxi.driverView(null, offers).offers).toHaveLength(1);
  });

  it('un viaje ya terminado no bloquea las ofertas', () => {
    const view = Taxi.driverView(ride({ status: 'completed' }), [ride({ id: 'r2' })]);
    expect(view.mode).toBe('offers');
  });

  it('lo cobrado esta noche sale por moneda, y en cero cuando no hay nada', () => {
    expect(Taxi.tonightTotal([{ currency: 'MXN', rides: 3, charged: '540.00' }], 'MXN'))
      .toEqual({ rides: 3, charged: '540.00', currency: 'MXN' });
    expect(Taxi.tonightTotal([], 'MXN')).toEqual({ rides: 0, charged: '0.00', currency: 'MXN' });
    expect(Taxi.tonightTotal(null, 'MXN').rides).toBe(0);
  });
});

// ---------------------------------------------------------------- eventos

describe('Qué hacer con un evento del socket', () => {
  const event = (eventType, payload) => ({ type: 'event', event_type: eventType, payload });

  it('lee el tipo de `event_type`, no de `type`', () => {
    // `type` siempre vale 'event': es la clase de trama, no el evento.
    expect(Taxi.applyEvent(ride(), event('taxi_assigned', { ride_id: 'r1' })).changed).toBe(true);
    expect(Taxi.applyEvent(ride(), { type: 'taxi_assigned', payload: { ride_id: 'r1' } }).changed)
      .toBe(true);
  });

  it('ante un cambio de viaje, se vuelve a pedir: el evento no trae el coche', () => {
    const r = Taxi.applyEvent(ride(), event('taxi_driver_arrived', { ride_id: 'r1' }));
    expect(r).toMatchObject({ changed: true, refreshRide: 'r1', status: 'driver_arrived' });
  });

  it('deduce el estado del tipo cuando el mensaje no lo trae', () => {
    expect(Taxi.applyEvent(ride(), event('taxi_started', { ride_id: 'r1' })).status)
      .toBe('in_progress');
    expect(Taxi.applyEvent(ride(), event('taxi_completed', { ride_id: 'r1' })).status)
      .toBe('completed');
    expect(Taxi.applyEvent(ride(), event('taxi_no_driver', { ride_id: 'r1' })).status)
      .toBe('no_driver');
  });

  it('el evento de OTRO viaje no toca el que se está mostrando', () => {
    // El conductor y el gerente ven varios; la pantalla del cliente, uno solo.
    expect(Taxi.applyEvent(ride({ id: 'r1' }), event('taxi_cancelled', { ride_id: 'otro' })))
      .toEqual({ changed: false });
  });

  it('sin viaje en pantalla, cualquier viaje puede ser el nuestro recién creado', () => {
    expect(Taxi.applyEvent(null, event('taxi_assigned', { ride_id: 'r9' })))
      .toMatchObject({ changed: true, refreshRide: 'r9' });
  });

  it('un cambio de disponibilidad refresca el estado, no el viaje', () => {
    expect(Taxi.applyEvent(null, event('taxi_driver_availability', {})))
      .toEqual({ changed: true, refreshAvailability: true });
  });

  it('una solicitud nueva refresca las ofertas del conductor', () => {
    expect(Taxi.applyEvent(null, event('taxi_requested', { ride_id: 'r5' })))
      .toEqual({ changed: true, refreshOffers: true });
  });

  it('los eventos que no son de taxi no tocan nada', () => {
    for (const t of ['order_ready', 'table_updated', 'flirt_received', undefined]) {
      expect(Taxi.applyEvent(ride(), event(t, { ride_id: 'r1' })).changed).toBe(false);
    }
    expect(Taxi.applyEvent(ride(), null).changed).toBe(false);
  });

  it('un evento de viaje sin id se ignora en vez de refrescar a ciegas', () => {
    expect(Taxi.applyEvent(ride(), event('taxi_assigned', {})).changed).toBe(false);
  });
});
