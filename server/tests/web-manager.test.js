'use strict';

// El panel del gerente. Lo que se equivoca sin que se note: la caja de la noche
// (contar como ingreso del club lo que es de un empleado o de un conductor), si un
// conductor puede trabajar, y cuántos cajones se dieron de alta de verdad.

const M = require('../../web/js/manager.js');

// ---------------------------------------------------------------- la caja

describe('La caja de la noche', () => {
  const rows = [{
    currency: 'MXN', total: '12500.00', count: 84, to_staff: '3200.00', to_drivers: '900.00',
  }, {
    currency: 'USD', total: '300.00', count: 4, to_staff: '50.00', to_drivers: '0.00',
  }];

  it('separa lo del club de lo de los empleados y los conductores', () => {
    // Una propina es del empleado y un viaje del conductor: pasan por el libro mayor
    // para auditar la noche, no porque sean ingreso del club. Sumarlos infla la caja.
    const r = M.revenueFor(rows, 'MXN');
    expect(r.club).toBe('12500.00');
    expect(r.staff).toBe('3200.00');
    expect(r.drivers).toBe('900.00');
    expect(r.currency).toBe('MXN');
  });

  it('cada moneda por separado, sin mezclar pesos con dólares', () => {
    expect(M.revenueFor(rows, 'USD').club).toBe('300.00');
    expect(M.currenciesIn(rows)).toEqual(['MXN', 'USD']);
  });

  it('una moneda que no hubo esta noche no inventa un total', () => {
    // Cae a la primera que sí existe, en vez de mostrar ceros que parecen "no hubo venta".
    expect(M.revenueFor(rows, 'EUR').currency).toBe('MXN');
  });

  it('una noche sin ventas muestra ceros, no huecos', () => {
    const r = M.revenueFor([], 'MXN');
    expect(r).toMatchObject({ club: '0.00', staff: '0.00', drivers: '0.00', count: 0 });
    expect(M.revenueFor(null, 'MXN').club).toBe('0.00');
    expect(M.currenciesIn(null)).toEqual([]);
  });
});

describe('El resumen del turno', () => {
  const dashboard = {
    tables: { total: 55, occupied: 22, available: 30, reserved: 3 },
    orders: { in_progress: 4, ready: 2, delivered_today: 61, pos_errors: 1 },
    revenue_today: [{ currency: 'MXN', total: '12500.00', count: 84, to_staff: '3200.00', to_drivers: '900.00' }],
    staff: { on_shift: 9 },
  };

  it('la ocupación sale en porcentaje además del conteo', () => {
    const s = M.summary(dashboard, 'MXN');
    expect(s.occupancy).toEqual({ occupied: 22, total: 55, pct: 40 });
  });

  it('los pedidos que la caja rechazó se cuentan aparte: no se sirven solos', () => {
    expect(M.summary(dashboard, 'MXN').orders.posErrors).toBe(1);
  });

  it('un club sin mesas no da NaN ni divide entre cero', () => {
    const s = M.summary({ tables: { total: 0, occupied: 0 } }, 'MXN');
    expect(s.occupancy.pct).toBe(0);
    expect(Number.isNaN(s.occupancy.pct)).toBe(false);
  });

  it('un panel vacío no rompe la pantalla', () => {
    const s = M.summary(null, 'MXN');
    expect(s.occupancy.total).toBe(0);
    expect(s.staffOnShift).toBe(0);
    expect(s.money.club).toBe('0.00');
  });

  it('el porcentaje redondea, y nunca pasa de lo que hay', () => {
    expect(M.pct(1, 3)).toBe(33);
    expect(M.pct(2, 3)).toBe(67);
    expect(M.pct(5, 0)).toBe(0);
    expect(M.pct(null, 10)).toBe(0);
  });
});

// ---------------------------------------------------------------- conductores

describe('El estado de un conductor', () => {
  const driver = (over = {}) => Object.assign({
    id: 'd1', active: true, trusted: true, availability: 'off', at_venue: false,
    vehicle_plate: 'ABC-123', vehicle_color: 'blanco', vehicle_make: 'Nissan', vehicle_model: 'Versa',
  }, over);

  it('dado de baja, sin verificar y no disponible son tres cosas distintas', () => {
    // Se confunden todo el tiempo, y la diferencia decide si el conductor trabaja.
    expect(M.driverState(driver({ active: false }))).toBe('inactive');
    expect(M.driverState(driver({ trusted: false }))).toBe('unverified');
    expect(M.driverState(driver({ availability: 'off' }))).toBe('off');
  });

  it('distingue estar disponible de estar parado en la salida', () => {
    expect(M.driverState(driver({ availability: 'available', at_venue: false }))).toBe('available');
    expect(M.driverState(driver({ availability: 'available', at_venue: true }))).toBe('atVenue');
    expect(M.driverState(driver({ availability: 'on_trip' }))).toBe('onTrip');
  });

  it('la baja gana sobre todo lo demás', () => {
    // Un conductor dado de baja que quedó "disponible" en la base no debe verse verde.
    expect(M.driverState(driver({ active: false, availability: 'available' }))).toBe('inactive');
  });

  it('solo un conductor activo Y verificado recibe solicitudes', () => {
    // Misma condición que aplica el servidor al listar ofertas.
    expect(M.canReceiveRides(driver())).toBe(true);
    expect(M.canReceiveRides(driver({ trusted: false }))).toBe(false);
    expect(M.canReceiveRides(driver({ active: false }))).toBe(false);
    expect(M.canReceiveRides(null)).toBe(false);
  });

  it('el coche se lee como se reconoce: color, modelo, placa', () => {
    expect(M.vehicleOf(driver())).toBe('blanco Nissan Versa · ABC-123');
    expect(M.vehicleOf(driver({ vehicle_color: null, vehicle_make: null, vehicle_model: null })))
      .toBe('ABC-123');
    expect(M.vehicleOf({})).toBe(null);
  });
});

describe('Antes de dar de alta a un conductor', () => {
  const NOW = Date.parse('2026-09-06T12:00:00Z');
  const form = (over = {}) => Object.assign({
    first_name: 'Luis', last_name: 'Pérez', email: 'luis@taxis.mx',
    phone: '+526311234567', vehicle_plate: 'ABC-123', birth_date: '1985-04-12',
  }, over);

  it('un formulario completo pasa', () => {
    expect(M.validateDriver(form(), NOW)).toEqual({});
  });

  it('señala el campo, no da un error genérico', () => {
    expect(M.validateDriver(form({ first_name: '  ' }), NOW)).toHaveProperty('first_name');
    expect(M.validateDriver(form({ email: 'luis@' }), NOW)).toHaveProperty('email');
    expect(M.validateDriver(form({ phone: '123' }), NOW)).toHaveProperty('phone');
    expect(M.validateDriver(form({ vehicle_plate: 'AB' }), NOW)).toHaveProperty('vehicle_plate');
  });

  it('un menor de edad se rechaza aquí, con el motivo', () => {
    // El servidor también lo comprueba; decirlo antes evita perder el formulario lleno.
    const errors = M.validateDriver(form({ birth_date: '2010-01-01' }), NOW);
    expect(errors.birth_date).toBe('manager.errUnderage');
  });

  it('cumplir 18 hoy cuenta como mayor de edad', () => {
    expect(M.validateDriver(form({ birth_date: '2008-09-06' }), NOW)).toEqual({});
    // Un día después de hoy, todavía no.
    expect(M.validateDriver(form({ birth_date: '2008-09-07' }), NOW))
      .toHaveProperty('birth_date', 'manager.errUnderage');
  });

  it('una fecha inservible se distingue de una edad insuficiente', () => {
    expect(M.validateDriver(form({ birth_date: '12/04/1985' }), NOW).birth_date)
      .toBe('manager.errDate');
    expect(M.validateDriver(form({ birth_date: '' }), NOW).birth_date).toBe('manager.errDate');
  });

  it('la edad no se desfasa por el mes', () => {
    expect(M.yearsSince('1985-04-12', Date.parse('2026-04-11T12:00:00Z'))).toBe(40);
    expect(M.yearsSince('1985-04-12', Date.parse('2026-04-12T12:00:00Z'))).toBe(41);
    expect(M.yearsSince('no es fecha', NOW)).toBe(null);
  });
});

// ---------------------------------------------------------------- cajones

describe('Dar de alta los cajones', () => {
  it('acepta una lista suelta', () => {
    const { spots, invalid } = M.parseSpots('A1, A2, A3');
    expect(spots.map((s) => s.code)).toEqual(['A1', 'A2', 'A3']);
    expect(invalid).toEqual([]);
  });

  it('acepta saltos de línea, que es como se pega desde una hoja', () => {
    expect(M.parseSpots('B1\nB2\nB3').spots).toHaveLength(3);
  });

  it('expande un rango: nadie teclea cien cajones de uno en uno', () => {
    const { spots } = M.parseSpots('A1-A20');
    expect(spots).toHaveLength(20);
    expect(spots[0].code).toBe('A1');
    expect(spots[19].code).toBe('A20');
  });

  it('respeta los ceros a la izquierda si los escribió así', () => {
    // "A01-A03" es una numeración, no una cuenta: A1 y A01 no son el mismo cajón.
    expect(M.parseSpots('A01-A03').spots.map((s) => s.code)).toEqual(['A01', 'A02', 'A03']);
  });

  it('un rango sin letra también sirve', () => {
    expect(M.parseSpots('1-5').spots.map((s) => s.code)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('lo que NO se entiende se devuelve, no se tira en silencio', () => {
    // Si el gerente pega cien y se dan de alta noventa, tiene que enterarse.
    const { spots, invalid } = M.parseSpots('A1, ?????????????????????????, A2');
    expect(spots.map((s) => s.code)).toEqual(['A1', 'A2']);
    expect(invalid).toHaveLength(1);
  });

  it('un rango al revés es un dedazo, no una intención', () => {
    const { spots, invalid } = M.parseSpots('A20-A1');
    expect(spots).toHaveLength(0);
    expect(invalid).toEqual(['A20-A1']);
  });

  it('un rango descomunal no cuelga el navegador', () => {
    const { spots, invalid } = M.parseSpots('A1-A99999');
    expect(spots).toHaveLength(0);
    expect(invalid).toHaveLength(1);
  });

  it('repetidos en la misma pegada no se duplican', () => {
    expect(M.parseSpots('A1, a1, A1').spots).toHaveLength(1);
  });

  it('normaliza a mayúsculas para que A1 y a1 no sean dos cajones', () => {
    expect(M.parseSpots('a1').spots[0].code).toBe('A1');
  });

  it('la zona se aplica a todos, y sin zona no se manda el campo vacío', () => {
    expect(M.parseSpots('A1-A3', 'Techado').spots.every((s) => s.zone === 'Techado')).toBe(true);
    expect(M.parseSpots('A1').spots[0]).toEqual({ code: 'A1' });
    expect(M.parseSpots('A1', '   ').spots[0]).toEqual({ code: 'A1' });
  });

  it('un texto vacío no da de alta nada', () => {
    expect(M.parseSpots('').spots).toEqual([]);
    expect(M.parseSpots(null).spots).toEqual([]);
    expect(M.parseSpots('  ,  ,  ').spots).toEqual([]);
  });
});

describe('Ocupación del estacionamiento', () => {
  it('libres es lo que queda, y el porcentaje redondea', () => {
    expect(M.occupancy({ total: 12, occupied: 5 })).toEqual({
      total: 12, occupied: 5, free: 7, pct: 42,
    });
  });

  it('sin cajones dados de alta no divide entre cero', () => {
    expect(M.occupancy({ total: 0, occupied: 0 })).toEqual({ total: 0, occupied: 0, free: 0, pct: 0 });
    expect(M.occupancy(null).pct).toBe(0);
  });

  it('más ocupados que cajones no da libres negativos', () => {
    // Puede pasar si se da de baja un cajón con un coche adentro.
    expect(M.occupancy({ total: 2, occupied: 3 }).free).toBe(0);
  });
});

// ---------------------------------------------------------------- contraseñas temporales

describe('La contraseña temporal', () => {
  it('se guarda hasta que el gerente la descarta', () => {
    // El servidor la devuelve UNA vez: si la pantalla la pierde, hay que reiniciarla.
    const box = M.createSecretBox();
    box.hold('Luis Pérez', 'temporal-123');
    expect(box.peek()).toMatchObject({ who: 'Luis Pérez', password: 'temporal-123' });
    box.clear();
    expect(box.peek()).toBe(null);
  });

  it('una respuesta sin contraseña no borra la que está en pantalla', () => {
    const box = M.createSecretBox();
    box.hold('Luis', 'temporal-123');
    box.hold('Otro', undefined);
    expect(box.peek().password).toBe('temporal-123');
  });

  it('arranca vacía', () => {
    expect(M.createSecretBox().peek()).toBe(null);
  });
});

// --------------------------------------------------------------------- noches

describe('Las noches del club', () => {
  const NOW = '2026-09-05T12:00:00Z';
  const nights = [
    { id: 'a', name: 'Sábado', status: 'published', doors_open_at: '2026-09-13T02:00:00Z', reservations_count: 4 },
    { id: 'b', name: 'Viernes', status: 'draft', doors_open_at: '2026-09-06T02:00:00Z', reservations_count: 0 },
    { id: 'c', name: 'Pasada', status: 'finished', doors_open_at: '2026-09-01T02:00:00Z', reservations_count: 9 },
    { id: 'd', name: 'Más vieja', status: 'finished', doors_open_at: '2026-08-25T02:00:00Z', reservations_count: 2 },
  ];

  it('pone primero lo que viene, y el historial hacia atrás', () => {
    // La noche que hay que publicar no puede quedar enterrada entre las que ya pasaron.
    expect(M.sortNights(nights, NOW).map((e) => e.id)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('ignora filas sin id', () => {
    expect(M.sortNights([null, {}, nights[0]], NOW)).toHaveLength(1);
  });

  it('una noche en borrador se publica; una publicada con reservaciones ya no se despublica', () => {
    expect(M.nightActions(nights[1])).toMatchObject({ canPublish: true, canCancel: true, canDelete: true });
    expect(M.nightActions(nights[0])).toMatchObject({ canPublish: false, canUnpublish: false, canCancel: true });
  });

  it('una noche publicada SIN reservaciones sí se puede regresar a borrador', () => {
    expect(M.nightActions({ status: 'published', reservations_count: 0 }).canUnpublish).toBe(true);
  });

  it('una noche con reservaciones vivas no se borra: se cancela', () => {
    // El dinero apartado tiene que seguir teniendo a qué apuntar.
    expect(M.nightActions(nights[0]).canDelete).toBe(false);
    expect(M.nightActions(nights[0]).canCancel).toBe(true);
  });

  it('sin evento no revienta', () => {
    expect(M.nightActions(null)).toMatchObject({ canPublish: false, booked: 0 });
  });

  const good = {
    name: 'Sábado de Halloween', event_date: '2026-10-31',
    doors_open_at: '2026-11-01T02:00:00Z', closes_at: '2026-11-01T09:00:00Z',
    ticket_price: 250,
  };

  it('acepta una noche bien capturada', () => {
    expect(M.validateNight(good, NOW)).toEqual({});
  });

  it('no deja abrir una noche que ya pasó', () => {
    expect(M.validateNight({ ...good, doors_open_at: '2026-09-01T02:00:00Z' }, NOW))
      .toMatchObject({ doors_open_at: 'night.errPast' });
  });

  it('cerrar antes de abrir se detiene aquí', () => {
    // Pasa de verdad: el club cierra a las 4 de la MAÑANA SIGUIENTE y quien captura
    // pone la misma fecha en las dos casillas.
    expect(M.validateNight({ ...good, closes_at: '2026-10-31T23:00:00Z' }, NOW))
      .toMatchObject({ closes_at: 'night.errCloses' });
  });

  it('pide lo que falta, campo por campo', () => {
    const errors = M.validateNight({ name: '  ', ticket_price: -5 }, NOW);
    expect(errors.name).toBe('night.errName');
    expect(errors.event_date).toBe('night.errDate');
    expect(errors.doors_open_at).toBe('night.errDoors');
    expect(errors.ticket_price).toBe('night.errPrice');
  });

  it('un cover de cero es válido: hay noches sin cover', () => {
    expect(M.validateNight({ ...good, ticket_price: 0 }, NOW)).toEqual({});
  });

  it('la noche se crea en BORRADOR, nunca publicada de un solo toque', () => {
    // Abrir el club por accidente al capturar es peor que pedir un toque de más.
    const body = M.nightPayload(good);
    expect(body.status).toBe('draft');
    expect(body.doors_open_at).toBe('2026-11-01T02:00:00.000Z');
    expect(body.closes_at).toBe('2026-11-01T09:00:00.000Z');
    expect(body.ticket_price).toBe(250);
  });

  it('sin hora de cierre, el campo no viaja', () => {
    expect(M.nightPayload({ ...good, closes_at: '' }).closes_at).toBeUndefined();
  });

  it('cada estado tiene su etiqueta', () => {
    expect(M.nightStatusLabel('published')).toBe('night.stPublished');
    expect(M.nightStatusLabel('cancelled')).toBe('night.stCancelled');
    expect(M.nightStatusLabel('lo-que-sea')).toBe('night.stDraft');
  });
});
