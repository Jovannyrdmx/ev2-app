/**
 * El corte del turno en la pantalla de quien cobra (D51).
 *
 * Lo que se prueba aquí es lo único que vive en el navegador: qué se le enseña a un
 * mesero con la bolsa llena y qué se le impide hacer. El cálculo de lo cobrado NO está
 * aquí a propósito —lo hace el servidor con lo que esa persona de verdad cobró— y por
 * eso no hay ninguna prueba que lo compruebe en este archivo: no habría nada que
 * comprobar.
 */
'use strict';

const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..', 'web');
const Cut = require(path.join(ROOT, 'js', 'shift-cut.js'));
const catalogo = require(path.join(ROOT, 'js', 'format.js'));

const t = (k) => k;

const corteAbierto = (over = {}) => ({
  shift: { id: 's1', started_at: '2026-09-23T04:00:00Z', ended_at: null },
  totals: {
    currency: 'MXN',
    by_method: [
      { method: 'cash', currency: 'MXN', amount: '3000.00', count: 6 },
      { method: 'card_terminal', currency: 'MXN', amount: '4500.00', count: 3 },
    ],
    cash_collected: '3000.00',
    total_collected: '7500.00',
    tips: { amount: '450.00', count: 2 },
  },
  drops: [],
  drops_received: '0.00',
  drops_pending: 0,
  cash_to_hand: '3000.00',
  closing: null,
  ...over,
});

describe('Lo que ve quien cobra', () => {
  it('enseña cada método por separado, y la propina aparte', () => {
    const lineas = Cut.lines(corteAbierto(), t);
    expect(lineas.map((l) => l.key)).toEqual(['cash', 'card_terminal', 'tips']);
    expect(lineas[0]).toMatchObject({ value: '3000.00', cash: true });
    // La tarjeta no se entrega: ese dinero ya está en la cuenta del club.
    expect(lineas[1].cash).toBe(false);
    // La propina es suya: va marcada como lo que no se suma a lo que entrega.
    expect(lineas[2]).toMatchObject({ key: 'tips', aside: true, cash: false });
  });

  it('sin propinas no inventa un renglón en cero', () => {
    const sin = corteAbierto();
    sin.totals.tips = { amount: '0.00', count: 0 };
    expect(Cut.lines(sin, t).map((l) => l.key)).toEqual(['cash', 'card_terminal']);
  });

  it('dice en qué va el corte, sin adivinar', () => {
    expect(Cut.statusKey(null)).toBe('cut.noShift');
    expect(Cut.statusKey(corteAbierto())).toBe('cut.open');
    // Desde D54 no hay estado intermedio: el corte se cierra en un acto, con el gerente.
    expect(Cut.statusKey(corteAbierto({ closing: { status: 'confirmed' } }))).toBe('cut.confirmed');
  });

  it('cada texto existe en español y en inglés', () => {
    const claves = [...Object.values(Cut.METHOD_KEY), 'cut.mOther', 'cut.title', 'cut.toHand',
      'cut.handed', 'cut.tips', 'cut.drop', 'cut.declare', 'cut.noShift', 'cut.open',
      'cut.confirmed', 'cut.errAmount', 'cut.errTooMuch',
      'cut.errNoShift', 'cut.errShiftClosed', 'cut.errAlready', 'cut.drop.declared',
      'cut.drop.received', 'cut.drop.rejected', 'cut.confirmDeclare', 'cut.sending',
      'cut.dropSent', 'cut.declared', 'cut.close', 'cut.amount', 'cut.hint'];
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      expect({ lang, faltan: claves.filter((k) => catalogo.t(k) === k) }).toEqual({ lang, faltan: [] });
    }
  });
});

describe('Lo que NO se deja hacer', () => {
  it('no se entrega más efectivo del que se cobró', () => {
    // O el número está mal tecleado, o ese dinero no es del club. Las dos cosas se
    // paran antes de que alguien suelte los billetes.
    expect(Cut.dropBlocker(3500, corteAbierto())).toBe('cut.errTooMuch');
    expect(Cut.dropBlocker(3000, corteAbierto(), { reason: 'Caja llena', pin: '123456' })).toBeNull();
  });

  it('un retiro sin motivo o sin el código del gerente no sale (D54)', () => {
    expect(Cut.dropBlocker(3000, corteAbierto(), { reason: '', pin: '123456' })).toBe('cut.errReason');
    expect(Cut.dropBlocker(3000, corteAbierto(), { reason: 'Caja llena', pin: '12' })).toBe('cut.errPin');
  });

  it('ni cero, ni letras, ni negativos', () => {
    for (const malo of [0, -100, 'mucho', null, undefined, NaN]) {
      expect(Cut.dropBlocker(malo, corteAbierto())).toBe('cut.errAmount');
    }
  });

  it('sin turno abierto no se entrega nada', () => {
    expect(Cut.dropBlocker(100, null)).toBe('cut.errNoShift');
    expect(Cut.dropBlocker(100, corteAbierto({ shift: { id: 's1', ended_at: '2026-09-23T10:00:00Z' } })))
      .toBe('cut.errShiftClosed');
  });

  it('el corte no se declara dos veces', () => {
    const pin = { pin: '123456' };
    expect(Cut.closeBlocker(3000, corteAbierto(), pin)).toBeNull();
    // Cero SÍ es válido al cerrar si es lo que se debía: con la diferencia, se explica.
    expect(Cut.closeBlocker(0, corteAbierto(), pin)).toBe('cut.errDiffReason');
    expect(Cut.closeBlocker(0, corteAbierto(), { ...pin, reason: 'Faltante, se aclara' })).toBeNull();
    expect(Cut.closeBlocker(3000, corteAbierto(), {})).toBe('cut.errPin');
    expect(Cut.closeBlocker(3000, corteAbierto({ closing: { status: 'confirmed' } }), pin))
      .toBe('cut.errAlready');
  });
});

describe('La hoja, contra el DOM de verdad', () => {
  const abiertas = [];
  afterEach(() => { while (abiertas.length) abiertas.pop().window.close(); });

  function montar(cut, api) {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ev2.local/staff.html' });
    abiertas.push(dom);
    const hoja = Cut.createSheet({
      document: dom.window.document,
      api: api || { get: () => Promise.resolve(cut), post: () => Promise.resolve({}) },
      clubId: () => 'c1',
      t: (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k),
      money: (n) => `$${Number(n).toFixed(2)}`,
      errorMessage: (e) => e.message,
    });
    return { dom, hoja, doc: dom.window.document };
  }

  it('al abrirla, el monto a entregar viene puesto: nadie lo teclea a las tres de la mañana', async () => {
    const { hoja, doc } = montar(corteAbierto());
    await hoja.open();
    expect(doc.getElementById('cut-tohand').textContent).toBe('$3000.00');
    expect(doc.getElementById('cut-amount').value).toBe('3000.00');
    expect(doc.getElementById('cut-sheet').hidden).toBe(false);
  });

  it('lo ya entregado se descuenta a la vista', async () => {
    const conEntrega = corteAbierto({
      drops: [{ id: 'd1', amount: '1000.00', counted_amount: '1000.00', status: 'received' }],
      drops_received: '1000.00',
      cash_to_hand: '2000.00',
    });
    const { hoja, doc } = montar(conEntrega);
    await hoja.open();
    expect(doc.getElementById('cut-handed').textContent).toBe('$1000.00');
    expect(doc.getElementById('cut-tohand').textContent).toBe('$2000.00');
    expect(doc.getElementById('cut-drops').textContent).toMatch(/cut\.drop\.received/);
  });

  it('con el corte ya cerrado, los botones se apagan', async () => {
    const { hoja, doc } = montar(corteAbierto({ closing: { status: 'confirmed' } }));
    await hoja.open();
    expect(doc.getElementById('cut-drop').disabled).toBe(true);
    expect(doc.getElementById('cut-declare').disabled).toBe(true);
    expect(doc.getElementById('cut-status').textContent).toBe('cut.confirmed');
  });

  it('si el servidor no contesta, lo dice en vez de enseñar ceros', async () => {
    const { hoja, doc } = montar(null, {
      get: () => Promise.reject(new Error('sin red')),
      post: () => Promise.resolve({}),
    });
    await hoja.open();
    expect(doc.getElementById('cut-error').hidden).toBe(false);
    expect(doc.getElementById('cut-error').textContent).toBe('sin red');
  });
});

// ============================================================================
// D86: los dólares se cuentan aparte
// ============================================================================

describe('El corte con dólares (D86)', () => {
  const conDolares = (over = {}) => corteAbierto({
    totals: {
      ...corteAbierto().totals,
      by_method: [
        { method: 'cash', currency: 'MXN', amount: '3000.00', count: 6 },
        { method: 'cash_usd', currency: 'MXN', amount: '120.00', count: 1 },
      ],
      usd: { received: '10.00', change_given_mxn: '53.00', count: 1 },
    },
    cash_to_hand: '2947.00',
    usd_to_hand: '10.00',
    ...over,
  });

  it('enseña el cambio en pesos que salió del cajón', () => {
    const lineas = Cut.lines(conDolares(), t);
    expect(lineas.find((l) => l.key === 'usd_change')).toMatchObject({ value: '-53.00', cash: true });
    expect(Cut.hasUsd(conDolares())).toBe(true);
    expect(Cut.hasUsd(corteAbierto())).toBe(false);
  });

  it('con dólares, no se cierra sin contarlos; una diferencia en dólares pide motivo', () => {
    const c = conDolares();
    expect(Cut.closeBlocker('2947', c, { pin: '123456' })).toBe('cut.errUsdCounted');
    expect(Cut.closeBlocker('2947', c, { pin: '123456', countedUsd: '10' })).toBeNull();
    expect(Cut.closeBlocker('2947', c, { pin: '123456', countedUsd: '5' })).toBe('cut.errDiffReason');
    expect(Cut.closeBlocker('2947', c, { pin: '123456', countedUsd: '5', reason: 'billete falso' })).toBeNull();
    // Sin dólares en el turno, no se piden.
    expect(Cut.closeBlocker('3000', corteAbierto(), { pin: '123456' })).toBeNull();
  });

  it('el retiro en dólares sale de los dólares', () => {
    const c = conDolares();
    const base = { reason: 'Al banco', pin: '123456' };
    expect(Cut.dropBlocker(20, c, { ...base, currency: 'USD' })).toBe('cut.errTooMuch');
    expect(Cut.dropBlocker(6, c, { ...base, currency: 'USD' })).toBeNull();
    expect(Cut.dropBlocker(2947, c, base)).toBeNull();
  });
});

describe('El corte a ciegas (D105)', () => {
  const ciego = (over = {}) => corteAbierto({
    blind: true,
    cash_to_hand: null,
    totals: {
      currency: 'MXN',
      by_method: [
        { method: 'cash', currency: 'MXN', amount: null, count: 6 },
        { method: 'card_terminal', currency: 'MXN', amount: '4500.00', count: 3 },
      ],
      cash_collected: null,
      total_collected: null,
      usd: { received: null, change_given_mxn: null, count: 0, any: false },
      tips: { amount: '0.00', count: 0 },
    },
    declaration: null,
    ...over,
  });

  function montar(cut, posts = []) {
    const dom = new JSDOM('<!doctype html><body></body>');
    const hoja = Cut.createSheet({
      document: dom.window.document,
      api: { get: () => Promise.resolve(cut), post: (u, b) => { posts.push([u, b]); return Promise.resolve({}); } },
      clubId: () => 'c1',
      t: (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k),
      money: (n) => `$${Number(n).toFixed(2)}`,
      errorMessage: (e) => e.message,
    });
    return { hoja, doc: dom.window.document };
  }

  it('sabe en qué paso va: contar, y luego que el gerente cierre', () => {
    expect(Cut.blindStep(corteAbierto())).toBeNull();
    expect(Cut.blindStep(ciego())).toBe('count');
    expect(Cut.blindStep(ciego({ declaration: { declared_cash: '2900.00', declared_usd: null } }))).toBe('close');
  });

  it('el conteo pide un número, y con dólares pide también los dólares', () => {
    expect(Cut.countBlocker('', ciego())).toBe('cut.errAmount');
    expect(Cut.countBlocker('2900', ciego())).toBeNull();
    const conUsd = ciego({ totals: { ...ciego().totals, usd: { received: null, count: 1, any: true } } });
    expect(Cut.countBlocker('2900', conUsd)).toBe('cut.errUsdCounted');
    expect(Cut.countBlocker('2900', conUsd, { usd: '20' })).toBeNull();
  });

  it('no compara contra lo esperado: eso lo hace el servidor con el código del gerente', () => {
    const cut = ciego({ declaration: { declared_cash: '2900.00', declared_usd: null } });
    expect(Cut.closeBlocker(2900, cut, { counted: '2800', pin: '123456' })).toBeNull();
    expect(Cut.dropBlocker(999999, cut, { reason: 'retiro', pin: '123456' })).toBeNull();
  });

  it('al abrirla no enseña ni pone lo que toca entregar; los montos en efectivo salen ocultos', async () => {
    const { hoja, doc } = montar(ciego());
    await hoja.open();
    expect(doc.getElementById('cut-tohand-row').hidden).toBe(true);
    expect(doc.getElementById('cut-amount').value).toBe('');
    expect(doc.getElementById('cut-blind').hidden).toBe(false);
    expect(doc.getElementById('cut-lines').textContent).toMatch(/cut\.hidden/);
    expect(doc.getElementById('cut-lines').textContent).toMatch(/4500\.00/);
    expect(doc.getElementById('cut-declare').textContent).toBe('cut.saveCount');
    expect(doc.getElementById('cut-counted').hidden).toBe(true);
  });

  it('ya guardado el conteo, el botón cierra el corte sin volver a mandar lo declarado', async () => {
    const posts = [];
    const { hoja, doc } = montar(ciego({ declaration: { declared_cash: '2900.00', declared_usd: null } }), posts);
    await hoja.open();
    expect(doc.getElementById('cut-declare').textContent).toBe('cut.closeCut');
    expect(doc.getElementById('cut-blind').textContent).toMatch(/cut\.countSaved/);
    doc.getElementById('cut-pin').value = '123456';
    doc.getElementById('cut-declare').click();
    await new Promise((r) => setTimeout(r, 0));
    const cierre = posts.find(([u]) => u.endsWith('/shifts/me/closing'));
    expect(cierre).toBeTruthy();
    expect(cierre[1].declared_cash).toBeUndefined();
    expect(cierre[1].manager_pin).toBe('123456');
  });
});
