/**
 * La página pública de verificación, corriendo sobre el `web/verificar.html` REAL.
 *
 * Quien abre esta página tiene el folio en la mano y ninguna cuenta: un policía en la
 * calle, un familiar, el propio cliente desde un teléfono prestado. Es la única pantalla
 * del sistema que un tercero usa para decidir algo sobre otra persona, así que lo que
 * se prueba aquí es que no mienta: que "vigente" signifique vigente, que un folio que
 * no existe se diga así, y que la placa que se enseña sea la que mandó el servidor.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const WEB = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

const CERT = {
  folio: 'EV2-K7M2-P4XQ',
  nightclub: 'EV2 Clandestinoz',
  issued_at: '2026-09-06T04:00:00Z',
  expires_at: '2099-01-01T00:00:00Z',
  valid: true,
  guest: 'Ana L.',
  driver: 'Beto',
  vehicle: { plate: 'ABC-123-D', color: 'gris', description: 'Nissan Versa' },
  disclaimer: 'Acredita únicamente la salida del establecimiento.',
};

const abiertas = [];
afterEach(() => { while (abiertas.length) abiertas.pop().close(); });

/** Levanta la página con un `fetch` de mentira que anota a dónde se llamó. */
function montar({ respuesta, url = 'https://ev2.local/verificar.html' } = {}) {
  const dom = new JSDOM(leer('verificar.html'), {
    runScripts: 'outside-only', pretendToBeVisual: true, url,
  });
  const { window } = dom;
  abiertas.push(window);
  const llamadas = [];
  window.fetch = async (ruta) => {
    llamadas.push(ruta);
    const r = respuesta || { status: 200, body: { certificate: CERT } };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  };
  window.localStorage.setItem('ev2.lang', 'es');
  window.eval(leer('js/format.js'));
  window.eval(leer('js/taxi-ride.js'));
  window.eval(leer('js/verify-screen.js'));
  return {
    window,
    llamadas,
    $: (id) => window.document.getElementById(id),
    escribir: (folio) => {
      const input = window.document.getElementById('verify-folio');
      input.value = folio;
      input.dispatchEvent(new window.Event('input'));
    },
    enviar: async () => {
      window.document.getElementById('verify-form')
        .dispatchEvent(new window.Event('submit', { cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    },
  };
}

describe('la página que abre quien tiene el folio', () => {
  it('arranca vacía: no enseña resultado ni error antes de que nadie pregunte nada', () => {
    const p = montar();
    expect(p.$('verify-result').hidden).toBe(true);
    expect(p.$('verify-error').hidden).toBe(true);
  });

  it('normaliza lo que se teclea de un papel: minúsculas y espacios', () => {
    const p = montar();
    p.escribir('  ev2-k7m2 p4xq ');
    expect(p.$('verify-folio').value).toBe('EV2-K7M2P4XQ');
  });

  it('un folio demasiado corto ni se manda: se dice aquí', async () => {
    const p = montar();
    p.escribir('ab');
    await p.enviar();
    expect(p.llamadas).toHaveLength(0);
    expect(p.$('verify-error').hidden).toBe(false);
  });

  it('pregunta por la ruta pública, sin sesión de por medio', async () => {
    const p = montar();
    p.escribir('EV2-K7M2-P4XQ');
    await p.enviar();
    expect(p.llamadas[0]).toBe('/api/taxi/verify/EV2-K7M2-P4XQ');
  });

  it('enseña vigente, el folio y lo que se puede comparar con el coche de enfrente', async () => {
    const p = montar();
    p.escribir('EV2-K7M2-P4XQ');
    await p.enviar();
    expect(p.$('verify-result').hidden).toBe(false);
    expect(p.$('verify-state').textContent).toMatch(/vigente/i);
    expect(p.$('verify-folio-out').textContent).toBe('EV2-K7M2-P4XQ');
    const filas = p.$('verify-rows').textContent;
    expect(filas).toMatch(/Ana L\./);
    expect(filas).toMatch(/ABC-123-D/);
    expect(filas).toMatch(/gris Nissan Versa/);
    expect(p.$('verify-club').textContent).toBe('EV2 Clandestinoz');
  });

  it('el descargo se enseña siempre: la constancia no acredita más de lo que dice', async () => {
    const p = montar();
    p.escribir('EV2-K7M2-P4XQ');
    await p.enviar();
    expect(p.$('verify-disclaimer').textContent).toBe(CERT.disclaimer);
  });

  it('una constancia vencida NO se enseña como vigente', async () => {
    const p = montar({
      respuesta: {
        status: 200,
        body: { certificate: { ...CERT, expires_at: '2020-01-01T00:00:00Z', valid: false } },
      },
    });
    p.escribir('EV2-K7M2-P4XQ');
    await p.enviar();
    expect(p.$('verify-state').textContent).toMatch(/vencida/i);
    expect(p.$('verify-expires').textContent).toMatch(/Venció/);
  });

  it('un folio que no existe se dice así, sin enseñar un resultado a medias', async () => {
    const p = montar({ respuesta: { status: 404, body: {} } });
    p.escribir('EV2-NO-EXISTE');
    await p.enviar();
    expect(p.$('verify-result').hidden).toBe(true);
    expect(p.$('verify-error').textContent).toMatch(/No existe/i);
  });

  it('el límite de intentos se explica, para que nadie insista y se bloquee', async () => {
    const p = montar({ respuesta: { status: 429, body: {} } });
    p.escribir('EV2-K7M2-P4XQ');
    await p.enviar();
    expect(p.$('verify-error').textContent).toMatch(/intentos/i);
  });

  it('un folio en la dirección se comprueba solo: es lo que espera quien escaneó el QR', async () => {
    const p = montar({ url: 'https://ev2.local/verificar.html?folio=ev2-k7m2-p4xq' });
    await new Promise((r) => setTimeout(r, 20));
    expect(p.$('verify-folio').value).toBe('EV2-K7M2-P4XQ');
    expect(p.llamadas[0]).toBe('/api/taxi/verify/EV2-K7M2-P4XQ');
    expect(p.$('verify-result').hidden).toBe(false);
  });
});
