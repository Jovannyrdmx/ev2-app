/**
 * La pestaña "Show" del cliente corriendo de verdad sobre el `web/index.html` REAL:
 * propinas por rol, pedir canción y el reconocimiento (leaderboard).
 *
 * `web-tipping-songs-booking.test.js` comprueba las decisiones (importes, orden,
 * pestañas, normalización del leaderboard); esta comprueba lo que ningún módulo suelto
 * ve: que el controlador y el HTML se encuentren, que las pestañas se generen de quién
 * está en turno de verdad, que al cliente NO se le enseñen montos en el reconocimiento
 * (decidido en 2.5) y que lo que sale hacia el servidor sea lo que el cliente tocó.
 *
 * No hay servidor: la API es un doble que anota lo que se le pide y responde con datos
 * fijos.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const WEB = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

const DANCER = {
  id: 'd1', role: 'dancer', display_name: 'Sofía', role_label: 'Bailarina', section: 'Pista',
  started_at: '2026-09-06T23:00:00Z', min_tip: '100.00', suggested: ['100.00', '200.00', '500.00'],
  currency: 'MXN', accepts_drinks: true,
};
const DANCER2 = { ...DANCER, id: 'd2', display_name: 'Valentina', section: 'VIP', suggested: ['100.00'] };
const DJ = {
  id: 'j1', role: 'dj', display_name: 'Victor', role_label: 'DJ', section: 'Pista',
  started_at: '2026-09-06T22:00:00Z', min_tip: '200.00', suggested: ['200.00', '500.00'],
  currency: 'MXN', accepts_drinks: false,
};
const DJ2 = { ...DJ, id: 'j2', display_name: 'Antonio', section: 'VIP' };

const BOARD_NIGHT = {
  leaderboard: [
    { rank: 1, user_id: 'd1', display_name: 'Sofía', role: 'dancer', fans: 8 },
    { rank: 2, user_id: 'j1', display_name: 'Victor', role: 'dj', fans: 5 },
  ],
};
const BOARD_MONTH = {
  leaderboard: [{ rank: 1, user_id: 'j1', display_name: 'Victor', role: 'dj', fans: 20 }],
};

const abiertas = [];
afterEach(() => {
  while (abiertas.length) abiertas.pop().close();
});

/** Levanta la pantalla entera con una API de mentira y devuelve con qué hurgarla. */
function montar({
  staff = [DANCER, DJ], songs = [], boardNight = BOARD_NIGHT, boardMonth = BOARD_MONTH,
} = {}) {
  const dom = new JSDOM(leer('index.html'), {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://ev2.local/',
  });
  const { window } = dom;
  abiertas.push(window);

  const estado = {
    calls: [], staff, songs, tips: [], boardNight, boardMonth,
  };
  const anotar = (method, ruta, body) => estado.calls.push({ method, path: ruta, body });

  const api = {
    get: async (p) => {
      anotar('GET', p);
      if (p.includes('/staff/on-shift')) return { staff: estado.staff };
      if (p.includes('/tips/mine')) return { tips: estado.tips };
      if (p.includes('/song-requests')) return { song_requests: estado.songs };
      if (p.includes('/leaderboard')) return p.includes('period=month') ? estado.boardMonth : estado.boardNight;
      return {};
    },
    post: async (p, body) => {
      anotar('POST', p, body);
      if (p.endsWith('/song-requests')) return { song_request: { id: 's9', votes: 0 }, merged: null };
      return { tip: { id: 't9' } };
    },
    put: async (p, body) => { anotar('PUT', p, body); return {}; },
    del: async (p) => { anotar('DELETE', p); return null; },
  };

  window.eval(leer('js/format.js'));
  window.eval(leer('js/roles.js'));
  window.eval(leer('js/tipping.js'));
  window.eval(leer('js/songs.js'));
  const F = window.EV2Format;
  F.setLanguage('es');
  F.applyTo(window.document);

  const handlers = {};
  window.EV2Screen = { on: (n, fn) => { (handlers[n] || (handlers[n] = [])).push(fn); } };

  const ctx = {
    api,
    clubId: () => 'club-1',
    user: () => ({ id: 'yo', display_name: 'Yo' }),
    drinks: () => [{ id: 'dr1', name: 'Mezcal', price: '180.00', currency: 'MXN', available: true }],
    myTable: () => ({ id: 't9', code: 'B1' }),
    t: (k, v) => (v ? F.tf(k, v) : F.t(k)),
    money: (a, c) => F.money(a, c || 'MXN'),
    escape: (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    toast: () => {},
  };

  window.eval(leer('js/show-screen.js'));

  return {
    window,
    estado,
    $: (id) => window.document.getElementById(id),
    q: (sel) => window.document.querySelector(sel),
    qa: (sel) => [...window.document.querySelectorAll(sel)],
    emit: (name, arg) => (handlers[name] || []).forEach((fn) => fn(arg)),
    entrar: async () => {
      (handlers.enter || []).forEach((fn) => fn(ctx));
      await new Promise((r) => setTimeout(r, 20));
    },
    latir: () => new Promise((r) => setTimeout(r, 20)),
    ultima: (method) => estado.calls.filter((c) => c.method === method).pop(),
    tab: (key) => [...window.document.querySelectorAll('#show-tabs .show-tab')]
      .find((b) => b.dataset.showTab === key),
  };
}

// --------------------------------------------------------------------- pestañas

describe('las pestañas salen de quién está en turno', () => {
  it('una por rol con gente, más Música y Reconocimiento; los roles sin nadie no aparecen', async () => {
    const app = montar();
    await app.entrar();
    const keys = app.qa('#show-tabs .show-tab').map((b) => b.dataset.showTab);
    expect(keys).toEqual(['dancer', 'dj', 'music', 'board']);
    expect(app.tab('dancer').textContent).toBe('Bailarina');
    // waiter, bartender, hostess… nadie en turno: sin pestaña.
    expect(keys).not.toContain('waiter');
  });

  it('sin nadie en turno solo quedan Música y Reconocimiento, y se ve Música', async () => {
    const app = montar({ staff: [] });
    await app.entrar();
    expect(app.qa('#show-tabs .show-tab').map((b) => b.dataset.showTab)).toEqual(['music', 'board']);
    expect(app.$('show-staff').hidden).toBe(true);
    expect(app.$('show-music').hidden).toBe(false);
  });

  it('arranca en la primera pestaña de rol y pinta a esa gente, no a la de otro rol', async () => {
    const app = montar();
    await app.entrar();
    expect(app.$('show-staff').hidden).toBe(false);
    expect(app.$('staff-groups').textContent).toMatch(/Sofía/);
    expect(app.$('staff-groups').textContent).not.toMatch(/Victor/);
  });

  it('cambiar de pestaña cambia el panel y la gente que se ve', async () => {
    const app = montar();
    await app.entrar();
    app.tab('dj').click();
    await app.latir();
    expect(app.$('staff-groups').textContent).toMatch(/Victor/);
    expect(app.$('staff-groups').textContent).not.toMatch(/Sofía/);

    app.tab('music').click();
    await app.latir();
    expect(app.$('show-music').hidden).toBe(false);
    expect(app.$('show-staff').hidden).toBe(true);
    expect(app.$('show-board').hidden).toBe(true);
  });

  it('las tarjetas son de datos reales: sin estrellas de calificación ni total inventado', async () => {
    const app = montar();
    await app.entrar();
    const texto = app.$('staff-groups').textContent;
    expect(texto).not.toMatch(/⭐/);
    expect(texto).not.toMatch(/Tips:\s*\$/);
  });
});

// --------------------------------------------------------------------- reconocimiento

describe('el reconocimiento (leaderboard) del cliente', () => {
  it('pide la noche y pinta puesto, nombre y rol — nunca un monto', async () => {
    const app = montar();
    await app.entrar();
    app.tab('board').click();
    await app.latir();
    expect(app.$('show-board').hidden).toBe(false);
    expect(app.estado.calls.some((c) => c.path.includes('/leaderboard') && c.path.includes('period=night'))).toBe(true);

    const filas = app.qa('#board-list > div');
    expect(filas).toHaveLength(2);
    expect(filas[0].textContent).toMatch(/Sofía/);
    expect(filas[0].textContent).toMatch(/Bailarina/);
    expect(filas[0].textContent).toMatch(/Reconocido por 8/);
    expect(app.$('board-list').textContent).not.toMatch(/\$/);
  });

  it('el toggle Este mes vuelve a pedir con period=month', async () => {
    const app = montar();
    await app.entrar();
    app.tab('board').click();
    await app.latir();
    app.q('[data-board-period="month"]').click();
    await app.latir();
    expect(app.ultima('GET').path).toMatch(/period=month/);
    const filas = app.qa('#board-list > div');
    expect(filas).toHaveLength(1);
    expect(filas[0].textContent).toMatch(/Victor/);
  });

  it('sin nadie en el leaderboard lo dice en vez de dejar la lista vacía', async () => {
    const app = montar({ boardNight: { leaderboard: [] } });
    await app.entrar();
    app.tab('board').click();
    await app.latir();
    expect(app.$('board-empty').hidden).toBe(false);
    expect(app.qa('#board-list > div')).toHaveLength(0);
  });
});

// --------------------------------------------------------------------- pedir canción

describe('pedir canción manda lo que se ve', () => {
  it('con un solo DJ en turno no hay selector de DJ', async () => {
    const app = montar();
    await app.entrar();
    expect(app.$('song-dj-wrap').hidden).toBe(true);
  });

  it('con dos DJs aparece el selector y la canción nueva viaja con ese DJ y la dedicatoria recortada', async () => {
    const app = montar({ staff: [DJ, DJ2] });
    await app.entrar();
    expect(app.$('song-dj-wrap').hidden).toBe(false);
    app.tab('music').click();
    await app.latir();

    app.$('song-dj').value = 'j2';
    app.$('song-title').value = 'La Chona';
    app.$('song-message').value = 'x'.repeat(400);
    app.$('song-form').dispatchEvent(new app.window.Event('submit'));
    await app.latir();

    const { body } = app.ultima('POST');
    expect(body.song_title).toBe('La Chona');
    expect(body.dj_user_id).toBe('j2');
    expect(body.message).toHaveLength(280);
  });

  it('con un solo DJ la canción no lleva dj_user_id (lo elige el servidor)', async () => {
    const app = montar();
    await app.entrar();
    app.tab('music').click();
    await app.latir();
    app.$('song-title').value = 'Rayando el Sol';
    app.$('song-form').dispatchEvent(new app.window.Event('submit'));
    await app.latir();
    const { body } = app.ultima('POST');
    expect(body).not.toHaveProperty('dj_user_id');
    expect(body).not.toHaveProperty('message');
  });
});

// --------------------------------------------------------------------- dar propina

describe('la hoja de propina', () => {
  it('se abre con el nombre de quien la recibe y manda el importe tocado', async () => {
    const app = montar();
    await app.entrar();
    app.q('#staff-groups [data-tip-for="d1"]').click();
    await app.latir();
    expect(app.$('tip-sheet').hidden).toBe(false);
    expect(app.$('tip-sheet-title').textContent).toMatch(/Sofía/);

    // El primer preset por encima del mínimo del rol (100) es 100.
    app.q('#tip-presets button').click();
    await app.latir();
    const { path: ruta, body } = app.ultima('POST');
    expect(ruta).toBe('/nightclubs/club-1/tips');
    expect(body.to_user_id).toBe('d1');
    expect(body.amount).toBe(100);
    expect(body.client_request_id).toBeTruthy();
  });
});

// --------------------------------------------------------------------- socket

describe('los eventos del socket', () => {
  it('una propina recibida recarga personal, propinas y reconocimiento', async () => {
    const app = montar();
    await app.entrar();
    const antes = app.estado.calls.length;
    app.emit('event', { type: 'event', event_type: 'tip_received' });
    await app.latir();
    const nuevas = app.estado.calls.slice(antes).map((c) => c.path);
    expect(nuevas.some((p) => p.includes('/staff/on-shift'))).toBe(true);
    expect(nuevas.some((p) => p.includes('/tips/mine'))).toBe(true);
    expect(nuevas.some((p) => p.includes('/leaderboard'))).toBe(true);
  });

  it('un evento de otra pantalla no dispara nada', async () => {
    const app = montar();
    await app.entrar();
    const antes = app.estado.calls.length;
    app.emit('event', { type: 'event', event_type: 'order_ready' });
    await app.latir();
    expect(app.estado.calls).toHaveLength(antes);
  });
});
