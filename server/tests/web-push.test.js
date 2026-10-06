'use strict';

// Las notificaciones del lado del teléfono (D90). Lo que se rompe callado:
//   * una pantalla que no carga push.js, o lo carga después de su controlador;
//   * salir sin borrar el teléfono: el siguiente que entra recibe los avisos del anterior;
//   * un iPhone en Safari al que se le ofrece un botón que no puede funcionar;
//   * el service worker que recibe un push y no enseña nada (iPhone quita el permiso).

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const Push = require('../../web/js/push.js');

const WEB = path.join(__dirname, '..', '..', 'web');
const leer = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');

const PANTALLAS = {
  'index.html': 'index-screen.js',
  'staff.html': 'staff-screen.js',
  'bartender.html': 'bartender-screen.js',
  'caja.html': 'cashier-screen.js',
  'manager.html': 'manager-screen.js',
  'valet.html': 'valet-screen.js',
  'employee-portal.html': 'employee-screen.js',
};

describe('cada pantalla con avisos trae el recuadro y el módulo', () => {
  for (const [html, ctrl] of Object.entries(PANTALLAS)) {
    it(`${html}: recuadro oculto, push.js antes de ${ctrl}, y salir borra el teléfono`, () => {
      const doc = new JSDOM(leer(html)).window.document;
      const box = doc.getElementById('push-box');
      expect(box).not.toBeNull();
      expect(box.hasAttribute('hidden')).toBe(true);
      const srcs = [...doc.querySelectorAll('script')].map((s) => s.getAttribute('src'));
      expect(srcs).toContain('js/push.js');
      expect(srcs.indexOf('js/push.js')).toBeLessThan(srcs.indexOf(`js/${ctrl}`));

      const js = leer(`js/${ctrl}`);
      expect(js).toMatch(/EV2Push\.start\(\{ api, box: \$\('push-box'\)/);
      // El orden importa: después del logout ya no hay sesión para avisarle al servidor.
      const olvida = js.indexOf('EV2Push.forget(api)');
      expect(olvida).toBeGreaterThan(-1);
      expect(olvida).toBeLessThan(js.indexOf('api.logout()'));
    });
  }
});

describe('qué enseña el recuadro', () => {
  const base = {
    serverEnabled: true, supported: true, ios: false, standalone: false,
    permission: 'default', subscribed: false, dismissed: false,
  };

  it('ofrece activarlas cuando se puede', () => {
    expect(Push.boxState(base)).toBe('offer');
  });

  it('nada si el servidor no tiene notificaciones, o si ya están activas', () => {
    expect(Push.boxState({ ...base, serverEnabled: false })).toBe('hidden');
    expect(Push.boxState({ ...base, permission: 'granted', subscribed: true })).toBe('hidden');
  });

  it('iPhone en Safari: primero agregar a inicio, no un botón que no funciona', () => {
    expect(Push.boxState({ ...base, ios: true, supported: false })).toBe('ios');
    expect(Push.boxState({ ...base, ios: true, standalone: true })).toBe('offer');
  });

  it('bloqueadas: dice dónde se desbloquean; navegador sin soporte: lo dice', () => {
    expect(Push.boxState({ ...base, permission: 'denied' })).toBe('denied');
    expect(Push.boxState({ ...base, supported: false })).toBe('unsupported');
  });

  it('"Ahora no" lo esconde', () => {
    expect(Push.boxState({ ...base, dismissed: true })).toBe('hidden');
  });

  it('reconoce el iPad que dice ser Mac', () => {
    expect(Push.isIos({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })).toBe(true);
    expect(Push.isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 })).toBe(true);
    expect(Push.isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 })).toBe(false);
    expect(Push.isIos({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' })).toBe(false);
  });

  it('la llave pública base64url se convierte a bytes', () => {
    expect([...Push.keyBytes('AQID_-8')]).toEqual([1, 2, 3, 255, 239]);
  });
});

describe('el service worker', () => {
  const sw = leer('sw.js');

  it('enseña una notificación por cada push (iPhone quita el permiso si no)', () => {
    expect(sw).toMatch(/addEventListener\('push'/);
    expect(sw).toMatch(/showNotification\(/);
    expect(sw).toMatch(/addEventListener\('notificationclick'/);
  });

  it('nunca pide vibrar y callada a la vez: el navegador lo rechaza y la notificación no sale', () => {
    // Pasó en la prueba en Chromium: con la app abierta (callada) llevaba vibración, el
    // navegador lanzaba TypeError y no se enseñaba nada.
    expect(sw).not.toMatch(/vibrate: \[[^\]]*\],\s*\n\s*silent:/);
    expect(sw).toMatch(/if \(!visible\) options\.vibrate/);
  });

  it('guarda push.js para abrir sin señal', () => {
    expect(sw).toMatch(/'js\/push\.js'/);
  });
});

describe('los textos', () => {
  const F = require('../../web/js/format.js');
  it('cada texto del recuadro está en los dos idiomas', () => {
    for (const k of ['push.offer', 'push.ios', 'push.denied', 'push.unsupported', 'push.activate',
      'push.dismiss', 'push.on', 'push.failed']) {
      expect(F.STRINGS.es[k]).toBeTruthy();
      expect(F.STRINGS.en[k]).toBeTruthy();
    }
  });
});
