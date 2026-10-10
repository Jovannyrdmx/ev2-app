'use strict';

const fs = require('fs');
const path = require('path');
const Roles = require('../../web/js/roles.js');

const ROOT = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('RP en la web (D98)', () => {
  test('el rol rp entra por el portal del empleado', () => {
    expect(JSON.stringify(Roles)).toContain('employee-portal.html');
    expect(JSON.stringify(Roles)).toMatch(/rp/);
  });

  test('el gerente tiene la pestaña y el panel de RPs', () => {
    const html = leer('manager.html');
    expect(html).toContain('data-tab="rps"');
    expect(html).toContain('id="tab-rps"');
    const js = leer('js/manager-screen.js');
    expect(js).toContain("rps: ['tab-rps']");
    expect(js).toContain('/rp/settle');
    expect(js).toContain('/rp/summary');
  });

  test('la puerta pide el código del RP y el portal tiene su pestaña', () => {
    expect(leer('staff.html')).toContain('id="scan-rp"');
    expect(leer('staff.html')).toContain('id="sell-rp"');
    expect(leer('employee-portal.html')).toContain('id="tab-rp"');
  });

  test('la comisión de RP se cuenta como ingreso con su propio nombre', () => {
    expect(leer('js/earnings.js')).toContain("rp_commission: 'earn.mRp'");
  });
});

describe('Estación de caja de un solo paso en la web (D99)', () => {
  const catalogo = require('../../web/js/format.js');
  const html = leer('manager.html');
  const js = leer('js/manager-screen.js');

  test('el asistente está en el panel y el código aparece dentro de su tarjeta', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    for (const id of ['stn-card', 'stn-name', 'stn-place', 'stn-purpose', 'stn-drawer',
      'btn-stn-create', 'stn-list']) {
      expect(doc.getElementById(id)).not.toBeNull();
    }
    expect(doc.getElementById('stn-card').contains(doc.getElementById('prn-pair'))).toBe(true);
    dom.window.close();
  });

  test('manda la estación al pedir el código y sabe terminarla y probar el cajón', () => {
    expect(js).toContain('/print-agents/invite');
    expect(js).toContain('has_drawer');
    expect(js).toContain('/station/finish');
    expect(js).toContain('/test-drawer');
  });

  test('todos los textos stn.* y rpm.* existen en español e inglés', () => {
    const usados = [...new Set([...js.matchAll(/t\('((?:stn|rpm)\.[A-Za-z.]+)'/g)].map((m) => m[1]))];
    expect(usados.length).toBeGreaterThan(10);
    const fuente = leer('js/format.js');
    for (const k of usados) {
      const veces = fuente.split(`'${k}':`).length - 1;
      expect({ k, veces }).toEqual({ k, veces: 2 });
    }
    expect(catalogo).toBeTruthy();
  });
});
