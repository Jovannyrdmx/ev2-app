/**
 * La entrada en lote y los pedidos de barra, del lado del navegador.
 *
 * Tres cosas se prueban aquí, y las tres han roto pantallas antes:
 *
 * 1. **La aritmética del borrador.** Quince renglones, cajas a mililitros, costo de
 *    la presentación a costo de la unidad base, y el total. Equivocarse aquí no
 *    revienta nada: deja una entrada capturada de 750 unidades en vez de 750 ml, y
 *    nadie se enteraría hasta el corte.
 *
 * 2. **Que los `id` existan.** `warehouse-screen.js` y `bartender-screen.js` buscan
 *    sus elementos con `$('id')`. Un `id` que falta no falla al cargar: revienta
 *    cuando el almacenista ya tiene el camión enfrente.
 *
 * 3. **Que se pueda anticipar el estado del pedido.** El almacenista tiene que
 *    saber que va a dejar el pedido a medias ANTES de mandarlo, para poder
 *    decírselo a la barra en vez de que el cantinero lo descubra esperando.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const almacenHtml = leer('almacen.html');
const bartenderHtml = leer('bartender.html');
const warehouseJs = leer('js/warehouse-screen.js');
const bartenderJs = leer('js/bartender-screen.js');
const R = require(path.join(ROOT, 'js', 'receiving.js'));
const catalogo = require(path.join(ROOT, 'js', 'format.js'));

const abiertas = [];
afterEach(() => { while (abiertas.length) abiertas.pop().close(); });

function documento(fuente) {
  const dom = new JSDOM(fuente, { url: 'https://ev2.systems/almacen.html' });
  abiertas.push(dom.window);
  return dom.window.document;
}

/** Los insumos del club real, en las presentaciones que de verdad usa. */
const WHISKY = { id: 'w1', name: 'Buchanans 12', unit: 'ml', package_size: 750, package_label: 'Botella 750 ml', active: true };
const RON = { id: 'r1', name: 'Bacardi Blanco', unit: 'ml', package_size: 1000, package_label: 'Botella 1 L', active: true };
const REFRESCO = { id: 'c1', name: 'Coca Cola', unit: 'ml', package_size: 355, package_label: 'Lata 355 ml', active: true };
const SUPPLIES = [WHISKY, RON, REFRESCO];

const line = (over = {}) => ({ ...R.emptyLine(), ...over });

// ===========================================================================
// El HTML y sus controladores se encuentran
// ===========================================================================

describe('almacen.html tiene lo que su controlador busca', () => {
  const NECESARIOS = [
    'count-entry', 'count-requests', 'search-wrap',
    'sheet-supplier', 'supplier-close', 'form-supplier',
    'supplier-name', 'supplier-contact', 'supplier-phone', 'supplier-error',
    'sheet-fulfill', 'fulfill-close', 'fulfill-bar', 'fulfill-from',
    'fulfill-lines', 'fulfill-preview', 'fulfill-error', 'fulfill-submit',
  ];

  it.each(NECESARIOS)('el id "%s" existe', (id) => {
    expect(documento(almacenHtml).getElementById(id)).not.toBeNull();
  });

  it('tiene las dos pestañas nuevas', () => {
    const doc = documento(almacenHtml);
    const tabs = [...doc.querySelectorAll('[data-tab]')].map((b) => b.dataset.tab);
    expect(tabs).toContain('entrada');
    expect(tabs).toContain('pedidos');
  });

  it('las dos hojas nuevas nacen ocultas', () => {
    const doc = documento(almacenHtml);
    expect(doc.getElementById('sheet-supplier').hidden).toBe(true);
    expect(doc.getElementById('sheet-fulfill').hidden).toBe(true);
  });

  it('carga receiving.js antes del controlador', () => {
    expect(almacenHtml.indexOf('js/receiving.js'))
      .toBeLessThan(almacenHtml.indexOf('js/warehouse-screen.js'));
    expect(almacenHtml.indexOf('js/receiving.js')).toBeGreaterThan(-1);
  });

  it('el controlador no busca ningún id que no exista', () => {
    expect(idsPerdidos(almacenHtml, warehouseJs)).toEqual([]);
  });
});

/**
 * Los `id` que el controlador busca y nadie crea.
 *
 * Un `id` puede vivir en el HTML o en una plantilla del propio controlador (la
 * captura de la entrada se pinta desde JavaScript). Las dos cuentan; lo que no
 * cuenta —y es el error que se persigue— es un `$('algo')` que no existe en ninguna
 * de las dos, porque eso no falla al cargar la página: falla cuando el almacenista
 * ya tiene el camión enfrente.
 */
function idsPerdidos(html, js) {
  const doc = documento(html);
  const creados = new Set();
  const reCreado = /id="([a-z0-9-]+)"/g;
  let c = reCreado.exec(js);
  while (c) { creados.add(c[1]); c = reCreado.exec(js); }

  const buscados = new Set();
  const reBuscado = /\$\('([a-z0-9-]+)'\)/g;
  let m = reBuscado.exec(js);
  while (m) { buscados.add(m[1]); m = reBuscado.exec(js); }

  return [...buscados].filter((id) => doc.getElementById(id) === null && !creados.has(id));
}

describe('bartender.html tiene lo que su controlador busca', () => {
  const NECESARIOS = [
    'btn-restock', 'restock-pending', 'req-sheet', 'req-bar', 'btn-req-close',
    'req-count-mine', 'req-body', 'req-footer', 'req-note', 'btn-req-send', 'req-error',
  ];

  it.each(NECESARIOS)('el id "%s" existe', (id) => {
    expect(documento(bartenderHtml).getElementById(id)).not.toBeNull();
  });

  it('la hoja de pedir nace oculta y el contador del botón también', () => {
    const doc = documento(bartenderHtml);
    expect(doc.getElementById('req-sheet').hidden).toBe(true);
    // El número solo aparece cuando de verdad hay algo pedido sin llegar.
    expect(doc.getElementById('restock-pending').hidden).toBe(true);
  });

  it('el controlador de la barra no busca ningún id que no exista', () => {
    expect(idsPerdidos(bartenderHtml, bartenderJs)).toEqual([]);
  });

  it('carga receiving.js antes del controlador', () => {
    expect(bartenderHtml.indexOf('js/receiving.js'))
      .toBeLessThan(bartenderHtml.indexOf('js/bartender-screen.js'));
  });
});

// ===========================================================================
// Los textos, en los dos idiomas
// ===========================================================================

describe('los textos nuevos están en español y en inglés', () => {
  const CLAVES = [
    'wh.tabEntry', 'wh.tabRequests', 'wh.entryInto', 'wh.supplier', 'wh.noSupplier',
    'wh.newSupplier', 'wh.entryLines', 'wh.entryAddLine', 'wh.entrySave', 'wh.entrySaved',
    'wh.entryTotalPartial', 'wh.entryFixLines', 'wh.emptyRequests',
    'wh.fulfillTitle', 'wh.fulfillFrom', 'wh.fulfillSend', 'wh.fulfillPendingOf',
    'wh.fulfillWillComplete', 'wh.fulfillWillPartial', 'wh.fulfilledAll', 'wh.fulfilledPartial',
    'req.ask', 'req.title', 'req.tabNew', 'req.tabMine', 'req.send', 'req.sent',
    'req.nothingLow', 'req.noneYet', 'req.lowHere', 'req.toBuy', 'req.toBuyNote',
    'req.stillMissing', 'req.arrived', 'req.cancel', 'req.cancelWhy',
  ];

  it.each(CLAVES)('la clave "%s" está en los dos idiomas', (clave) => {
    for (const idioma of ['es', 'en']) {
      catalogo.setLanguage(idioma);
      expect(catalogo.t(clave)).not.toBe(clave);
    }
    catalogo.setLanguage('es');
  });

  it('cada estado de pedido tiene texto en las dos pantallas y los dos idiomas', () => {
    for (const estado of Object.keys(R.REQUEST_STATUS)) {
      for (const idioma of ['es', 'en']) {
        catalogo.setLanguage(idioma);
        expect(catalogo.t(`wh.requestStatus.${estado}`)).not.toBe(`wh.requestStatus.${estado}`);
        expect(catalogo.t(`req.status.${estado}`)).not.toBe(`req.status.${estado}`);
      }
    }
    catalogo.setLanguage('es');
  });

  it('cada código del validador tiene su frase', () => {
    // Si un código no tiene texto, la pantalla enseña "Revisa este renglón" en vez
    // de decir qué pasa. Es el aviso menos útil posible, así que se comprueban todos.
    const problemas = R.validateDraft([
      line({ supply_id: null, amount: '2' }),
      line({ supply_id: 'fantasma', amount: '2' }),
      line({ supply_id: WHISKY.id, amount: '0' }),
      line({ supply_id: RON.id, amount: '1', package_cost: '-5' }),
      line({ supply_id: RON.id, amount: '1' }),
    ], SUPPLIES);

    catalogo.setLanguage('es');
    const codigos = [...new Set(problemas.map((p) => `${p.field}.${p.code}`))];
    expect(codigos.length).toBeGreaterThan(3);
    for (const codigo of codigos) {
      expect(catalogo.t(`wh.entryErr.${codigo}`)).not.toBe(`wh.entryErr.${codigo}`);
    }
  });
});

// ===========================================================================
// La aritmética del borrador
// ===========================================================================

describe('EV2Receiving.lineTotals', () => {
  it('cajas a unidad base: 6 botellas de 750 ml son 4,500 ml', () => {
    const r = R.lineTotals(line({ supply_id: WHISKY.id, mode: 'packages', amount: '6' }), WHISKY);
    expect(r.quantity).toBe(4500);
    expect(r.packages).toBe(6);
  });

  it('en unidad base no multiplica: 4,500 ml son 4,500 ml', () => {
    const r = R.lineTotals(line({ mode: 'base', amount: '4500' }), WHISKY);
    expect(r.quantity).toBe(4500);
    expect(r.packages).toBe(6);
  });

  it('el costo es de la PRESENTACIÓN, no del mililitro', () => {
    const r = R.lineTotals(
      line({ mode: 'packages', amount: '6', package_cost: '900' }), WHISKY);
    // 6 botellas x $900. Si se tomara como costo por ml, saldría $4,050,000.
    expect(r.total).toBe(5400);
  });

  it('con la cantidad en unidad base, el costo sigue siendo por presentación', () => {
    const r = R.lineTotals(
      line({ mode: 'base', amount: '4500', package_cost: '900' }), WHISKY);
    expect(r.total).toBe(5400);
  });

  it('sin costo el importe es null, no cero', () => {
    // Cero diría "entró gratis". null dice "no se capturó el costo", que es otra
    // cosa y es la que hace que el total no cuadre con la factura.
    const r = R.lineTotals(line({ mode: 'packages', amount: '6' }), WHISKY);
    expect(r.total).toBeNull();
  });

  it('sin insumo o sin cantidad no calcula nada', () => {
    expect(R.lineTotals(line({ amount: '6' }), null).quantity).toBeNull();
    expect(R.lineTotals(line({ amount: '' }), WHISKY).quantity).toBeNull();
    expect(R.lineTotals(line({ amount: 'abc' }), WHISKY).quantity).toBeNull();
  });
});

describe('EV2Receiving.draftSummary', () => {
  it('suma el total de la entrega', () => {
    const resumen = R.draftSummary([
      line({ supply_id: WHISKY.id, amount: '6', package_cost: '900' }),
      line({ supply_id: RON.id, amount: '10', package_cost: '320' }),
      line({ supply_id: REFRESCO.id, amount: '24', package_cost: '18' }),
    ], SUPPLIES);

    expect(resumen.lines).toBe(3);
    expect(resumen.total).toBe(9032);
    expect(resumen.total_is_complete).toBe(true);
  });

  it('avisa que el total no cuadra si falta un costo', () => {
    const resumen = R.draftSummary([
      line({ supply_id: WHISKY.id, amount: '6', package_cost: '900' }),
      line({ supply_id: RON.id, amount: '10' }),
    ], SUPPLIES);
    expect(resumen.total).toBe(5400);
    expect(resumen.total_is_complete).toBe(false);
  });

  it('el renglón vacío del final no cuenta', () => {
    const resumen = R.draftSummary([
      line({ supply_id: WHISKY.id, amount: '6', package_cost: '900' }),
      R.emptyLine(),
    ], SUPPLIES);
    expect(resumen.lines).toBe(1);
  });

  it('un borrador vacío no tiene total ni se declara completo', () => {
    const resumen = R.draftSummary([R.emptyLine()], SUPPLIES);
    expect(resumen).toMatchObject({ lines: 0, total: 0, total_is_complete: false });
  });
});

describe('EV2Receiving.validateDraft', () => {
  it('un borrador correcto no tiene problemas', () => {
    expect(R.validateDraft([
      line({ supply_id: WHISKY.id, amount: '6', package_cost: '900' }),
      line({ supply_id: RON.id, amount: '10' }),
      R.emptyLine(),
    ], SUPPLIES)).toEqual([]);
  });

  it('el renglón en blanco del final NO se marca en rojo', () => {
    // Marcarlo mientras la persona escribe es hostil, y enseña un error donde no
    // hay ninguno.
    expect(R.validateDraft([
      line({ supply_id: WHISKY.id, amount: '1' }), R.emptyLine(),
    ], SUPPLIES)).toEqual([]);
  });

  it('nombra el renglón, no solo el problema', () => {
    const problemas = R.validateDraft([
      line({ supply_id: WHISKY.id, amount: '6' }),
      line({ supply_id: RON.id, amount: '0' }),
    ], SUPPLIES);
    expect(problemas).toEqual([{ row: 2, field: 'amount', code: 'positive' }]);
  });

  it('detecta el insumo repetido y dice en qué renglón iba', () => {
    const problemas = R.validateDraft([
      line({ supply_id: WHISKY.id, amount: '6' }),
      line({ supply_id: RON.id, amount: '3' }),
      line({ supply_id: WHISKY.id, amount: '2' }),
    ], SUPPLIES);
    expect(problemas).toEqual([
      { row: 3, field: 'supply', code: 'duplicate', name: 'Buchanans 12', first_row: 1 },
    ]);
  });

  it('un insumo dado de baja no entra', () => {
    const apagado = { ...RON, id: 'off', active: false };
    const problemas = R.validateDraft([line({ supply_id: 'off', amount: '2' })],
      [...SUPPLIES, apagado]);
    expect(problemas[0]).toMatchObject({ field: 'supply', code: 'inactive' });
  });

  it('un borrador sin nada capturado se rechaza', () => {
    expect(R.validateDraft([R.emptyLine()], SUPPLIES))
      .toEqual([{ row: 0, field: 'lines', code: 'empty' }]);
  });

  it('un costo negativo se rechaza', () => {
    const problemas = R.validateDraft(
      [line({ supply_id: WHISKY.id, amount: '1', package_cost: '-3' })], SUPPLIES);
    expect(problemas).toEqual([{ row: 1, field: 'package_cost', code: 'negative' }]);
  });

  it('con requireCost, un renglón sin costo se marca', () => {
    const problemas = R.validateDraft([line({ supply_id: WHISKY.id, amount: '1' })],
      SUPPLIES, { requireCost: true });
    expect(problemas).toEqual([{ row: 1, field: 'package_cost', code: 'required' }]);
  });

  it('devuelve TODOS los problemas, no el primero', () => {
    const problemas = R.validateDraft([
      line({ supply_id: null, amount: '1' }),
      line({ supply_id: WHISKY.id, amount: '0' }),
      line({ supply_id: 'fantasma', amount: '1' }),
    ], SUPPLIES);
    expect(problemas.map((p) => p.row)).toEqual([1, 2, 3]);
  });
});

describe('EV2Receiving.receiptRequest', () => {
  it('manda `packages` o `quantity`, nunca las dos', () => {
    const body = R.receiptRequest({
      locationId: 'loc1',
      supplierId: 'prov1',
      lines: [
        line({ supply_id: WHISKY.id, mode: 'packages', amount: '6', package_cost: '900' }),
        line({ supply_id: RON.id, mode: 'base', amount: '4500' }),
      ],
    });

    expect(body.lines[0]).toEqual({ supply_id: 'w1', packages: 6, package_cost: 900 });
    expect(body.lines[1]).toEqual({ supply_id: 'r1', quantity: 4500 });
    expect(body.supplier_id).toBe('prov1');
  });

  it('sin proveedor no manda el campo: es opcional a propósito', () => {
    const body = R.receiptRequest({
      locationId: 'loc1', supplierId: null,
      lines: [line({ supply_id: WHISKY.id, amount: '1' })],
    });
    expect('supplier_id' in body).toBe(false);
  });

  it('los renglones vacíos no viajan', () => {
    const body = R.receiptRequest({
      locationId: 'loc1',
      lines: [line({ supply_id: WHISKY.id, amount: '1' }), R.emptyLine(), R.emptyLine()],
    });
    expect(body.lines).toHaveLength(1);
  });
});

describe('EV2Receiving.draftFromSupplier', () => {
  it('precarga el costo de la última vez y deja la cantidad VACÍA', () => {
    const lines = R.draftFromSupplier([
      { supply_id: WHISKY.id, last_cost: 900 },
      { supply_id: RON.id, last_cost: null },
    ]);

    expect(lines[0]).toMatchObject({ supply_id: 'w1', package_cost: '900', amount: '' });
    expect(lines[1]).toMatchObject({ supply_id: 'r1', package_cost: '', amount: '' });
    // Sugerir la cantidad de la última entrega invita a aceptarla sin mirar, y la
    // cantidad es de ESTA entrega.
    expect(lines.every((l) => l.amount === '')).toBe(true);
    // Y deja un renglón en blanco para lo que llegó de más.
    expect(R.isEmptyLine(lines[lines.length - 1])).toBe(true);
  });

  it('sin insumos, solo el renglón en blanco', () => {
    expect(R.draftFromSupplier([])).toHaveLength(1);
    expect(R.draftFromSupplier(null)).toHaveLength(1);
  });
});

// ===========================================================================
// Los pedidos
// ===========================================================================

describe('EV2Receiving.requestFromSuggested', () => {
  const sugeridos = [
    { supply_id: WHISKY.id, missing: 2500, suggested_packages: 4, warehouse_stock: 10_000 },
    { supply_id: RON.id, missing: 3000, suggested_packages: 3, warehouse_stock: 0 },
  ];

  it('solo entra lo que el almacén de verdad tiene', () => {
    const lines = R.requestFromSuggested(sugeridos);
    // Lo que no hay allá no es un pedido: es una compra, y mezclarlas hace que el
    // almacenista persiga fantasmas toda la noche.
    expect(lines.map((l) => l.supply_id)).toEqual([WHISKY.id]);
    expect(lines[0].amount).toBe('4');
  });

  it('con includeUnavailable entra todo, para que quede registrado', () => {
    expect(R.requestFromSuggested(sugeridos, { includeUnavailable: true })).toHaveLength(2);
  });

  it('una lista vacía no revienta', () => {
    expect(R.requestFromSuggested(null)).toEqual([]);
  });
});

describe('EV2Receiving.fulfillDraft', () => {
  const pedido = {
    lines: [
      { supply_id: WHISKY.id, name: 'Buchanans 12', unit: 'ml', package_size: 750, quantity: 9000, fulfilled: 3000 },
      { supply_id: RON.id, name: 'Bacardi', unit: 'ml', package_size: 1000, quantity: 2000, fulfilled: 2000 },
    ],
  };

  it('arranca con lo que FALTA, no con lo pedido', () => {
    const draft = R.fulfillDraft(pedido);
    // Un pedido a medias se termina de surtir; volver a mandar los 9,000 completos
    // sería mandar 3,000 de más.
    expect(draft).toHaveLength(1);
    expect(draft[0]).toMatchObject({ supply_id: WHISKY.id, pending: 6000, already: 3000 });
  });

  it('sugiere en presentaciones, redondeado hacia arriba', () => {
    // 6,000 ml / 750 = 8 botellas justas.
    expect(R.fulfillDraft(pedido)[0].amount).toBe('8');
    // Y con un resto, la siguiente entera: nadie manda media botella.
    const impar = { lines: [{ ...pedido.lines[0], quantity: 7100, fulfilled: 0 }] };
    expect(R.fulfillDraft(impar)[0].amount).toBe('10');
  });

  it('los renglones ya completos no salen', () => {
    expect(R.fulfillDraft(pedido).map((l) => l.supply_id)).not.toContain(RON.id);
  });

  it('un pedido sin renglones no revienta', () => {
    expect(R.fulfillDraft({})).toEqual([]);
  });
});

describe('EV2Receiving.fulfillPreview', () => {
  const pedido = {
    lines: [
      { supply_id: WHISKY.id, name: 'Buchanans 12', package_size: 750, quantity: 9000, fulfilled: 0 },
      { supply_id: RON.id, name: 'Bacardi', package_size: 1000, quantity: 2000, fulfilled: 0 },
    ],
  };

  it('dice que el pedido va a quedar COMPLETO antes de mandarlo', () => {
    const vista = R.fulfillPreview(pedido, [
      { supply_id: WHISKY.id, mode: 'packages', amount: '12' },
      { supply_id: RON.id, mode: 'packages', amount: '2' },
    ], { [WHISKY.id]: 20_000, [RON.id]: 5000 });

    expect(vista.status_after).toBe('fulfilled');
    expect(vista.short).toHaveLength(0);
  });

  it('dice que va a quedar A MEDIAS, y por cuánto', () => {
    const vista = R.fulfillPreview(pedido, [
      { supply_id: WHISKY.id, mode: 'packages', amount: '4' },
      { supply_id: RON.id, mode: 'packages', amount: '2' },
    ], { [WHISKY.id]: 20_000, [RON.id]: 5000 });

    expect(vista.status_after).toBe('partial');
    expect(vista.short).toHaveLength(1);
    expect(vista.short[0]).toMatchObject({ supply_id: WHISKY.id, pending_after: 6000 });
  });

  it('recorta a lo que de verdad hay en el lugar de origen', () => {
    const vista = R.fulfillPreview(pedido, [
      { supply_id: WHISKY.id, mode: 'packages', amount: '12' },
      { supply_id: RON.id, mode: 'packages', amount: '2' },
    ], { [WHISKY.id]: 3000, [RON.id]: 5000 });

    const whisky = vista.lines.find((l) => l.supply_id === WHISKY.id);
    expect(whisky.sending).toBe(3000);
    // Y avisa de lo capturado de más, que es lo que evita prometer producto que no
    // está en el estante.
    expect(whisky.short_of_draft).toBe(6000);
    expect(vista.status_after).toBe('partial');
  });

  it('un renglón que no se captura cuenta como cero, no como todo', () => {
    const vista = R.fulfillPreview(pedido, [
      { supply_id: WHISKY.id, mode: 'packages', amount: '12' },
    ], {});
    const ron = vista.lines.find((l) => l.supply_id === RON.id);
    expect(ron.sending).toBe(0);
    expect(ron.pending_after).toBe(2000);
  });

  it('cuenta lo ya surtido antes: dos parciales completan', () => {
    const aMedias = {
      lines: [{ supply_id: WHISKY.id, name: 'W', package_size: 750, quantity: 9000, fulfilled: 6000 }],
    };
    const vista = R.fulfillPreview(aMedias,
      [{ supply_id: WHISKY.id, mode: 'packages', amount: '4' }], { [WHISKY.id]: 9000 });
    expect(vista.status_after).toBe('fulfilled');
  });
});

describe('EV2Receiving.requestBody y fulfillBody', () => {
  it('el pedido manda presentaciones y la nota solo si la hay', () => {
    const body = R.requestBody({
      locationId: 'bar1',
      lines: [line({ supply_id: WHISKY.id, mode: 'packages', amount: '4' })],
      note: '  ',
    });
    expect(body).toEqual({ location_id: 'bar1', lines: [{ supply_id: 'w1', packages: 4 }] });

    const conNota = R.requestBody({
      locationId: 'bar1',
      lines: [line({ supply_id: WHISKY.id, amount: '4' })],
      note: 'Para la fiesta de arriba',
    });
    expect(conNota.note).toBe('Para la fiesta de arriba');
  });

  it('surtir sin renglones capturados NO manda `lines`: el servidor surte todo lo que falte', () => {
    const body = R.fulfillBody({
      fromLocationId: 'alm', draft: [{ supply_id: WHISKY.id, mode: 'packages', amount: '' }],
    });
    expect(body).toEqual({ from_location_id: 'alm' });
  });

  it('los renglones en cero no viajan', () => {
    const body = R.fulfillBody({
      fromLocationId: 'alm',
      draft: [
        { supply_id: WHISKY.id, mode: 'packages', amount: '4' },
        { supply_id: RON.id, mode: 'packages', amount: '0' },
      ],
    });
    expect(body.lines).toEqual([{ supply_id: 'w1', packages: 4 }]);
  });
});

describe('EV2Receiving.statusOf', () => {
  it('open y partial siguen pendientes; fulfilled y cancelled no', () => {
    expect(R.statusOf('open').pending).toBe(true);
    // `partial` pendiente NO es un detalle: es lo que mantiene el pedido a la vista
    // para que al día siguiente alguien pregunte por lo que faltó.
    expect(R.statusOf('partial').pending).toBe(true);
    expect(R.statusOf('fulfilled').pending).toBe(false);
    expect(R.statusOf('cancelled').pending).toBe(false);
  });

  it('un estado que no conocemos no revienta la pantalla', () => {
    expect(R.statusOf('algo_nuevo')).toMatchObject({ pending: false });
  });
});
