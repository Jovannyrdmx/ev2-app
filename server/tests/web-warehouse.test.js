/**
 * Las decisiones del almacén, sin navegador.
 *
 * Lo que se prueba aquí es aritmética de inventario: cuántas botellas son 2,630 ml,
 * qué saldo va a quedar, y qué falta antes de mandar un movimiento. Un error aquí no
 * se ve hasta el corte de la noche, cuando ya nadie puede reconstruir qué pasó.
 */
'use strict';

const wh = require('../../web/js/warehouse');

const whisky = {
  id: 'w1', name: "WHISKY BUCHANNANS 12", unit: 'ml',
  package_size: 750, package_label: 'botella 750 ml', avg_cost: 1.2,
};
const cerveza = { id: 'c1', name: 'TECATE LIGHT', unit: 'pza', package_size: 1, package_label: 'pieza' };

const place = (id, name, kind, stock, min = 0) => ({
  location_id: id, id, code: id, name, kind, stock, min_stock: min, low: stock <= min && min > 0,
});

describe('Leer un saldo como se lee un estante', () => {
  it('2,630 ml son 3.51 botellas de 750', () => {
    expect(wh.packagesOf(2630, 750)).toBe(3.51);
  });

  it('lo dice en las dos formas: la unidad que descuenta y la que se cuenta', () => {
    expect(wh.describeStock(whisky, 2630)).toBe('2,630 ml · 3.51 botella 750 ml');
  });

  it('lo que se cuenta por pieza no se dice en presentaciones: sería ruido', () => {
    expect(wh.describeStock(cerveza, 48)).toBe('48 pza');
  });

  it('capturar en cajas se convierte a la unidad base', () => {
    expect(wh.toBaseUnit({ amount: 12, mode: 'packages', supply: whisky })).toBe(9000);
    expect(wh.toBaseUnit({ amount: 9000, mode: 'base', supply: whisky })).toBe(9000);
  });
});

describe('Qué va a pasar si mando esto', () => {
  const almacen = place('alm', 'Almacén', 'warehouse', 9000);
  const barra = place('baja', 'Barra planta baja', 'bar', 1500);

  it('un traspaso enseña los DOS saldos: vaciar el almacén sin verlo es el error típico', () => {
    const p = wh.preview({ kind: 'transfer', supply: whisky, from: almacen, to: barra, quantity: 2250 });
    expect(p).toEqual([
      { location: almacen, before: 9000, after: 6750 },
      { location: barra, before: 1500, after: 3750 },
    ]);
  });

  it('un conteo enseña la diferencia, que es el dato que importa', () => {
    const p = wh.preview({ kind: 'count', supply: whisky, from: barra, quantity: 1200 });
    expect(p[0]).toMatchObject({ before: 1500, after: 1200, difference: -300 });
  });

  it('una merma resta aunque se escriba en positivo', () => {
    const p = wh.preview({ kind: 'waste', supply: whisky, from: barra, quantity: 750 });
    expect(p[0].after).toBe(750);
  });
});

describe('Lo que falta antes de mandarlo', () => {
  const almacen = place('alm', 'Almacén', 'warehouse', 9000);
  const barra = place('baja', 'Barra', 'bar', 1500);

  it('una merma sin motivo no sale', () => {
    const problems = wh.validate({ kind: 'waste', supply: whisky, from: barra, quantity: 750 });
    expect(problems).toEqual([{ field: 'reason', code: 'required' }]);
  });

  it('un traspaso a sí mismo no es un traspaso', () => {
    const problems = wh.validate({
      kind: 'transfer', supply: whisky, from: barra, to: barra, quantity: 100,
    });
    expect(problems).toContainEqual({ field: 'to', code: 'same_place' });
  });

  it('no se saca más de lo que hay, y dice cuánto hay', () => {
    const problems = wh.validate({
      kind: 'transfer', supply: whisky, from: barra, to: almacen, quantity: 3000,
    });
    expect(problems).toContainEqual({
      field: 'quantity', code: 'not_enough', available: 1500, needed: 3000,
    });
  });

  it('devuelve TODO lo que falta, no el primer problema', () => {
    const problems = wh.validate({ kind: 'transfer', supply: null, from: null, quantity: 0 });
    expect(problems.map((p) => p.field).sort()).toEqual(['from', 'quantity', 'supply', 'to']);
  });

  it('un conteo de cero es válido: el estante puede estar vacío', () => {
    expect(wh.validate({ kind: 'count', supply: whisky, from: barra, quantity: 0 })).toEqual([]);
  });

  it('una corrección sí puede ser negativa: para eso es', () => {
    expect(wh.validate({
      kind: 'adjustment', supply: whisky, from: barra, quantity: -100, reason: 'Error de captura',
    })).toEqual([]);
  });
});

describe('El cuerpo que espera la API', () => {
  const almacen = place('alm', 'Almacén', 'warehouse', 9000);
  const barra = place('baja', 'Barra', 'bar', 1500);

  it('una recepción en cajas manda cajas y el costo de la caja', () => {
    const req = wh.requestFor({
      kind: 'receive', supply: whisky, from: almacen, quantity: 12, unitCost: 900, mode: 'packages',
    });
    expect(req.path).toBe('/supplies/w1/receive');
    expect(req.body).toEqual({ location_id: 'alm', packages: 12, package_cost: 900 });
  });

  it('un conteo en cajas manda `counted_packages`, no `counted`', () => {
    const req = wh.requestFor({
      kind: 'count', supply: whisky, from: barra, quantity: 2, mode: 'packages',
    });
    expect(req.body).toEqual({ location_id: 'baja', counted_packages: 2 });
  });

  it('una cortesía viaja como ajuste con su motivo', () => {
    const req = wh.requestFor({
      kind: 'courtesy', supply: whisky, from: barra, quantity: 750, reason: 'Mesa del dueño',
      mode: 'base',
    });
    expect(req.path).toBe('/supplies/w1/adjust');
    expect(req.body).toEqual({
      location_id: 'baja', kind: 'courtesy', quantity: 750, reason: 'Mesa del dueño',
    });
  });
});

describe('Lo que hay que surtir antes de abrir', () => {
  const supply = (name, locations, id = name) => ({
    id, name, unit: 'ml', package_size: 750, avg_cost: 1, locations,
  });

  it('separa lo que se surte de lo que hay que comprar', () => {
    const list = wh.restockList([
      supply('Hay en almacén', [
        place('alm', 'Almacén', 'warehouse', 7500),
        place('baja', 'Barra', 'bar', 300, 1500),
      ]),
      supply('No hay en ningún lado', [
        place('alm', 'Almacén', 'warehouse', 0),
        place('baja', 'Barra', 'bar', 100, 1500),
      ]),
      supply('Alcanza a medias', [
        place('alm', 'Almacén', 'warehouse', 400),
        place('baja', 'Barra', 'bar', 100, 1500),
      ]),
    ]);
    expect(list.map((l) => [l.name, l.action])).toEqual([
      ['Hay en almacén', 'transfer'],
      ['Alcanza a medias', 'partial'],
      ['No hay en ningún lado', 'purchase'],
    ]);
    expect(list[0].missing).toBe(1200);
    expect(list[0].missing_packages).toBe(1.6);
  });

  it('no lista lo que está por encima de su mínimo', () => {
    const list = wh.restockList([
      supply('Sobra', [place('baja', 'Barra', 'bar', 3000, 1500)]),
    ]);
    expect(list).toEqual([]);
  });

  it('un mínimo en cero no es un faltante: es que nadie lo ha fijado', () => {
    const list = wh.restockList([supply('Sin mínimo', [place('baja', 'Barra', 'bar', 0, 0)])]);
    expect(list).toEqual([]);
  });
});

describe('Valor del inventario', () => {
  it('suma al costo promedio y lo desglosa por lugar', () => {
    const value = wh.inventoryValue([{
      ...whisky,
      locations: [
        place('alm', 'Almacén', 'warehouse', 9000),
        place('baja', 'Barra', 'bar', 1500),
      ],
    }]);
    expect(value.total).toBe(12600); // 10 500 ml × 1.20
    expect(value.byLocation).toEqual([['Almacén', 10800], ['Barra', 1800]]);
  });
});
