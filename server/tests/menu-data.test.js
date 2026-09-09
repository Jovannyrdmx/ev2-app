/**
 * El catálogo real del club, el que sale de la caja.
 *
 * Este archivo lo genera una exportación de SoftRestaurant11 y lo edita una persona
 * cuando cambian los precios. Es la única fuente de lo que el cliente ve y de lo que
 * se le cobra, así que un dedazo aquí sale caro de verdad: un precio con un cero de
 * más, un producto duplicado que aparece dos veces en la carta, o un id de la caja
 * repetido que haría que un trago pise a otro al cargarlo.
 *
 * Estas pruebas no necesitan base de datos: cuidan el ARCHIVO.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Se arma la ruta aquí en vez de importarla del cargador: ese arrastra la conexión a
// la base, y esta prueba cuida un archivo de texto. Debe correr sin base de datos.
const MENU_PATH = path.join(__dirname, '..', 'seeds', 'data', 'ev2-menu.json');
const menu = JSON.parse(fs.readFileSync(MENU_PATH, 'utf8'));

describe('el archivo del catálogo', () => {
  it('trae los productos de barra y dice de dónde salieron', () => {
    expect(menu.items.length).toBeGreaterThan(100);
    expect(menu.source).toMatch(/SoftRestaurant/i);
    expect(menu.currency).toBe('MXN');
  });

  it('los precios YA incluyen impuesto, como se cobran en la caja', () => {
    // Guardar el precio sin impuesto enseñaría al cliente un número que no coincide
    // con lo que se le pide pagar.
    expect(menu.tax_included).toBe(true);
    expect(menu.tax_rate_pct).toBe(8);
  });

  it('cada producto tiene id de la caja, nombre, categoría y precio', () => {
    for (const item of menu.items) {
      expect(typeof item.pos_id).toBe('string');
      expect(item.pos_id.trim()).not.toBe('');
      expect(item.name.trim()).not.toBe('');
      expect(typeof item.category).toBe('string');
      expect(typeof item.price).toBe('number');
    }
  });

  it('ningún precio es cero ni negativo: eso no se puede vender', () => {
    const malos = menu.items.filter((i) => !(i.price > 0));
    expect(malos).toEqual([]);
  });

  it('ningún precio trae más de dos decimales', () => {
    const malos = menu.items.filter((i) => Math.round(i.price * 100) !== i.price * 100);
    expect(malos).toEqual([]);
  });

  it('ningún id de la caja se repite: uno pisaría al otro al cargarlo', () => {
    const vistos = new Set();
    const repetidos = menu.items.filter((i) => (vistos.has(i.pos_id) ? true : (vistos.add(i.pos_id), false)));
    expect(repetidos).toEqual([]);
  });

  it('ningún nombre se repite: el cliente vería el mismo trago dos veces', () => {
    const vistos = new Set();
    const repetidos = menu.items
      .filter((i) => (vistos.has(i.name) ? true : (vistos.add(i.name), false)))
      .map((i) => i.name);
    expect(repetidos).toEqual([]);
  });

  it('las categorías son las cinco que la carta enseña, y ninguna más', () => {
    const cats = [...new Set(menu.items.map((i) => i.category))].sort();
    expect(cats).toEqual(['Botellas', 'Cervezas', 'Drinks', 'Shots', 'Sin alcohol']);
  });

  it('no se colaron las copias de las otras barras', () => {
    // Los grupos B2 y B3 son el MISMO catálogo repetido para las otras dos barras.
    // Si se colaran, el cliente vería cada trago tres veces.
    const copias = menu.items.filter((i) => / B[23]\b/.test(i.name) || / B[23]$/.test(i.pos_group || ''));
    expect(copias).toEqual([]);
  });

  it('no se coló nada del grupo SUSPENDIDOS', () => {
    const muertos = menu.items.filter((i) => (i.pos_group || '').toUpperCase() === 'SUSPENDIDOS');
    expect(muertos).toEqual([]);
  });
});

describe('los productos de reservación', () => {
  it('las botellas de reservación son exactamente las botellas de la carta', () => {
    // Si se separan, el cliente puede acabar pagando una botella a un precio en la
    // mesa y a otro en la barra, la misma noche.
    const enCarta = menu.items.filter((i) => i.category === 'Botellas');
    expect(menu.reservation_bottles).toHaveLength(enCarta.length);
    for (const b of menu.reservation_bottles) {
      const gemela = enCarta.find((i) => i.pos_id === b.pos_id);
      expect(gemela).toBeDefined();
      expect(b.price).toBe(gemela.price);
      expect(b.name).toBe(gemela.name);
    }
  });

  it('ningún código de producto de reservación se repite', () => {
    const codes = [...menu.reservation_bottles, ...menu.reservation_addons].map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('los extras traen un precio real y su id de la caja', () => {
    expect(menu.reservation_addons.length).toBeGreaterThan(0);
    for (const a of menu.reservation_addons) {
      expect(a.price).toBeGreaterThan(0);
      expect(typeof a.pos_id).toBe('string');
    }
  });

  it('la pulsera VIP sigue costando lo que cobra la caja', () => {
    const pulsera = menu.reservation_addons.find((a) => a.code === 'vip_wristband');
    expect(pulsera).toBeDefined();
    expect(pulsera.price).toBe(100);
  });

  it('no quedó ningún código inventado de los que había antes', () => {
    // Estos seis existían en la lista de precios y NO eran del club.
    const inventados = ['house_wine', 'premium_wine', 'champagne', 'sparklers', 'photo_booth', 'coat_check'];
    const codes = [...menu.reservation_bottles, ...menu.reservation_addons].map((p) => p.code);
    for (const c of inventados) expect(codes).not.toContain(c);
  });
});

describe('el cover de referencia', () => {
  it('trae los precios de entrada que cobra la caja, de mayor a menor', () => {
    expect(menu.cover_reference.length).toBeGreaterThan(0);
    const precios = menu.cover_reference.map((c) => c.price);
    expect(precios).toEqual([...precios].sort((a, b) => b - a));
    for (const c of menu.cover_reference) expect(c.price).toBeGreaterThan(0);
  });
});
