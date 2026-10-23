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
