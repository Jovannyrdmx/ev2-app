/**
 * El cobro con terminal, en pantalla (D47).
 *
 * Lo que se prueba aquí es lo único del cobro que vive en el navegador: qué se le dice a
 * quien está mirando mientras el cliente saca la tarjeta, y que la pantalla no adivine
 * nunca que ya se cobró. La decisión de si se cobró es del servidor, y eso ya tiene sus
 * propias pruebas.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const T = require(path.join(ROOT, 'js', 'terminal-charge.js'));
const catalogo = require(path.join(ROOT, 'js', 'format.js'));

describe('Qué se le dice a quien está esperando', () => {
  it('cada estado tiene su texto, en los dos idiomas', () => {
    // Un `null` donde va el titular deja a alguien mirando una pantalla en blanco con
    // un cliente enfrente.
    const estados = ['creating', 'waiting', 'action_required', 'processed', 'failed',
      'canceled', 'expired', 'refunded', 'lo-que-sea'];
    for (const estado of estados) {
      const head = T.headline(estado);
      for (const idioma of catalogo.SUPPORTED) {
        expect(typeof catalogo.STRINGS[idioma][head.key]).toBe('string');
        expect(catalogo.STRINGS[idioma][head.key].trim()).not.toBe('');
      }
    }
  });

  it('"no sabemos" NO se confunde con "la tarjeta no pasó"', () => {
    // Son cosas distintas y confundirlas cuesta dinero: `failed` es "cobra de otra
    // forma"; un estado desconocido es "puede haber un cargo del otro lado, revisa
    // antes de volver a cobrar".
    expect(T.headline('failed').key).not.toBe(T.headline('cualquier-cosa').key);
    expect(catalogo.STRINGS.es[T.headline('cualquier-cosa').key]).toMatch(/no sabemos/i);
  });

  it('solo `processed` cuenta como pagado', () => {
    expect(T.isPaid('processed')).toBe(true);
    for (const otro of ['waiting', 'failed', 'canceled', 'expired', 'refunded', 'error']) {
      expect(T.isPaid(otro)).toBe(false);
    }
  });

  it('`error` ya terminó, aunque no se sepa en qué', () => {
    // Si no contara como final, la pantalla seguiría preguntando para siempre.
    expect(T.isFinal('error')).toBe(true);
    expect(T.isFinal('waiting')).toBe(false);
    expect(T.canCancel('waiting')).toBe(true);
    expect(T.canCancel('processed')).toBe(false);
  });
});

describe('La cuenta atrás y las consultas', () => {
  it('nunca enseña un tiempo negativo', () => {
    const ahora = Date.parse('2026-09-20T02:00:00Z');
    expect(T.secondsLeft('2026-09-20T02:02:00Z', ahora)).toBe(120);
    expect(T.secondsLeft('2026-09-20T01:59:00Z', ahora)).toBe(0);
    expect(T.secondsLeft(null, ahora)).toBe(null);
  });

  it('pregunta seguido al principio y se va calmando', () => {
    // Los primeros segundos es cuando alguien está mirando. A los dos minutos ya no hay
    // nadie pendiente, y seguir preguntando cada segundo es castigar al servidor.
    expect(T.pollDelay(0)).toBeLessThan(T.pollDelay(30000));
    expect(T.pollDelay(30000)).toBeLessThan(T.pollDelay(120000));
  });
});

describe('Con qué terminal se cobra', () => {
  const lista = [
    { id: 'barra', active: true },
    { id: 'vieja', active: false },
    { id: 'puerta', active: true },
  ];

  it('la última que usó ESE aparato, si sigue activa', () => {
    expect(T.pickTerminal(lista, 'puerta').id).toBe('puerta');
  });

  it('si la recordada está dada de baja, la primera activa', () => {
    expect(T.pickTerminal(lista, 'vieja').id).toBe('barra');
  });

  it('sin ninguna activa, null — y la pantalla lo dice antes de cobrar', () => {
    expect(T.pickTerminal([{ id: 'x', active: false }], null)).toBe(null);
    expect(T.pickTerminal([], null)).toBe(null);
  });
});

describe('El cuadro se arma solo', () => {
  const abiertas = [];
  afterEach(() => { while (abiertas.length) abiertas.pop().close(); });

  function ventana() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>',
      { url: 'https://ev2.local/staff.html' });
    abiertas.push(dom.window);
    return dom.window;
  }

  it('crea su propio HTML, sin tocar el de ninguna página', () => {
    // Este mismo cuadro hace falta en cuatro pantallas. Pegarlo cuatro veces es
    // olvidarse de una el día que cambie.
    const win = ventana();
    const sheet = T.createSheet({
      document: win.document,
      api: { get: () => Promise.resolve({}), post: () => Promise.resolve({}) },
      clubId: () => 'club',
      t: (k) => k,
      money: (a) => String(a),
      errorMessage: () => '',
    });
    const caja = win.document.getElementById('term-sheet');
    expect(caja).not.toBeNull();
    expect(caja.hasAttribute('hidden')).toBe(true);
    for (const id of ['term-amount', 'term-headline', 'term-detail', 'term-left',
      'term-cancel', 'term-close', 'term-spinner']) {
      expect(win.document.getElementById(id)).not.toBeNull();
    }
    expect(sheet.chargeId).toBe(null);
  });

  it('al abrirlo enseña el monto, la terminal y el estado; cancelar sigue disponible', () => {
    const win = ventana();
    const sheet = T.createSheet({
      document: win.document,
      api: { get: () => new Promise(() => {}), post: () => new Promise(() => {}) },
      clubId: () => 'club',
      t: (k) => k,
      money: (a, c) => `$${a} ${c}`,
      errorMessage: () => '',
    });
    sheet.watch({
      id: 'c1', amount: '450.00', currency: 'MXN', status: 'waiting',
      terminal: { id: 't1', label: 'Barra' }, expires_at: null,
    });
    const doc = win.document;
    expect(doc.getElementById('term-sheet').hasAttribute('hidden')).toBe(false);
    expect(doc.getElementById('term-amount').textContent).toBe('$450.00 MXN');
    expect(doc.getElementById('term-where').textContent).toBe('Barra');
    expect(doc.getElementById('term-headline').textContent).toBe('pay.termWaiting');
    expect(doc.getElementById('term-cancel').hidden).toBe(false);
    expect(doc.getElementById('term-close').hidden).toBe(true);
    sheet.close();
  });
});

describe('El panel del gerente y sus terminales', () => {
  const abiertas = [];
  afterEach(() => { while (abiertas.length) abiertas.pop().close(); });

  it('cada id que busca manager-screen.js sigue existiendo en manager.html', () => {
    const dom = new JSDOM(leer('manager.html'), { url: 'https://ev2.local/manager.html' });
    abiertas.push(dom.window);
    const controlador = leer('js/manager-screen.js');
    const ids = new Set();
    const re = /\$\('([a-z0-9-]+)'\)/g;
    let m = re.exec(controlador);
    while (m) { ids.add(m[1]); m = re.exec(controlador); }
    expect([...ids].filter((id) => !dom.window.document.getElementById(id))).toEqual([]);
  });

  it('las tres pantallas que cobran cargan el cuadro antes que su controlador', () => {
    for (const [page, controlador] of [
      ['staff.html', 'js/staff-screen.js'],
      ['bartender.html', 'js/bartender-screen.js'],
      ['manager.html', 'js/manager-screen.js'],
    ]) {
      const dom = new JSDOM(leer(page), { url: `https://ev2.local/${page}` });
      abiertas.push(dom.window);
      const src = [...dom.window.document.querySelectorAll('script[src]')]
        .map((x) => x.getAttribute('src'));
      expect(src).toContain('js/terminal-charge.js');
      expect(src.indexOf('js/terminal-charge.js')).toBeLessThan(src.indexOf(controlador));
    }
  });

  it('el service worker lo guarda: sin señal el cobro con tarjeta no se queda sin pantalla', () => {
    expect(leer('sw.js')).toContain("'js/terminal-charge.js'");
  });
});
