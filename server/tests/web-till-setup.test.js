/**
 * Cajas en el navegador (D126): las reglas sin DOM de `web/js/till-setup.js` y de la
 * caja que se escoge en el rol (`web/js/roster.js`), y que cada texto nuevo exista en
 * español e inglés.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..', 'web');
const TillSetup = require(path.join(ROOT, 'js', 'till-setup.js'));
const Roster = require(path.join(ROOT, 'js', 'roster.js'));
const Format = require(path.join(ROOT, 'js', 'format.js'));

describe('Alta de cajas en el panel', () => {
  it('los pasos cambian con el equipo: la PC usa estación, el teléfono impresora de red', () => {
    expect(TillSetup.steps('pc')).toEqual(['place', 'name', 'station', 'terminal', 'test']);
    expect(TillSetup.steps('phone')).toEqual(['place', 'name', 'network', 'terminal', 'test']);
  });

  it('solo acepta una IP de impresora', () => {
    expect(TillSetup.isIp('192.168.1.50')).toBe(true);
    expect(TillSetup.isIp(' 10.0.0.9 ')).toBe(true);
    expect(TillSetup.isIp('192.168.1.256')).toBe(false);
    expect(TillSetup.isIp('impresora')).toBe(false);
    expect(TillSetup.isIp('192.168.1')).toBe(false);
  });

  it('en el rol, al cajero se le pregunta la caja solo si su barra tiene varias', () => {
    const tills = [
      { till_id: 'a', location_id: 'baja', till_name: 'PC' },
      { till_id: 'b', location_id: 'baja', till_name: 'Teléfono' },
      { till_id: 'c', location_id: 'alta', till_name: 'Alta' },
    ];
    expect(Roster.tillChoices({ role: 'cashier', locationId: 'baja', tills }).map((x) => x.till_id)).toEqual(['a', 'b']);
    expect(Roster.tillChoices({ role: 'cashier', locationId: 'alta', tills })).toEqual([]);
    expect(Roster.tillChoices({ role: 'bartender', locationId: 'baja', tills })).toEqual([]);
    expect(Roster.assignBody({ userId: 'u', locationId: 'baja', tillId: 'b' }))
      .toEqual({ user_id: 'u', location_id: 'baja', till_id: 'b' });
    // Copiar el rol de otra noche conserva la caja.
    const plan = Roster.copyPlan([{ user_id: 'u', targets: [{ location_id: 'baja', till_id: 'b' }] }], []);
    expect(plan).toEqual([{ user_id: 'u', location_id: 'baja', till_id: 'b' }]);
  });

  it('cada texto tset.* que usan las pantallas existe en los dos idiomas', () => {
    const fuentes = ['js/till-setup.js', 'js/manager-screen.js', 'js/cashier-screen.js', 'manager.html', 'caja.html']
      .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    const claves = new Set([...fuentes.matchAll(/tset\.[a-zA-Z_.]+[a-zA-Z_]/g)].map((m) => m[0]));
    for (const code of ['no_printer', 'no_drawer', 'no_agent', 'agent_offline']) claves.add(`tset.issue.${code}`);
    claves.delete('tset.issue');
    expect(claves.size).toBeGreaterThan(40);
    for (const lang of ['es', 'en']) {
      Format.setLanguage(lang);
      for (const k of claves) expect([lang, k, Format.t(k) !== k]).toEqual([lang, k, true]);
    }
  });
});
