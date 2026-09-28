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

describe('Lo que la guía de Point añade a la espera', () => {
  it('con la terminal ya mostrando el cobro, el titular lo dice', () => {
    expect(T.headline('waiting', { at_terminal: true }).key).toBe('pay.termAtTerminal');
    expect(T.headline('waiting', { at_terminal: false }).key).toBe('pay.termWaiting');
    // Sin el cobro a la mano sigue funcionando como antes.
    expect(T.headline('waiting').key).toBe('pay.termWaiting');
  });

  it('los detalles documentados salen en español; los demás, tal cual', () => {
    expect(T.detailKey('bad_filled_card_data')).toBe('pay.detBadCard');
    expect(T.detailKey('insufficient_amount')).toBe('pay.detInsufficient');
    expect(T.detailKey('un_codigo_que_no_conocemos')).toBeNull();
    expect(T.detailKey(null)).toBeNull();
  });

  it('cada texto nuevo existe en los dos idiomas', () => {
    const claves = ['pay.termAtTerminal', 'pay.termTip', ...Object.values(T.DETAIL_KEYS)];
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      expect({ lang, faltan: claves.filter((k) => catalogo.t(k) === k) }).toEqual({ lang, faltan: [] });
    }
  });

  it('la propina se enseña en el cobro pagado', () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    const hoja = T.createSheet({
      document: dom.window.document,
      api: { get: () => new Promise(() => {}), post: () => Promise.resolve({}) },
      clubId: () => 'c', t: (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k),
      money: (a) => `$${a}`, errorMessage: (e) => e.message,
    });
    hoja.watch({
      id: 'x', status: 'processed', status_detail: 'accredited', amount: '450.00',
      currency: 'MXN', tip_amount: '50.00', terminal: { label: 'Barra' },
    });
    const detalle = dom.window.document.getElementById('term-detail').textContent;
    expect(detalle).toMatch(/pay\.detAccredited/);
    expect(detalle).toMatch(/pay\.termTip.*\$50\.00/);
    hoja.close();
    dom.window.close();
  });
});

// ============================================================================

/**
 * El cuadro del cobro siempre tiene salida (D65).
 *
 * El defecto: "Cerrar" estaba oculto mientras el cobro no fuera final, el cuadro es
 * un modal a pantalla completa sin X ni cierre por fondo, y el sondeo atrapaba los
 * errores en silencio y se reprogramaba cada ocho segundos para siempre.
 *
 * A las dos de la mañana, con la fila esperando, si la terminal dejaba de contestar el
 * cantinero se quedaba con el cuadro girando y la única salida era recargar la página.
 */
describe('Salir del cobro cuando la terminal no contesta (D65)', () => {
  // El defecto: "Cerrar" estaba oculto mientras el cobro no fuera final, el cuadro es
  // un modal a pantalla completa sin X ni cierre por fondo, y el sondeo atrapaba los
  // errores en silencio y se reprogramaba para siempre. A las dos de la mañana, si la
  // terminal dejaba de contestar, la única salida era recargar la página.
  const ventanas = [];
  const ventana = () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>',
      { url: 'https://ev2.local/staff.html' });
    ventanas.push(dom.window);
    return dom.window;
  };
  afterAll(() => { for (const w of ventanas) w.close(); });

  const esperar = (ms) => new Promise((r) => { setTimeout(r, ms); });
  // Un cobro ya vencido abre la salida en la PRIMERA consulta: es el mismo camino que
  // el fallo de red, sin esperar los tres intentos reales que tardarían medio minuto.
  const vencido = {
    id: 'ch1', amount: '250.00', currency: 'MXN', status: 'waiting',
    terminal: { label: 'Barra baja' },
    expires_at: new Date(Date.now() - 1000).toISOString(),
  };

  function hoja(over) {
    const win = ventana();
    const h = T.createSheet({
      document: win.document,
      api: { get: () => Promise.resolve({ charge: { ...vencido } }), post: () => Promise.resolve({}) },
      clubId: () => 'club',
      t: (k) => k,
      money: (a) => String(a),
      errorMessage: () => 'error',
      confirm: () => true,
      ...over,
    });
    return { hoja: h, $: (id) => win.document.getElementById(id) };
  }

  it('un cobro sin resolver acaba dando salida, y avisa que PUDO haber pasado', async () => {
    // El aviso importa tanto como el botón: el texto no dice "falló", dice "no
    // sabemos". Es lo que impide volver a cobrar y cobrarle dos veces al cliente.
    const { hoja: h, $ } = hoja();
    h.watch(vencido);
    expect($('term-close').hasAttribute('hidden')).toBe(true); // al abrir, no
    await esperar(1900);
    expect($('term-close').hasAttribute('hidden')).toBe(false);
    expect($('term-close').textContent).toBe('pay.termLeave');
    expect($('term-detail').textContent).toBe('pay.termUnknown');
    h.close();
  }, 15000);

  it('deja de preguntar en vez de sondear toda la noche', async () => {
    let intentos = 0;
    const { hoja: h } = hoja({
      api: {
        get: () => { intentos += 1; return Promise.resolve({ charge: { ...vencido } }); },
        post: () => Promise.resolve({}),
      },
    });
    h.watch(vencido);
    await esperar(1900);
    const tras = intentos;
    await esperar(3000);
    expect(intentos).toBe(tras);
    h.close();
  }, 15000);

  it('una vez abierta, la salida NO se vuelve a esconder', async () => {
    // El defecto exacto: `pintar()` recalculaba `hidden` en cada repintado.
    const { hoja: h, $ } = hoja();
    h.watch(vencido);
    await esperar(1900);
    expect($('term-close').hasAttribute('hidden')).toBe(false);
    h.onEvent({ payload: { charge_id: 'ch1' } }); // fuerza un repintado
    await esperar(300);
    expect($('term-close').hasAttribute('hidden')).toBe(false);
    h.close();
  }, 15000);

  it('salirse de un cobro sin terminar pregunta antes', async () => {
    let preguntado = null;
    let cerrado = false;
    const { hoja: h, $ } = hoja({
      confirm: (texto) => { preguntado = texto; return false; },
      onClose: () => { cerrado = true; },
    });
    h.watch(vencido);
    await esperar(1900);
    $('term-close').click();
    expect(preguntado).toBe('pay.termLeaveConfirm');
    expect(cerrado).toBe(false);
    expect($('term-sheet').hasAttribute('hidden')).toBe(false);
    h.close();
  }, 15000);

  it('un cobro PAGADO se cierra sin preguntar nada', async () => {
    // El arreglo no puede volver molesto el camino bueno.
    let preguntas = 0;
    let cerrado = false;
    const { hoja: h, $ } = hoja({
      api: {
        get: () => Promise.resolve({ charge: { ...vencido, status: 'processed' } }),
        post: () => Promise.resolve({}),
      },
      confirm: () => { preguntas += 1; return true; },
      onClose: () => { cerrado = true; },
    });
    h.watch(vencido);
    await esperar(1900);
    expect($('term-close').textContent).toBe('pay.termDone');
    $('term-close').click();
    expect(preguntas).toBe(0);
    expect(cerrado).toBe(true);
  }, 15000);

  it('una sola consulta fallida no abre la salida: puede ser el internet del club', () => {
    // La constante es la regla: tres seguidas, no una.
    expect(T.FALLOS_PARA_SALIR).toBe(3);
  });
});
