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

// ================================================================== D91

describe('las pantallas se ponen al día solas (D91)', () => {
  const CONTROLADORES = {
    'index-screen.js': 'Promise.all([loadFloor(), loadOrders(), loadTaxi()])',
    'staff-screen.js': 'loadAll()',
    'bartender-screen.js': 'loadQueue()',
    'cashier-screen.js': 'refreshSoon()',
    'manager-screen.js': 'loadAll()',
    'valet-screen.js': 'loadAll()',
    'employee-screen.js': 'loadAll()',
    'driver-screen.js': 'load()',
  };
  for (const [archivo, carga] of Object.entries(CONTROLADORES)) {
    it(`${archivo} vuelve a pedir sus datos al reconectar o al volver`, () => {
      expect(leer(`js/${archivo}`)).toContain(`rt.onCatchUp(() => ${carga});`);
    });
  }

  it('el almacén, que no tiene socket, también al volver o al regresar la señal', () => {
    const js = leer('js/warehouse-screen.js');
    expect(js).toMatch(/visibilitychange/);
    expect(js).toMatch(/addEventListener\('online'/);
  });
});

describe('la versión nueva sola, pero nunca a media acción (D91)', () => {
  const Pwa = require('../../web/js/pwa.js');
  const doc = (html) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;

  it('sin nada abierto, se puede recargar', () => {
    expect(Pwa.isBusy(doc('<main>hola</main><div class="fixed inset-0" hidden></div>'))).toBe(false);
  });

  it('con una hoja abierta (un pedido armado, un cobro), no', () => {
    expect(Pwa.isBusy(doc('<div class="fixed inset-0">hoja</div>'))).toBe(true);
    expect(Pwa.isBusy(doc('<div role="dialog">cuadro</div>'))).toBe(true);
  });

  it('una hoja dentro de algo escondido no cuenta', () => {
    expect(Pwa.isBusy(doc('<section hidden><div class="fixed inset-0">x</div></section>'))).toBe(false);
  });

  it('escribiendo en un campo con algo, no', () => {
    const d = doc('<input id="q" value="tecate">');
    d.getElementById('q').focus();
    expect(Pwa.isBusy(d)).toBe(true);
  });

  it('busca versión cada cinco minutos', () => {
    expect(Pwa.CHECK_EVERY_MS).toBe(300000);
  });

  it('ninguna pantalla abre con una hoja ya visible (si no, nunca se recargaría sola)', () => {
    for (const html of Object.keys(PANTALLAS)) {
      const d = new JSDOM(leer(html)).window.document;
      const abiertas = [...d.querySelectorAll('.fixed.inset-0, [role="dialog"]')]
        .filter((el) => !el.hidden && !el.closest('[hidden]'));
      expect([html, abiertas.map((el) => el.id || el.className)]).toEqual([html, []]);
    }
  });
});

describe('el gerente ve por qué no llegan (D91)', () => {
  it('la tarjeta de notificaciones vive en Club, con su botón de prueba', () => {
    const d = new JSDOM(leer('manager.html')).window.document;
    const card = d.getElementById('push-status-card');
    expect(card).not.toBeNull();
    expect(d.getElementById('tab-club').contains(card)).toBe(true);
    expect(d.getElementById('btn-ps-test')).not.toBeNull();
    expect(leer('js/manager-screen.js')).toMatch(/club: \(\) => Promise\.all\(\[[^\]]*loadPushStatus\(\)/);
  });

  it('cada motivo tiene su texto en los dos idiomas', () => {
    const F = require('../../web/js/format.js');
    for (const k of ['ps.why.server_disabled', 'ps.why.no_devices', 'ps.why.off_shift', 'ps.why.no_night',
      'ps.fail.server_disabled', 'ps.fail.ios', 'ps.fail.unsupported', 'ps.fail.denied', 'ps.fail.default',
      'ps.fail.not_delivered', 'ps.fail.server', 'pwa.update']) {
      expect([k, Boolean(F.STRINGS.es[k]), Boolean(F.STRINGS.en[k])]).toEqual([k, true, true]);
    }
  });

  it('la espera del service worker tiene tope: el botón ya no se queda colgado', () => {
    expect(leer('js/push.js')).toMatch(/Promise\.race\(\[\s*navigator\.serviceWorker\.ready/);
  });

  it('el script de verificación del VPS revisa las claves y el arranque', () => {
    const sh = fs.readFileSync(path.join(__dirname, '..', '..', 'deploy', 'verificar-despliegue.sh'), 'utf8');
    expect(sh).toMatch(/VAPID_PUBLIC_KEY/);
    expect(sh).toMatch(/Push notifications: enabled/);
  });
});

// ================================================================== D93

describe('los avisos en vivo suenan en la pantalla abierta (D93)', () => {
  for (const ctrl of Object.values(PANTALLAS)) {
    it(`${ctrl} escucha sus avisos en vivo`, () => {
      expect(leer(`js/${ctrl}`)).toContain('EV2Push.listen(rt, { toast });');
    });
  }

  it('el texto sale en el idioma de la pantalla, con español de respaldo', () => {
    const p = { es: { title: 'Trago listo', body: 'Mesa 12' }, en: { title: 'Drink ready', body: 'Table 12' } };
    expect(Push.noticeText(p, 'en')).toEqual({ title: 'Drink ready', body: 'Table 12' });
    expect(Push.noticeText(p, 'es')).toEqual({ title: 'Trago listo', body: 'Mesa 12' });
    expect(Push.noticeText({ es: p.es }, 'en')).toEqual({ title: 'Trago listo', body: 'Mesa 12' });
  });

  it('el mismo aviso por dos caminos (en vivo y notificación) suena una sola vez', () => {
    const t0 = 1_000_000;
    expect(Push.firstTime('order-1', t0)).toBe(true);
    expect(Push.firstTime('order-1', t0 + 1000)).toBe(false);
    expect(Push.firstTime('order-2', t0 + 1000)).toBe(true);
    // Pasado un rato, el mismo pedido puede volver a sonar (otro cambio de estado).
    expect(Push.firstTime('order-1', t0 + 10_000)).toBe(true);
  });

  it('con la pantalla abierta suena, vibra y avisa; escondida no (para eso está la notificación)', () => {
    const handlers = {};
    const rt = { on: (n, fn) => { handlers[n] = fn; } };
    const avisos = [];
    global.document = { visibilityState: 'visible' };
    try {
      Push.listen(rt, { toast: (m) => avisos.push(m) });
      handlers.notice({ tag: 'order-77', es: { title: 'Pedido nuevo', body: 'Mesa 3 · cobrar $90.00' } });
      expect(avisos).toEqual(['Pedido nuevo · Mesa 3 · cobrar $90.00']);
      global.document.visibilityState = 'hidden';
      handlers.notice({ tag: 'order-78', es: { title: 'Pedido nuevo', body: 'Mesa 4' } });
      expect(avisos).toHaveLength(1);
    } finally {
      delete global.document;
    }
  });
});
