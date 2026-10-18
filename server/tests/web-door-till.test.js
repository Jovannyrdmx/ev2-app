/**
 * La caja de Cover en el navegador (D118): las decisiones de `web/js/door-till.js`, el
 * rol de la noche con Cover (`web/js/roster.js`), y que la pantalla de la puerta tenga
 * todo lo que su controlador usa.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const DoorTill = require(path.join(ROOT, 'js', 'door-till.js'));
const Roster = require(path.join(ROOT, 'js', 'roster.js'));
const Cut = require(path.join(ROOT, 'js', 'shift-cut.js'));
const catalogo = require(path.join(ROOT, 'js', 'format.js'));

const cerrada = { till: null, assignment: { location_id: 'c', location_kind: 'door', held_by: null } };
const abierta = { till: { location_id: 'c', location_kind: 'door', opening_float: '1000.00' }, assignment: null };
const ocupada = { till: null, assignment: { location_id: 'c', location_kind: 'door', held_by: 'Ana' } };

describe('EV2DoorTill: en qué punto está la caja de Cover', () => {
  it('la gerencia y otros puestos no cobran en la puerta', () => {
    expect(DoorTill.phase(abierta, 'manager')).toBe('not_hostess');
    expect(DoorTill.canCharge(abierta, 'admin')).toBe(false);
    expect(DoorTill.chargeBlocker(null, 'manager')).toBe('dtill.lockedStaff');
  });

  it('la anfitriona: sin Cover, Cover sin abrir, ocupada por otra, abierta', () => {
    expect(DoorTill.phase(null, 'hostess')).toBe('no_assignment');
    expect(DoorTill.phase({ till: null, assignment: null }, 'hostess')).toBe('no_assignment');
    expect(DoorTill.phase(cerrada, 'hostess')).toBe('closed');
    expect(DoorTill.phase(ocupada, 'hostess')).toBe('taken');
    expect(DoorTill.phase(abierta, 'hostess')).toBe('open');
    expect(DoorTill.canCharge(abierta, 'hostess')).toBe(true);
    expect(DoorTill.chargeBlocker(abierta, 'hostess')).toBeNull();
    expect(DoorTill.chargeBlocker(ocupada, 'hostess')).toBe('dtill.lockedTaken');
    expect(DoorTill.chargeBlocker(cerrada, 'hostess')).toBe('dtill.lockedClosed');
  });

  it('una caja abierta que no es la de la puerta no cobra en la puerta', () => {
    const deBarra = { till: { location_id: 'b', location_kind: 'bar' }, assignment: null };
    expect(DoorTill.phase(deBarra, 'hostess')).toBe('other_till');
    expect(DoorTill.canCharge(deBarra, 'hostess')).toBe(false);
  });
});

describe('EV2DoorTill: abrir la caja', () => {
  const base = { state: cerrada, role: 'hostess', amount: '1000', amountUsd: '', pin: '123456' };

  it('el fondo en pesos puede ser 0 pero no vacío; en dólares, vacío vale', () => {
    expect(DoorTill.openBlocker(base)).toBeNull();
    expect(DoorTill.openBlocker({ ...base, amount: '0' })).toBeNull();
    expect(DoorTill.openBlocker({ ...base, amount: '' })).toBe('till.errFloat');
    expect(DoorTill.openBlocker({ ...base, amount: '-5' })).toBe('till.errFloat');
    expect(DoorTill.openBlocker({ ...base, amountUsd: '-1' })).toBe('dtill.errFloatUsd');
    expect(DoorTill.openBlocker({ ...base, amountUsd: 'abc' })).toBe('dtill.errFloatUsd');
  });

  it('el código del gerente son seis dígitos, y no se abre lo que no toca', () => {
    expect(DoorTill.openBlocker({ ...base, pin: '12345' })).toBe('cut.errPin');
    expect(DoorTill.openBlocker({ ...base, state: ocupada })).toBe('dtill.lockedTaken');
    expect(DoorTill.openBlocker({ ...base, state: abierta })).toBe('till.errOpen');
    expect(DoorTill.openBlocker({ ...base, state: null })).toBe('dtill.lockedNoAssignment');
  });

  it('lo que se manda: los dólares solo si hay', () => {
    expect(DoorTill.openPayload({ amount: '1000', amountUsd: '', pin: '123456' }))
      .toEqual({ opening_float: 1000, manager_pin: '123456' });
    expect(DoorTill.openPayload({ amount: '1000.505', amountUsd: '40', pin: '123456' }))
      .toEqual({ opening_float: 1000.51, opening_float_usd: 40, manager_pin: '123456' });
    expect(DoorTill.openPayload({ amount: '0', amountUsd: '0', pin: '123456' }))
      .toEqual({ opening_float: 0, manager_pin: '123456' });
  });

  it('abrir o cortar una caja hace que la puerta vuelva a preguntar', () => {
    expect(DoorTill.affectsTill({ event_type: 'till_opened' })).toBe(true);
    expect(DoorTill.affectsTill({ type: 'shift_closed' })).toBe(true);
    expect(DoorTill.affectsTill({ type: 'door_admission' })).toBe(false);
  });
});

describe('EV2Roster: Cover en el rol de la noche', () => {
  const hostess = { id: 'h', role: 'hostess', display_name: 'Ana' };
  const bartender = { id: 'b', role: 'bartender', display_name: 'Beto' };

  it('a Cover solo va la anfitriona; a una barra, bartender y cajero', () => {
    expect(Roster.fitsTarget('hostess', { locationId: 'c', kind: 'door' })).toBe(true);
    expect(Roster.fitsTarget('bartender', { locationId: 'c', kind: 'door' })).toBe(false);
    expect(Roster.fitsTarget('cashier', { locationId: 'c', kind: 'door' })).toBe(false);
    expect(Roster.fitsTarget('hostess', { locationId: 'b', kind: 'bar' })).toBe(false);
    expect(Roster.fitsTarget('cashier', { locationId: 'b', kind: 'bar' })).toBe(true);
    expect(Roster.fitsTarget('hostess', { section: 'ZONA ROJA' })).toBe(true);
  });

  it('el aviso del rol: un bartender en Cover, o la anfitriona que ya está ahí', () => {
    expect(Roster.check({ person: bartender, locationId: 'c', locationKind: 'door' }))
      .toEqual({ code: 'door_needs_hostess' });
    expect(Roster.check({ person: hostess, locationId: 'c', locationKind: 'door' })).toBeNull();
    expect(Roster.check({
      person: hostess, locationId: 'c', locationKind: 'door',
      roster: [{ user_id: 'h', targets: [{ location_id: 'c' }] }],
    })).toEqual({ code: 'already_there', name: 'Ana' });
    // La misma anfitriona con una zona asignada sí puede ir además a Cover.
    expect(Roster.check({
      person: hostess, locationId: 'c', locationKind: 'door',
      roster: [{ user_id: 'h', targets: [{ section: 'ZONA ROJA' }] }],
    })).toBeNull();
  });

  it('Cover va al final, después de las barras', () => {
    const vista = Roster.byTarget({
      roster: [{ user_id: 'h', display_name: 'Ana', role: 'hostess',
        targets: [{ location_id: 'c', location_name: 'Cover', location_kind: 'door', assignment_id: 'a1' }] }],
      bars: [{ location_id: 'b2', name: 'Barra planta alta', kind: 'bar' },
        { location_id: 'b1', name: 'Barra planta baja', kind: 'bar' }],
    });
    expect(vista.bars.map((b) => b.name)).toEqual(['Barra planta alta', 'Barra planta baja', 'Cover']);
    expect(vista.bars[2]).toMatchObject({ kind: 'door', people: [expect.objectContaining({ display_name: 'Ana' })] });
  });
});

describe('El corte con fondo en dólares', () => {
  it('pide contar los dólares aunque no haya entrado ninguno', () => {
    const corte = {
      shift: { id: 's', location_id: 'c' }, opening_float: '1000.00', opening_float_usd: '30.00',
      has_usd: true, totals: { by_method: [], usd: { received: null, any: true }, tips: { amount: '0.00' } },
    };
    expect(Cut.countBlocker('1000', corte, { usd: '' })).not.toBeNull();
    expect(Cut.countBlocker('1000', corte, { usd: '30' })).toBeNull();
  });
});

describe('La pantalla de la puerta trae la caja de Cover', () => {
  const html = leer('staff.html');
  const controlador = leer('js/staff-screen.js');

  it('cada elemento que usa el controlador existe en la página', () => {
    for (const id of ['door-till', 'door-till-state', 'door-till-info', 'door-till-form',
      'door-till-float', 'door-till-float-usd', 'door-till-pin', 'btn-door-till-open',
      'door-till-actions', 'btn-door-till-cut', 'btn-door-till-refresh', 'btn-door-till-recheck',
      'door-till-error', 'sell-locked']) {
      expect(html).toContain(`id="${id}"`);
      expect(controlador).toContain(`'${id}'`);
    }
  });

  it('carga el módulo antes del controlador, y el service worker lo guarda', () => {
    const modulo = html.indexOf('js/door-till.js');
    expect(modulo).toBeGreaterThan(-1);
    expect(modulo).toBeLessThan(html.indexOf('js/staff-screen.js'));
    expect(leer('sw.js')).toContain("'js/door-till.js'");
  });

  it('el código del gerente va enmascarado', () => {
    expect(html).toMatch(/id="door-till-pin" type="password"/);
  });

  it('cada texto nuevo existe en español y en inglés', () => {
    const claves = (controlador.match(/'dtill\.[a-zA-Z]+'/g) || [])
      .concat(fs.readFileSync(path.join(ROOT, 'js', 'door-till.js'), 'utf8').match(/'dtill\.[a-zA-Z]+'/g) || [])
      .map((k) => k.slice(1, -1));
    expect(claves.length).toBeGreaterThan(5);
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      for (const k of new Set(claves)) expect(catalogo.t(k)).not.toBe(k);
    }
    catalogo.setLanguage('es');
  });
});
