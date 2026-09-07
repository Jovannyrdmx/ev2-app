/**
 * Las decisiones de las tres pantallas que faltaban del lado del cliente: propinas,
 * canciones y reservaciones.
 *
 * Se prueban aquí porque son las tres donde un error cuesta dinero del cliente: una
 * propina con el importe equivocado, una canción cobrada dos veces, o un anticipo que
 * no cuadra con el desglose que se le enseñó.
 */
'use strict';

const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'web', 'js');
const Tip = require(path.join(WEB, 'tipping.js'));
const Songs = require(path.join(WEB, 'songs.js'));
const Book = require(path.join(WEB, 'booking.js'));

// --------------------------------------------------------------------- propinas

describe('propinas al personal', () => {
  const dancer = {
    id: 'd1', role: 'dancer', display_name: 'Sofía', role_label: 'Bailarina',
    min_tip: '100.00', suggested: ['50.00', '100.00', '200.00', '500.00'],
    currency: 'MXN', accepts_drinks: true, started_at: '2026-09-04T23:00:00Z',
  };
  const waiter = {
    id: 'w1', role: 'waiter', display_name: 'Beto', role_label: 'Mesero',
    min_tip: '0.00', suggested: ['20.00', '50.00'], currency: 'MXN',
    accepts_drinks: false, started_at: '2026-09-04T22:00:00Z',
  };

  it('agrupa por rol y pone primero a quien el cliente tiene enfrente', () => {
    const groups = Tip.byRole([waiter, dancer, { id: 'b1', role: 'bartender', display_name: 'Ana' }]);
    expect(groups.map((g) => g.role)).toEqual(['dancer', 'waiter', 'bartender']);
    expect(groups[0].label).toBe('Bailarina');
  });

  it('dentro de un rol, ordena por nombre para que la lista no salte bajo el dedo', () => {
    const groups = Tip.byRole([
      { id: '1', role: 'dancer', display_name: 'Zoe' },
      { id: '2', role: 'dancer', display_name: 'Ana' },
      { id: '3', role: 'dancer', display_name: 'Ámbar' },
    ]);
    expect(groups[0].people.map((p) => p.display_name)).toEqual(['Ámbar', 'Ana', 'Zoe']);
  });

  it('ignora filas sin id: no se le puede dar propina a nadie', () => {
    expect(Tip.byRole([{ role: 'dancer' }, null, dancer])).toHaveLength(1);
  });

  it('NO ofrece un botón por debajo del mínimo del rol', () => {
    // El club pide 100 de mínimo para una bailarina; el sugerido de 50 no se enseña,
    // porque tocarlo devolvería un 422 del servidor.
    expect(Tip.presetAmounts(dancer)).toEqual(['100.00', '200.00', '500.00']);
  });

  it('si ningún sugerido llega al mínimo, ofrece el mínimo', () => {
    expect(Tip.presetAmounts({ min_tip: '150.00', suggested: ['20.00', '50.00'] }))
      .toEqual(['150.00']);
  });

  it('sin mínimo ni sugeridos, no inventa importes', () => {
    expect(Tip.presetAmounts({})).toEqual([]);
  });

  it('quita los repetidos y ordena de menor a mayor', () => {
    expect(Tip.presetAmounts({ min_tip: '0', suggested: ['100', '50', '100', '20'] }))
      .toEqual(['20.00', '50.00', '100.00']);
  });

  it('rechaza importes que el servidor rechazaría', () => {
    expect(Tip.validateTip('0', dancer)).toBe('tip.errAmount');
    expect(Tip.validateTip('-50', dancer)).toBe('tip.errAmount');
    expect(Tip.validateTip('abc', dancer)).toBe('tip.errAmount');
    expect(Tip.validateTip('99.99', dancer)).toBe('tip.errMin');
    expect(Tip.validateTip('100', dancer)).toBe(null);
    expect(Tip.validateTip('100000.01', dancer)).toBe('tip.errMax');
  });

  it('el mínimo se compara en centavos, no en float', () => {
    // 0.1 + 0.2 !== 0.3 en float: con un mínimo de 0.30 y una propina de 0.30 esto
    // tiene que pasar.
    expect(Tip.validateTip('0.30', { min_tip: '0.30' })).toBe(null);
    expect(Tip.validateTip('0.29', { min_tip: '0.30' })).toBe('tip.errMin');
  });

  it('el cuerpo de la propina lleva el importe con dos decimales', () => {
    const body = Tip.tipPayload(dancer, '200', { clientRequestId: 'req-1', message: '  bravo  ' });
    expect(body).toEqual({
      client_request_id: 'req-1', to_user_id: 'd1', amount: 200,
      currency: 'MXN', anonymous: false, message: 'bravo',
    });
  });

  it('un mensaje vacío no viaja', () => {
    expect(Tip.tipPayload(dancer, '100', { clientRequestId: 'r', message: '   ' }).message)
      .toBeUndefined();
  });

  it('el mensaje se corta a lo que el servidor acepta', () => {
    const body = Tip.tipPayload(dancer, '100', { clientRequestId: 'r', message: 'x'.repeat(400) });
    expect(body.message).toHaveLength(280);
  });

  it('dice por qué no se puede invitar un trago, y cada motivo es distinto', () => {
    const table = { id: 't1', code: 'A1' };
    expect(Tip.drinkBlocker(waiter, table)).toBe('tip.errNoDrinks');
    expect(Tip.drinkBlocker({ ...dancer, started_at: null }, table)).toBe('tip.errOffShift');
    expect(Tip.drinkBlocker(dancer, null)).toBe('tip.errNoTable');
    expect(Tip.drinkBlocker(dancer, table)).toBe(null);
  });

  it('la cantidad de tragos se queda dentro de lo que el servidor acepta', () => {
    expect(Tip.drinkPayload('dr1', { clientRequestId: 'r', quantity: 0 }).quantity).toBe(1);
    expect(Tip.drinkPayload('dr1', { clientRequestId: 'r', quantity: 99 }).quantity).toBe(5);
    expect(Tip.drinkPayload('dr1', { clientRequestId: 'r' }).quantity).toBe(1);
  });

  it('suma lo dado por moneda y no cuenta las canceladas', () => {
    const totals = Tip.givenTotals([
      { amount: '100.00', currency: 'MXN', status: 'paid' },
      { amount: '50.50', currency: 'MXN', status: 'pending' },
      { amount: '999.00', currency: 'MXN', status: 'cancelled' },
      { amount: '20.00', currency: 'USD', status: 'paid' },
    ]);
    expect(totals).toEqual([
      { currency: 'MXN', amount: '150.50' },
      { currency: 'USD', amount: '20.00' },
    ]);
  });

  it('reconoce los eventos del socket por event_type, no por type', () => {
    // El marco real es { type: 'event', event_type: 'tip_received', ... }. Leer `type`
    // deja la pantalla muda.
    expect(Tip.affectsTips({ type: 'event', event_type: 'tip_received' })).toBe(true);
    expect(Tip.affectsTips({ type: 'event', event_type: 'shift_started' })).toBe(true);
    expect(Tip.affectsTips({ type: 'event', event_type: 'order_ready' })).toBe(false);
    expect(Tip.affectsTips({ type: 'event' })).toBe(false);
    expect(Tip.affectsTips(null)).toBe(false);
  });

  // ------------------------------------------------------------------ pestañas

  it('una pestaña por rol con gente en turno, en el orden de la lista', () => {
    const tabs = Tip.roleTabs([waiter, dancer, { id: 'b1', role: 'bartender', display_name: 'Ana' }]);
    expect(tabs).toEqual([
      { key: 'dancer', label: 'Bailarina', count: 1 },
      { key: 'waiter', label: 'Mesero', count: 1 },
      { key: 'bartender', label: 'bartender', count: 1 },
    ]);
  });

  it('cuenta cuánta gente hay de cada rol', () => {
    const tabs = Tip.roleTabs([
      { id: '1', role: 'dancer', display_name: 'Ana' },
      { id: '2', role: 'dancer', display_name: 'Zoe' },
      { id: '3', role: 'dj', display_name: 'Beto' },
    ]);
    expect(tabs).toEqual([
      { key: 'dancer', label: 'dancer', count: 2 },
      { key: 'dj', label: 'dj', count: 1 },
    ]);
  });

  it('sin nadie en turno no hay ninguna pestaña de rol', () => {
    expect(Tip.roleTabs([])).toEqual([]);
    expect(Tip.roleTabs([{ role: 'dancer' }, null])).toEqual([]);
  });

  // ------------------------------------------------------------------ reconocimiento

  it('normaliza el leaderboard del cliente: puesto, nombre, rol y cuántos lo reconocieron', () => {
    const rows = Tip.boardRows({
      leaderboard: [
        { rank: 1, user_id: 'u1', display_name: 'Sofía', role: 'dancer', fans: 8 },
        { rank: 2, user_id: 'u2', display_name: 'Beto', role: 'dj', fans: 3 },
      ],
    });
    expect(rows).toEqual([
      { rank: 1, userId: 'u1', name: 'Sofía', role: 'dancer', fans: 8 },
      { rank: 2, userId: 'u2', name: 'Beto', role: 'dj', fans: 3 },
    ]);
  });

  it('si no viene el puesto, lo deduce de la posición', () => {
    const rows = Tip.boardRows({ leaderboard: [{ user_id: 'u1' }, { user_id: 'u2' }] });
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(rows[0]).toEqual({ rank: 1, userId: 'u1', name: '', role: null, fans: 0 });
  });

  it('descarta filas sin persona y aguanta una respuesta vacía', () => {
    expect(Tip.boardRows({ leaderboard: [{ display_name: 'nadie' }, null] })).toEqual([]);
    expect(Tip.boardRows({})).toEqual([]);
    expect(Tip.boardRows(null)).toEqual([]);
  });

  it('ignora los montos aunque lleguen: esta es la vista del cliente', () => {
    const rows = Tip.boardRows({
      leaderboard: [{ rank: 1, user_id: 'u1', display_name: 'Sofía', role: 'dancer', fans: 8, total_mxn: '9999.00', tips_count: 40 }],
    });
    expect(rows[0]).not.toHaveProperty('total_mxn');
    expect(rows[0]).not.toHaveProperty('tips_count');
  });
});

// --------------------------------------------------------------------- canciones

describe('pedir canción y cola del DJ', () => {
  const queue = [
    { id: 's1', song_title: 'Amorfoda', artist: 'Bad Bunny', status: 'requested', votes: 5, tips_total: '0.00', created_at: '2026-09-04T23:10:00Z', requesters: [{ user_id: 'u9', name: 'Ana' }] },
    { id: 's2', song_title: 'La Bilirrubina', artist: 'Juan Luis Guerra', status: 'requested', votes: 5, tips_total: '300.00', created_at: '2026-09-04T23:20:00Z', requesters: [] },
    { id: 's3', song_title: 'Rayando el Sol', artist: 'Maná', status: 'requested', votes: 2, tips_total: '0.00', created_at: '2026-09-04T23:00:00Z', requesters: [] },
    { id: 's4', song_title: 'Vieja', artist: 'X', status: 'played', votes: 9, tips_total: '0.00', created_at: '2026-09-04T22:00:00Z', requesters: [] },
  ];

  it('arma la misma llave que el servidor: sin acentos y sin puntuación', () => {
    expect(Songs.normalizeKey('Canción de Amór', 'Café Tacvba')).toBe('cancion de amor|cafe tacvba');
    expect(Songs.normalizeKey('  LA   bilirrubina!! ', 'Juan-Luis Guerra'))
      .toBe('la bilirrubina|juan luis guerra');
  });

  it('encuentra la misma canción aunque venga escrita distinto', () => {
    expect(Songs.findSame(queue, 'la bilirrubina', 'juan luis guerra').id).toBe('s2');
    expect(Songs.findSame(queue, 'LA BILIRRUBINA!!', 'Juan Luis Guerra').id).toBe('s2');
  });

  it('una canción que ya sonó no bloquea: se puede volver a pedir', () => {
    expect(Songs.findSame(queue, 'Vieja', 'X')).toBe(null);
  });

  it('con título vacío no encuentra nada en vez de emparejar con todo', () => {
    expect(Songs.findSame(queue, '', '')).toBe(null);
  });

  it('ordena por votos, luego propina, luego antigüedad — igual que el servidor', () => {
    // s1 y s2 empatan a 5 votos: gana la que trae propina. s3 va al final por votos.
    expect(Songs.pending(queue).map((s) => s.id)).toEqual(['s2', 's1', 's3']);
  });

  it('no muta la lista que recibe', () => {
    const copy = queue.slice();
    Songs.ranked(queue);
    expect(queue).toEqual(copy);
  });

  it('dice en qué lugar va una canción, contando desde 1', () => {
    expect(Songs.positionOf(queue, 's2')).toBe(1);
    expect(Songs.positionOf(queue, 's3')).toBe(3);
    expect(Songs.positionOf(queue, 's4')).toBe(0);
    expect(Songs.positionOf(queue, 'nope')).toBe(0);
  });

  it('reconoce mi voto tanto por i_voted (invitado) como por user_id (personal)', () => {
    expect(Songs.iVoted({ i_voted: true }, 'u1')).toBe(true);
    expect(Songs.iVoted({ i_voted: false, requesters: [{ user_id: 'u1' }] }, 'u1')).toBe(false);
    expect(Songs.iVoted(queue[0], 'u9')).toBe(true);
    expect(Songs.iVoted(queue[0], 'u1')).toBe(false);
    expect(Songs.iVoted(null, 'u1')).toBe(false);
  });

  it('decide entre pedir, votar y explicar', () => {
    expect(Songs.planRequest(queue, 'Nueva', 'Alguien', 'u1').action).toBe('request');

    const vote = Songs.planRequest(queue, 'la bilirrubina', 'juan luis guerra', 'u1');
    expect(vote.action).toBe('vote');
    expect(vote.song.id).toBe('s2');

    const already = Songs.planRequest(queue, 'Amorfoda', 'Bad Bunny', 'u9');
    expect(already).toMatchObject({ action: 'blocked', reason: 'song.errAlready' });
    expect(already.song.id).toBe('s1');

    expect(Songs.planRequest(queue, '   ', '', 'u1'))
      .toMatchObject({ action: 'blocked', reason: 'song.errTitle' });
  });

  it('sin DJ en turno lo dice aquí, no con un 422 después de escribir la canción', () => {
    expect(Songs.requestBlocker([])).toBe('song.errNoDj');
    expect(Songs.requestBlocker(null)).toBe('song.errNoDj');
    expect(Songs.requestBlocker([{ id: 'dj1' }])).toBe(null);
  });

  it('el cuerpo lleva la propina en pesos con dos decimales, y 0 si no hubo', () => {
    expect(Songs.requestPayload('  Tema  ', '  Grupo ', { clientRequestId: 'r1' }))
      .toEqual({
        client_request_id: 'r1', song_title: 'Tema', artist: 'Grupo',
        tip_amount: 0, currency: 'MXN', anonymous_tip: false,
      });
    expect(Songs.requestPayload('Tema', '', { clientRequestId: 'r1', tipAmount: '150.5' }))
      .toMatchObject({ tip_amount: 150.5 });
    expect(Songs.requestPayload('Tema', '', { clientRequestId: 'r1' }).artist).toBeUndefined();
  });

  it('el resumen del DJ cuenta solo las que faltan y redondea la espera hacia arriba', () => {
    const s = Songs.djSummary(queue, '2026-09-04T23:21:30Z');
    expect(s.waiting).toBe(3);
    expect(s.votes).toBe(12);
    expect(s.tips).toBe('300.00');
    // La más vieja pendiente es s3 (23:00): 21.5 minutos → 22.
    expect(s.oldestMinutes).toBe(22);
  });

  it('con la cola vacía el resumen no se rompe', () => {
    expect(Songs.djSummary([], '2026-09-04T23:00:00Z'))
      .toEqual({ waiting: 0, votes: 0, tips: '0.00', oldestMinutes: 0 });
  });

  it('reconoce los eventos del socket por event_type', () => {
    expect(Songs.affectsSongs({ type: 'event', event_type: 'song_requested' })).toBe(true);
    expect(Songs.affectsSongs({ type: 'event', event_type: 'song_played' })).toBe(true);
    expect(Songs.affectsSongs({ type: 'event', event_type: 'tip_received' })).toBe(false);
    expect(Songs.affectsSongs(null)).toBe(false);
  });
});

// --------------------------------------------------------------------- reservaciones

describe('reservación de mesa', () => {
  const NOW = '2026-09-05T12:00:00Z';
  const events = [
    { id: 'e1', name: 'Sábado', status: 'published', event_date: '2026-09-12', doors_open_at: '2026-09-13T02:00:00Z' },
    { id: 'e2', name: 'Viernes', status: 'published', event_date: '2026-09-05', doors_open_at: '2026-09-06T02:00:00Z' },
    { id: 'e3', name: 'Cancelado', status: 'cancelled', event_date: '2026-09-06', doors_open_at: '2026-09-07T02:00:00Z' },
    { id: 'e4', name: 'Pasado', status: 'published', event_date: '2026-09-01', doors_open_at: '2026-09-02T02:00:00Z' },
  ];

  it('enseña solo las noches que todavía se pueden reservar, la más cercana primero', () => {
    expect(Book.bookableEvents(events, NOW).map((e) => e.id)).toEqual(['e2', 'e1']);
  });

  it('una noche sin hora de apertura no se descarta por eso', () => {
    expect(Book.bookableEvents([{ id: 'x', status: 'published' }], NOW).map((e) => e.id))
      .toEqual(['x']);
  });

  it('sabe si esa noche ya cerró para reservar', () => {
    // e2 abre en 14 horas: con 12 de anticipación mínima aún se puede, con 24 no.
    expect(Book.isOpenForBooking(events[1], 12, NOW)).toBe(true);
    expect(Book.isOpenForBooking(events[1], 24, NOW)).toBe(false);
  });

  const tables = [
    { id: 't1', code: 'A1', section: 'ZONA ROJA', price: '8000.00', table_number: 1 },
    { id: 't2', code: 'B1', section: 'ZONA AZUL', price: '3000.00', table_number: 2 },
    { id: 't3', code: 'B2', section: 'ZONA AZUL', price: '3000.00', table_number: 3 },
    { id: 't4', code: 'C1', section: 'ZONA DIAMANTE', price: '12000.00', table_number: 4 },
  ];

  it('enseña primero la mesa más barata: el cliente está decidiendo cuánto gastar', () => {
    expect(Book.tablesByPrice(tables).map((t) => t.id)).toEqual(['t2', 't3', 't1', 't4']);
  });

  it('a igual precio respeta el orden del servidor, para que la lista no salte', () => {
    expect(Book.tablesByPrice(tables).slice(0, 2).map((t) => t.id)).toEqual(['t2', 't3']);
  });

  it('agrupa por zona, de la más barata a la más cara', () => {
    const zones = Book.tablesByZone(tables);
    expect(zones.map((z) => z.section)).toEqual(['ZONA AZUL', 'ZONA ROJA', 'ZONA DIAMANTE']);
    expect(zones[0].tables).toHaveLength(2);
    expect(zones[0].from).toBe('3000.00');
  });

  it('calcula el anticipo con el porcentaje del club', () => {
    expect(Book.depositFor('3000.00', 30)).toBe('900.00');
    expect(Book.depositFor('3333.33', 30)).toBe('1000.00');
    expect(Book.depositFor('3000.00', 0)).toBe('0.00');
    expect(Book.depositFor('3000.00', null)).toBe('0.00');
  });

  const quote = {
    zone: { section: 'ZONA AZUL', display_name: 'Zona Azul', base_price: 3000, included_tickets: 10, max_extras: 2 },
    guests: 12,
    extra_guests: 2,
    ticket_price: 400,
    extras_total: 800,
    addons: [{ code: 'BOT-01', name: 'Botella Buchanan’s', price: 2500, quantity: 1 }],
    addons_total: 2500,
    subtotal: 6300,
    discount: { code: 'AMIGOS', type: 'percentage', value: 10, amount: 630 },
    total: 5670,
    deposit: 1701,
    deposit_pct: 30,
    currency: 'MXN',
  };

  it('el desglose enseña de dónde sale cada peso, y suma al total', () => {
    const lines = Book.quoteLines(quote);
    expect(lines.map((l) => [l.key, l.amount])).toEqual([
      ['book.lineTable', '3000.00'],
      ['book.lineExtras', '800.00'],
      ['book.lineAddon', '2500.00'],
      ['book.lineDiscount', '-630.00'],
    ]);
    const sum = lines.reduce((acc, l) => acc + Book.cents(l.amount), 0);
    expect(Book.money(sum)).toBe('5670.00');
  });

  it('el renglón de la mesa sale de zone.base_price, no de un campo suelto', () => {
    // Leerlo del lugar equivocado dejaría el renglón principal en cero y el desglose
    // no cuadraría con el cargo.
    expect(Book.quoteLines(quote)[0].amount).toBe('3000.00');
    expect(Book.quoteLines({ ...quote, zone: null })[0].key).not.toBe('book.lineTable');
  });

  it('no enseña renglones en cero', () => {
    const sinExtras = Book.quoteLines({ ...quote, extra_guests: 0, extras_total: 0 });
    expect(sinExtras.some((l) => l.key === 'book.lineExtras')).toBe(false);
  });

  it('separa lo que se paga hoy de lo que queda para la noche', () => {
    expect(Book.payNow(quote)).toEqual({
      deposit: '1701.00', rest: '3969.00', total: '5670.00', currency: 'MXN',
    });
  });

  it('un anticipo mayor que el total no deja un resto negativo', () => {
    expect(Book.payNow({ total: 100, deposit: 500, currency: 'MXN' }))
      .toEqual({ deposit: '100.00', rest: '0.00', total: '100.00', currency: 'MXN' });
  });

  it('sin cotización devuelve ceros en vez de romperse', () => {
    expect(Book.payNow(null).total).toBe('0.00');
    expect(Book.quoteLines(null)).toEqual([]);
  });

  const rules = { min_party_size: 4, min_advance_hours: 12 };

  it('dice por qué no se puede reservar, y cada motivo manda a un lugar distinto', () => {
    const ok = { event: events[1], table: tables[1], guests: 10 };
    expect(Book.bookingBlocker(ok, rules, NOW)).toBe(null);
    expect(Book.bookingBlocker({ ...ok, event: null }, rules, NOW)).toBe('book.errNoEvent');
    expect(Book.bookingBlocker({ ...ok, table: null }, rules, NOW)).toBe('book.errNoTable');
    expect(Book.bookingBlocker({ ...ok, guests: 0 }, rules, NOW)).toBe('book.errGuests');
    expect(Book.bookingBlocker({ ...ok, guests: 2.5 }, rules, NOW)).toBe('book.errGuests');
    expect(Book.bookingBlocker({ ...ok, guests: 2 }, rules, NOW)).toBe('book.errMinParty');
    expect(Book.bookingBlocker(ok, { ...rules, min_advance_hours: 48 }, NOW)).toBe('book.errClosed');
  });

  it('el cuerpo de la reservación NO lleva el precio: lo pone el servidor', () => {
    const body = Book.bookingPayload(
      { event: events[1], table: tables[1], guests: 10, notes: ' cumpleaños ', discountCode: ' amigos ' },
      { clientRequestId: 'r1' });
    expect(body).toEqual({
      client_request_id: 'r1', event_id: 'e2', table_id: 't2', guest_count: 10,
      addons: [], special_requests: 'cumpleaños', discount_code: 'amigos',
    });
    expect(body.total).toBeUndefined();
    expect(body.price).toBeUndefined();
  });

  const mine = [
    { id: 'r1', status: 'confirmed', doors_open_at: '2026-09-13T02:00:00Z', arrival_deadline: '2026-09-13T05:00:00Z' },
    { id: 'r2', status: 'pending_payment', doors_open_at: '2026-09-06T02:00:00Z', arrival_deadline: '2026-09-06T05:00:00Z' },
    { id: 'r3', status: 'cancelled', doors_open_at: '2026-09-07T02:00:00Z' },
    { id: 'r4', status: 'completed', doors_open_at: '2026-09-01T02:00:00Z' },
  ];

  it('las mías: solo las que siguen vivas, la más próxima primero', () => {
    expect(Book.upcoming(mine, NOW).map((r) => r.id)).toEqual(['r2', 'r1']);
  });

  it('solo ofrece cancelar lo que se puede cancelar', () => {
    expect(Book.canCancel(mine[0])).toBe(true);
    expect(Book.canCancel(mine[1])).toBe(true);
    expect(Book.canCancel({ status: 'seated' })).toBe(false);
    expect(Book.canCancel({ status: 'cancelled' })).toBe(false);
  });

  it('la cuenta regresiva de llegada redondea hacia arriba y avisa cuando venció', () => {
    const c = Book.arrivalCountdown(mine[1], '2026-09-06T04:00:30Z');
    expect(c.minutes).toBe(60);
    expect(c.expired).toBe(false);

    const late = Book.arrivalCountdown(mine[1], '2026-09-06T05:30:00Z');
    expect(late.expired).toBe(true);
    expect(late.minutes).toBeLessThanOrEqual(0);
  });

  it('sin fecha límite devuelve null en vez de una cuenta inventada', () => {
    expect(Book.arrivalCountdown({ status: 'confirmed' }, NOW)).toBe(null);
  });
});
