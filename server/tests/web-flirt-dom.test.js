/**
 * La pantalla "Conecta" corriendo de verdad, sobre el `web/index.html` REAL.
 *
 * Las pruebas de `web-flirt.test.js` comprueban las decisiones; esta comprueba lo que
 * ninguna de ellas puede ver: que el controlador y el HTML se encuentren, que la puerta
 * de consentimiento tape lo que tiene que tapar, y que lo que sale hacia el servidor
 * sea exactamente lo que el cliente vio en la pantalla.
 *
 * Es la clase de fallo que ya nos costó caro dos veces —una pantalla muda porque el
 * tipo del evento se leía de `type` en vez de `event_type`, y un botón que se caía
 * porque `currentTarget` era null después de un `await`—: no se ve en un módulo suelto.
 *
 * No hay servidor: la API es un doble que anota lo que se le pide.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const WEB = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

const PERSONAS = [
  { id: 'p1', display_name: 'Ana', table_id: 't1', table_code: 'A3', section: 'Terraza', floor: 1, accept_flirts: true },
  { id: 'p2', display_name: 'Zoe', table_id: 't2', table_code: 'A4', section: 'Terraza', floor: 1, accept_flirts: true },
];
// Cada montaje abre una ventana con su propio reloj de animación. Sin cerrarlas, jest
// se queda colgado un segundo al final quejándose de trabajos sin terminar, y con
// bastantes suites acaba comiéndose la memoria de la máquina que corre las pruebas.
const abiertas = [];
afterEach(() => {
  while (abiertas.length) abiertas.pop().close();
});

const RECIBIDO = {
  id: 'f1', sender_id: 'p1', sender_name: 'Ana', sender_table_code: 'A3', type: 'emoji',
  emoji: 'kiss', status: 'sent',
};

/** Levanta la pantalla entera con una API de mentira y devuelve con qué hurgarla. */
function montar() {
  const dom = new JSDOM(leer('index.html'), {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://ev2.local/',
  });
  const { window } = dom;
  abiertas.push(window);
  const estado = {
    calls: [],
    prefs: { accept_flirts: false, discoverable: false, show_on_map: true },
    inbox: [],
    people: PERSONAS,
  };
  const anotar = (method, ruta, body) => estado.calls.push({ method, path: ruta, body });

  const api = {
    get: async (p) => {
      anotar('GET', p);
      if (p === '/me/preferences') return { preferences: estado.prefs };
      if (p === '/me/blocks') return { blocks: [] };
      if (p.includes('/flirts/people')) return { people: estado.people };
      if (p.includes('/flirts/received')) return { flirts: estado.inbox, accept_flirts: true };
      if (p.includes('/flirts/sent')) return { flirts: [] };
      return {};
    },
    put: async (p, body) => {
      anotar('PUT', p, body);
      estado.prefs = { ...estado.prefs, ...body };
      return { preferences: estado.prefs };
    },
    post: async (p, body) => { anotar('POST', p, body); return { flirt: { id: 'f9' } }; },
    del: async (p) => { anotar('DELETE', p); return null; },
  };

  window.eval(leer('js/format.js'));
  window.eval(leer('js/flirt.js'));
  const F = window.EV2Format;
  F.setLanguage('es');
  F.applyTo(window.document);

  const handlers = {};
  window.EV2Screen = { on: (n, fn) => { (handlers[n] || (handlers[n] = [])).push(fn); } };

  const ctx = {
    api,
    clubId: () => 'club-1',
    user: () => ({ id: 'yo', display_name: 'Yo' }),
    club: () => ({ name: 'EV2' }),
    drinks: () => [{ id: 'd1', name: 'Mezcal', price: '180.00', currency: 'MXN', available: true }],
    myTable: () => ({ id: 't9', code: 'B1' }),
    t: (k, v) => (v ? F.tf(k, v) : F.t(k)),
    money: (a, c) => F.money(a, c || 'MXN'),
    lang: () => 'es',
    escape: (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    toast: () => {},
    showError: () => {},
  };

  window.confirm = () => true;
  window.eval(leer('js/flirt-screen.js'));

  return {
    window,
    estado,
    $: (id) => window.document.getElementById(id),
    q: (sel) => window.document.querySelector(sel),
    emit: (name, arg) => (handlers[name] || []).forEach((fn) => fn(arg)),
    entrar: async () => {
      (handlers.enter || []).forEach((fn) => fn(ctx));
      await new Promise((r) => setTimeout(r, 20));
    },
    latir: () => new Promise((r) => setTimeout(r, 20)),
    ultima: (method) => estado.calls.filter((c) => c.method === method).pop(),
  };
}

// --------------------------------------------------------------------- consentimiento

describe('la puerta de consentimiento', () => {
  it('con el permiso apagado solo se ve el interruptor, y no se pide la lista de nadie', async () => {
    const app = montar();
    await app.entrar();
    expect(app.$('flirt-optout').hidden).toBe(false);
    expect(app.$('flirt-main').hidden).toBe(true);
    // Lo importante: sin permiso, la pantalla ni siquiera PREGUNTA quién está.
    expect(app.estado.calls.some((c) => c.path.includes('/flirts/people'))).toBe(false);
  });

  it('activar enciende recibir y aparecer, y descubre la pantalla', async () => {
    const app = montar();
    await app.entrar();
    app.$('btn-flirt-optin').click();
    await app.latir();
    expect(app.ultima('PUT').body).toEqual({ accept_flirts: true, discoverable: true });
    expect(app.$('flirt-main').hidden).toBe(false);
    expect(app.$('pref-accept').checked).toBe(true);
  });

  it('apagar "aceptar" apaga también "aparecer": un buzón cerrado no se anuncia', async () => {
    const app = montar();
    app.estado.prefs = { accept_flirts: true, discoverable: true, show_on_map: true };
    await app.entrar();
    app.$('pref-accept').checked = false;
    app.$('pref-accept').dispatchEvent(new app.window.Event('change'));
    await app.latir();
    expect(app.ultima('PUT').body).toEqual({ accept_flirts: false, discoverable: false });
    expect(app.$('flirt-optout').hidden).toBe(false);
  });
});

// --------------------------------------------------------------------- mandar

describe('mandar algo', () => {
  const encendida = async () => {
    const app = montar();
    app.estado.prefs = { accept_flirts: true, discoverable: true, show_on_map: true };
    await app.entrar();
    return app;
  };

  it('pinta una tarjeta por persona, con su mesa y sin su correo', async () => {
    const app = await encendida();
    const tarjetas = app.$('flirt-people-groups').querySelectorAll('button');
    expect(tarjetas).toHaveLength(2);
    expect(tarjetas[0].textContent).toMatch(/Ana/);
    expect(tarjetas[0].textContent).toMatch(/A3/);
    expect(tarjetas[0].textContent).not.toMatch(/@/);
  });

  it('la hoja se abre con el nombre a la vista y sin cobrar nada', async () => {
    const app = await encendida();
    app.$('flirt-people-groups').querySelectorAll('button')[0].click();
    await app.latir();
    expect(app.$('flirt-sheet').hidden).toBe(false);
    expect(app.$('flirt-sheet-title').textContent).toBe('Ana');
    expect(app.$('flirt-mode-gift').hidden).toBe(true);
    expect(app.$('flirt-warn').textContent).toBe('');
  });

  it('lo que viaja es lo que se tocó: destinatario, emoji, mensaje recortado e id de petición', async () => {
    const app = await encendida();
    app.$('flirt-people-groups').querySelectorAll('button')[0].click();
    await app.latir();
    app.$('flirt-emojis').querySelectorAll('button')[3].click();
    app.$('flirt-message').value = 'x'.repeat(200);
    app.$('btn-flirt-send').click();
    await app.latir();
    const { body } = app.ultima('POST');
    expect(body.recipient_id).toBe('p1');
    expect(body.emoji).toBe('fire');
    expect(body.message).toHaveLength(140);
    expect(body.client_request_id).toBeTruthy();
    expect(app.$('flirt-sheet').hidden).toBe(true);
  });
});

// --------------------------------------------------------------------- el dinero

describe('invitar un trago, que es lo único que cobra', () => {
  const conHoja = async () => {
    const app = montar();
    app.estado.prefs = { accept_flirts: true, discoverable: true, show_on_map: true };
    await app.entrar();
    app.$('flirt-people-groups').querySelectorAll('button')[0].click();
    await app.latir();
    app.q('[data-flirt-mode="drink"]').click();
    return app;
  };

  it('advierte que se cobra y que no se devuelve ANTES de tocar el botón', async () => {
    const app = await conHoja();
    expect(app.$('flirt-warn').textContent).toMatch(/no se devuelve/i);
    expect(app.$('btn-flirt-send').textContent).toMatch(/pagar/i);
  });

  it('si se dice que no en la confirmación, no se manda ni se cobra', async () => {
    const app = await conHoja();
    let preguntado = false;
    app.window.confirm = () => { preguntado = true; return false; };
    app.$('btn-flirt-send').click();
    await app.latir();
    expect(preguntado).toBe(true);
    expect(app.estado.calls.some((c) => c.body && c.body.type === 'drink')).toBe(false);
  });

  it('al confirmar se manda con el trago elegido', async () => {
    const app = await conHoja();
    app.$('btn-flirt-send').click();
    await app.latir();
    const { body } = app.ultima('POST');
    expect(body.type).toBe('drink');
    expect(body.drink_id).toBe('d1');
  });
});

// --------------------------------------------------------------------- recibir

describe('la bandeja', () => {
  const conUno = async () => {
    const app = montar();
    app.estado.prefs = { accept_flirts: true, discoverable: true, show_on_map: true };
    app.estado.inbox = [{
      ...RECIBIDO,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600e3).toISOString(),
    }];
    await app.entrar();
    return app;
  };

  it('un evento del socket enciende el globito y pinta lo que llegó', async () => {
    const app = montar();
    app.estado.prefs = { accept_flirts: true, discoverable: true, show_on_map: true };
    await app.entrar();
    app.estado.inbox = [{
      ...RECIBIDO,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600e3).toISOString(),
    }];
    // El tipo real viaja en `event_type`; `type` siempre vale 'event'.
    app.emit('event', { type: 'event', event_type: 'flirt_received' });
    await app.latir();
    expect(app.$('flirt-badge').hidden).toBe(false);
    expect(app.$('flirt-badge').textContent).toBe('1');
    expect(app.$('flirt-inbox-list').textContent).toMatch(/A3/);
  });

  it('un evento de otra pantalla no toca esta', async () => {
    const app = await conUno();
    const antes = app.estado.calls.length;
    app.emit('event', { type: 'event', event_type: 'order_ready' });
    await app.latir();
    expect(app.estado.calls).toHaveLength(antes);
  });

  it('hay seis formas de contestar, y contestar manda la reacción', async () => {
    const app = await conUno();
    const botones = [...app.$('flirt-inbox-list').querySelectorAll('button')];
    expect(botones.length).toBeGreaterThanOrEqual(6);
    botones[0].click();
    await app.latir();
    const react = app.estado.calls.find((c) => c.path.includes('/react'));
    expect(react.body.reaction).toBe('like');
  });

  it('reportar viaja con el motivo y con el flirt como evidencia', async () => {
    const app = await conUno();
    const botones = [...app.$('flirt-inbox-list').querySelectorAll('button')];
    botones.find((b) => /Reportar/.test(b.textContent)).click();
    await app.latir();
    expect(app.$('report-sheet').hidden).toBe(false);
    expect(app.$('report-reason').options).toHaveLength(4);
    app.$('report-reason').value = 'harassment';
    app.$('report-details').value = 'insistió después de que le dije que no';
    app.$('btn-report-send').click();
    await app.latir();
    const reporte = app.estado.calls.find((c) => c.path.includes('/report'));
    expect(reporte.body).toEqual({
      reason: 'harassment', details: 'insistió después de que le dije que no', flirt_id: 'f1',
    });
  });
});
