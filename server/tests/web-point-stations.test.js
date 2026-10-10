/**
 * Las pantallas de la terminal por lugar y del cover con terminal (D100).
 *
 * Revisan lo que las pruebas del servidor no ven: que cada pantalla hable con las rutas
 * nuevas, que las frases existan en los dos idiomas y que la hostess no vea la forma de
 * pago de la terminal si la puerta no tiene una.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const web = (...p) => fs.readFileSync(path.resolve(__dirname, '../../web', ...p), 'utf8');
const staff = web('js/staff-screen.js');
const manager = web('js/manager-screen.js');
const cashier = web('js/cashier-screen.js');
const format = web('js/format.js');
const staffHtml = web('staff.html');

describe('El gerente asigna la terminal a su lugar', () => {
  it('la tarjeta de la terminal trae el selector y manda location_id', () => {
    expect(manager).toContain("sitio.setAttribute('aria-label', t('term.place'))");
    expect(manager).toContain('{ location_id: sitio.value || null }');
  });
});

describe('La caja ya no escoge terminal', () => {
  it('pide la de su barra y solo ofrece las que puede usar', () => {
    expect(cashier).toContain('pickTerminal(state.terminals, EV2TerminalCharge.recordada(), barId())');
    expect(cashier).toContain('x.location_id === barId()');
  });
});

describe('Cover con terminal en la puerta', () => {
  it('cobra primero y asienta la entrada al aprobarse, con rutas y cuerpo correctos', () => {
    expect(staff).toContain('/door/point-charges`');
    expect(staff).toContain("payment_method: 'point', terminal_charge_id: dp.chargeId");
    expect(staff).toContain('/door/point-charges/pending`');
  });

  it('la forma de pago solo se ofrece si la puerta tiene terminal', () => {
    expect(staff).toContain("x.location_kind === 'door'");
    expect(staff).toContain("EV2DoorScan.METHODS.concat(puertaTerminal() ? ['point'] : [])");
  });

  it('el aviso de tarjeta aprobada sin entrada tiene dónde pintarse', () => {
    expect(staffHtml).toContain('id="sell-pending"');
  });
});

describe('Frases en los dos idiomas', () => {
  it.each(['term.place', 'term.placeNone', 'sell.m_point', 'sell.pointStuck',
    'sell.pointApproved', 'sell.pointWaiting', 'sell.pointClaim', 'sell.pointWatch'])('%s', (key) => {
    const veces = format.split(`'${key}':`).length - 1;
    expect(veces).toBe(2);
  });
});
