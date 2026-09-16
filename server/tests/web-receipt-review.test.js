/**
 * La revisión de lo leído, del lado del navegador, y la pantalla que la enseña.
 *
 * Leer la foto es lo llamativo; esto es lo que evita que el inventario se envenene.
 * Se prueba aparte porque son reglas, no pintado: qué renglones hay que mirar, en qué
 * orden, y qué se manda al servidor.
 *
 * La regla que más importa aquí: un renglón que el programa no supo a qué insumo
 * corresponde sale SIN insumo, y la misma validación que protege la captura a mano lo
 * detiene. No hay un camino "rápido" que se salte la revisión.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const Review = require(path.join(ROOT, 'js', 'receipt-review.js'));
const Receiving = require(path.join(ROOT, 'js', 'receiving.js'));
const catalogo = require(path.join(ROOT, 'js', 'format.js'));

/** Lo que devuelve el servidor tras leer una factura de cinco renglones. */
const LEIDO = {
  text: '...',
  document_total: 6889.24,
  document_subtotal: 5939,
  document_tax: 950.24,
  lines_total: 5939,
  compared_against: 5939,
  total_matches: true,
  lines: [
    {
      text: '2 TEQUILA DON JULIO 70 750ML 900.00 1,800.00',
      description: 'TEQUILA DON JULIO 70 750ML',
      quantity: 2, unit_cost: 900, line_total: 1800, math: 'ok',
      supply_id: 's-tequila', supply_name: 'Tequila Don Julio 70 750 ml',
      candidates: [{ id: 's-tequila', name: 'Tequila Don Julio 70 750 ml', score: 0.82 }],
      confidence: 'high',
    },
    {
      text: '6 CERVEZA CORONA 355 ML 25.50 153.00',
      description: 'CERVEZA CORONA 355 ML',
      quantity: 6, unit_cost: 25.5, line_total: 153, math: 'ok',
      supply_id: 's-corona', supply_name: 'Cerveza Corona 355 ml',
      candidates: [{ id: 's-corona', name: 'Cerveza Corona 355 ml', score: 0.9 }],
      confidence: 'high',
    },
    {
      text: '1 RON BACARDI BLANCO 1L 320.00 320.00',
      description: 'RON BACARDI BLANCO 1L',
      quantity: 1, unit_cost: 320, line_total: 320, math: 'ok',
      // Dos rones se parecen igual: el servidor NO eligió, a propósito.
      supply_id: null, supply_name: null,
      candidates: [
        { id: 's-ron-blanco', name: 'Ron Bacardí Blanco 1 L', score: 0.61 },
        { id: 's-ron-anejo', name: 'Ron Bacardí Añejo 1 L', score: 0.58 },
      ],
      confidence: 'low',
    },
    {
      text: '12 AGUA MINERAL TOPO CHICO 600 18.OO 216.00',
      description: 'AGUA MINERAL TOPO CHICO 600',
      quantity: 12, unit_cost: 18, line_total: 250, math: 'mismatch',
      supply_id: 's-agua', supply_name: 'Agua mineral Topo Chico 600 ml',
      candidates: [{ id: 's-agua', name: 'Agua mineral Topo Chico 600 ml', score: 0.74 }],
      confidence: 'low',
    },
    {
      text: '3 WHISKY BUCHANANS 12 750ML 1,150.00',
      description: 'WHISKY BUCHANANS 12 750ML',
      quantity: 3, unit_cost: null, line_total: 1150, math: 'one_amount',
      supply_id: 's-whisky', supply_name: 'Whisky Buchanans 12 750 ml',
      candidates: [{ id: 's-whisky', name: 'Whisky Buchanans 12 750 ml', score: 0.71 }],
      confidence: 'medium',
    },
  ],
};

const SUPPLIES = [
  { id: 's-tequila', name: 'Tequila Don Julio 70 750 ml', package_size: 750, unit: 'ml', active: true },
  { id: 's-corona', name: 'Cerveza Corona 355 ml', package_size: 355, unit: 'ml', active: true },
  { id: 's-ron-blanco', name: 'Ron Bacardí Blanco 1 L', package_size: 1000, unit: 'ml', active: true },
  { id: 's-ron-anejo', name: 'Ron Bacardí Añejo 1 L', package_size: 1000, unit: 'ml', active: true },
  { id: 's-agua', name: 'Agua mineral Topo Chico 600 ml', package_size: 600, unit: 'ml', active: true },
  { id: 's-whisky', name: 'Whisky Buchanans 12 750 ml', package_size: 750, unit: 'ml', active: true },
];

describe('El orden de la revisión', () => {
  it('los dudosos primero, y dentro de cada grupo el orden del ticket', () => {
    const orden = Review.sortForReview(LEIDO.lines).map((l) => l.confidence);
    expect(orden).toEqual(['low', 'low', 'medium', 'high', 'high']);
    // Dentro de los dudosos se conserva el orden del papel: quien revisa va
    // comparando renglón por renglón y reordenarlos lo obligaría a buscar.
    const dudosos = Review.sortForReview(LEIDO.lines)
      .filter((l) => l.confidence === 'low').map((l) => l.description);
    expect(dudosos).toEqual(['RON BACARDI BLANCO 1L', 'AGUA MINERAL TOPO CHICO 600']);
  });
});

describe('De lo leído al borrador de captura', () => {
  const draft = () => Review.draftFromPhoto(LEIDO);

  it('trae cantidad y costo, siempre en presentaciones', () => {
    const tequila = draft().find((l) => l.supply_id === 's-tequila');
    // `packages` y no unidad base: una factura cobra por botella, nunca por mililitro.
    // Capturarlo como base convertiría "2 botellas" en "2 ml".
    expect(tequila).toMatchObject({ mode: 'packages', amount: '2', package_cost: '900' });
  });

  it('el renglón que el servidor no supo resolver llega SIN insumo', () => {
    const ron = draft().find((l) => l.read.description === 'RON BACARDI BLANCO 1L');
    expect(ron.supply_id).toBeNull();
    // Y con los dos candidatos a la mano, para que escoger sea un toque y no una
    // búsqueda entre ochocientos insumos.
    expect(ron.read.candidates.map((c) => c.name))
      .toEqual(['Ron Bacardí Blanco 1 L', 'Ron Bacardí Añejo 1 L']);
  });

  it('el costo que no se pudo leer llega vacío, no inventado', () => {
    const whisky = draft().find((l) => l.supply_id === 's-whisky');
    expect(whisky.package_cost).toBe('');
    expect(whisky.amount).toBe('3');
  });

  it('la MISMA validación que la captura a mano detiene lo que falta', () => {
    // No hay un camino "rápido" que se salte la revisión: el borrador que sale de la
    // foto pasa por `validateDraft`, igual que el que se teclea.
    const problemas = Receiving.validateDraft(draft(), SUPPLIES);
    const campos = problemas.map((p) => `${p.field}.${p.code}`);
    expect(campos).toContain('supply.required');
    expect(problemas.length).toBe(1);
  });

  it('con el insumo escogido a mano, ya se puede guardar', () => {
    const lines = draft();
    const ron = lines.find((l) => l.supply_id === null);
    ron.supply_id = 's-ron-blanco';
    const whisky = lines.find((l) => l.supply_id === 's-whisky');
    whisky.package_cost = '1150';
    expect(Receiving.validateDraft(lines, SUPPLIES)).toEqual([]);
  });

  it('lo leído NO viaja al servidor: solo insumo, cantidad y costo', () => {
    const lines = draft();
    lines.find((l) => l.supply_id === null).supply_id = 's-ron-blanco';
    const body = Receiving.receiptRequest({
      locationId: 'loc-1', lines, photoId: 'photo-1',
    });
    expect(body.photo_id).toBe('photo-1');
    for (const linea of body.lines) {
      expect(Object.keys(linea).sort()).toEqual(
        linea.package_cost === undefined
          ? ['packages', 'supply_id'] : ['package_cost', 'packages', 'supply_id'],
      );
    }
  });

  it('sin foto, el cuerpo no lleva photo_id', () => {
    const body = Receiving.receiptRequest({
      locationId: 'loc-1', lines: [{ supply_id: 's-corona', mode: 'packages', amount: '6', package_cost: '' }],
    });
    expect(body.photo_id).toBeUndefined();
  });
});

describe('Lo que se avisa antes de guardar', () => {
  it('cuenta los renglones y cuántos hay que revisar', () => {
    const resumen = Review.summary(LEIDO, Review.draftFromPhoto(LEIDO));
    expect(resumen.lines).toBe(5);
    // Tres: el ron sin insumo, el whisky sin costo y el agua, cuya cuenta no cuadra.
    expect(resumen.to_review).toBe(3);
    const draft = Review.draftFromPhoto(LEIDO);
    expect(Review.lineIssues(draft.find((l) => l.supply_id === 's-whisky')))
      .toEqual(['no_cost']);
    expect(Review.lineIssues(draft.find((l) => l.supply_id === 's-agua')))
      .toEqual(['math_mismatch']);
    expect(Review.lineIssues(draft.find((l) => l.supply_id === 's-tequila'))).toEqual([]);
  });

  it('compara la suma de los renglones con el papel', () => {
    const lines = Review.draftFromPhoto(LEIDO);
    lines.find((l) => l.supply_id === 's-whisky').package_cost = '1150';
    lines.find((l) => l.supply_id === null).supply_id = 's-ron-blanco';
    const resumen = Review.summary(LEIDO, lines);
    // 1800 + 153 + 320 + 216 + 3450 = 5939, que es el subtotal impreso.
    expect(resumen.total).toBe(5939);
    expect(resumen.paper_total).toBe(5939);
    expect(resumen.total_matches).toBe(true);
    expect(resumen.total_gap).toBe(0);
  });

  it('avisa cuando falta un renglón entero, que es lo que no se ve mirando la lista', () => {
    // Una revisión completa, menos el tequila: como si el OCR se hubiera comido ese
    // renglón por completo. Mirando la lista de cuatro no se nota nada raro; solo la
    // comparación contra el papel lo dice.
    const lines = Review.draftFromPhoto(LEIDO);
    lines.find((l) => l.supply_id === 's-whisky').package_cost = '1150';
    lines.find((l) => l.supply_id === null).supply_id = 's-ron-blanco';
    const resumen = Review.summary(LEIDO, lines.filter((l) => l.supply_id !== 's-tequila'));
    expect(resumen.total_matches).toBe(false);
    expect(resumen.total_gap).toBe(1800);
  });

  it('sin total impreso no inventa una comparación', () => {
    const sinPie = { ...LEIDO, compared_against: null, document_subtotal: null };
    const resumen = Review.summary(sinPie, Review.draftFromPhoto(LEIDO));
    expect(resumen.total_matches).toBeNull();
    expect(resumen.total_gap).toBeNull();
  });

  it('los renglones en blanco no cuentan ni estorban', () => {
    const lines = Review.draftFromPhoto(LEIDO)
      .concat([{ supply_id: null, mode: 'packages', amount: '', package_cost: '' }]);
    expect(Review.isBlank(lines[lines.length - 1])).toBe(true);
    expect(Review.summary(LEIDO, lines).lines).toBe(5);
  });
});

describe('Los estados de una foto', () => {
  it('cada estado tiene su texto y dice si ya se puede capturar', () => {
    expect(Review.statusOf('parsed').usable).toBe(true);
    expect(Review.statusOf('failed').usable).toBe(false);
    expect(Review.statusOf('used').done).toBe(true);
    expect(Review.statusOf('discarded').done).toBe(true);
    expect(Review.statusOf('cualquier-cosa').key).toBe('rc.stUnknown');
  });

  it('todo lo que la pantalla dice está traducido, en los dos idiomas', () => {
    const claves = Object.values(Review.STATUS).map((s) => s.key)
      .concat(['rc.stUnknown', 'rc.takePhoto', 'rc.reading', 'rc.photoHint', 'rc.use',
        'rc.viewPhoto', 'rc.reread', 'rc.discard', 'rc.discardWhy', 'rc.discarded',
        'rc.suggested', 'rc.allSupplies', 'rc.alreadyUploaded', 'rc.nothingRead',
        'rc.draftKept', 'rc.failedButSaved', 'rc.filled', 'rc.reviewCount',
        'rc.totalOk', 'rc.totalGap', 'rc.pendingPhotos', 'wh.close'])
      .concat(['high', 'medium', 'low'].map((c) => `rc.conf.${c}`))
      .concat(['ok', 'mismatch', 'derived_total', 'derived_unit', 'derived_quantity',
        'one_amount', 'incomplete'].map((m) => `rc.math.${m}`));
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltantes = claves.filter((k) => catalogo.t(k) === k);
      expect({ lang, faltantes }).toEqual({ lang, faltantes: [] });
    }
  });

  it('cada `math` que puede devolver el servidor tiene su texto', () => {
    // Si el servidor aprende un caso nuevo y nadie le pone texto, la pantalla
    // enseñaría la clave cruda al almacenista.
    const ocr = require('../src/services/receipt-ocr');
    const casos = [
      '6 CERVEZA CORONA 355 ML 25.50 153.00',
      '6 CERVEZA CORONA 25.50 200.00',
      '4 JUGO DE TORONJA 2L 22.00 88.00',
      '1 RON BACARDI BLANCO 1L 320.00',
      'CERVEZA CORONA 355ML 25.50 153.00',
      '4 JUGO DE TORONJA 2L 22.00',
    ];
    const valores = new Set(casos
      .map((texto) => ocr.reconcile(ocr.parseLine(texto)).math));
    catalogo.setLanguage('es');
    const faltantes = [...valores].filter((m) => catalogo.t(`rc.math.${m}`) === `rc.math.${m}`);
    expect(faltantes).toEqual([]);
  });
});

describe('La pantalla del almacén tiene dónde poner todo esto', () => {
  const html = leer('almacen.html');
  const controlador = leer('js/warehouse-screen.js');

  const abiertas = [];
  afterEach(() => { while (abiertas.length) abiertas.pop().close(); });

  function documento() {
    const dom = new JSDOM(html, { url: 'https://ev2.local/almacen.html' });
    abiertas.push(dom.window);
    return dom.window.document;
  }

  it('carga el módulo de la revisión', () => {
    expect(html).toContain('js/receipt-review.js');
    // Y antes del controlador que lo usa: al revés, `EV2ReceiptReview` no existe
    // todavía cuando la pantalla arranca.
    expect(html.indexOf('js/receipt-review.js'))
      .toBeLessThan(html.indexOf('js/warehouse-screen.js'));
  });

  it('cada id que busca el controlador existe en el HTML o lo pinta él mismo', () => {
    const doc = documento();
    const ids = new Set();
    const re = /\$\('([a-z0-9-]+)'\)/g;
    let m = re.exec(controlador);
    while (m) { ids.add(m[1]); m = re.exec(controlador); }
    // Los renglones de la captura los pinta el controlador dentro de `#list`, así que
    // vale que un id esté en sus plantillas y no en el archivo.
    const faltantes = [...ids].filter((id) => !doc.getElementById(id)
      && !controlador.includes(`id="${id}"`));
    expect(faltantes).toEqual([]);
  });

  it('el visor de la foto nace cerrado y sin imagen', () => {
    const doc = documento();
    const visor = doc.getElementById('photo-viewer');
    expect(visor.hasAttribute('hidden')).toBe(true);
    expect(doc.getElementById('photo-viewer-img').getAttribute('src')).toBeNull();
  });

  it('la imagen se pide con el token, no con un src directo', () => {
    // Una factura trae el RFC del club y los precios de compra: no es un archivo
    // público. Se trae con `getBlob` y se pinta desde un object URL.
    expect(controlador).toContain('api.getBlob(');
    expect(controlador).toContain('URL.revokeObjectURL');
    expect(html).not.toMatch(/<img[^>]+src="[^"]*receipt-photos/);
  });

  it('la subida va por multipart y con el campo que espera el servidor', () => {
    expect(controlador).toContain("form.append('photo'");
    expect(controlador).toContain('api.postForm(');
  });

  it('el botón de la cámara pide la de atrás', () => {
    // El campo lo pinta el controlador dentro de `#list`, así que se comprueba en su
    // plantilla. `capture="environment"`: con la frontal, el almacenista se fotografía
    // a sí mismo en vez del ticket, y lo descubre después de subirla.
    expect(controlador).toMatch(
      /id="photo-input"[^>]*type="file"[^>]*accept="image\/\*"[^>]*capture="environment"/);
  });
});
