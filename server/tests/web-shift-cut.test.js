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
    expect(Cut.statusKey(corteAbierto({ closing: { status: 'declared' } }))).toBe('cut.waitingManager');
    expect(Cut.statusKey(corteAbierto({ closing: { status: 'confirmed' } }))).toBe('cut.confirmed');
  });

  it('cada texto existe en español y en inglés', () => {
    const claves = [...Object.values(Cut.METHOD_KEY), 'cut.mOther', 'cut.title', 'cut.toHand',
      'cut.handed', 'cut.tips', 'cut.drop', 'cut.declare', 'cut.noShift', 'cut.open',
      'cut.waitingManager', 'cut.confirmed', 'cut.errAmount', 'cut.errTooMuch',
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
    expect(Cut.dropBlocker(3000, corteAbierto())).toBeNull();
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
    expect(Cut.closeBlocker(3000, corteAbierto())).toBeNull();
    // Cero SÍ es válido al cerrar: alguien que solo cobró con tarjeta no entrega nada.
    expect(Cut.closeBlocker(0, corteAbierto())).toBeNull();
    expect(Cut.closeBlocker(3000, corteAbierto({ closing: { status: 'declared' } })))
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

  it('con el corte ya declarado, los botones se apagan: le toca al gerente', async () => {
    const { hoja, doc } = montar(corteAbierto({ closing: { status: 'declared' } }));
    await hoja.open();
    expect(doc.getElementById('cut-drop').disabled).toBe(true);
    expect(doc.getElementById('cut-declare').disabled).toBe(true);
    expect(doc.getElementById('cut-status').textContent).toBe('cut.waitingManager');
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
