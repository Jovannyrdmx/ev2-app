/**
 * Qué se dibuja para cada producto de la carta.
 *
 * Los nombres los teclea el cajero, no un catálogo ordenado: `CUB. TECATE ROJA 1/4`,
 * `EN LAS ROCAS BLACK LABEL`, `SHOT DON JULIO 70`. Lo que se prueba aquí es que la
 * regla los lea como los lee una persona — y sobre todo que NUNCA se quede sin dibujo,
 * porque un hueco en la carta se ve como un error de la app.
 *
 * Las pruebas usan nombres reales del archivo del club, no inventados.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const Art = require(path.join(__dirname, '..', '..', 'web', 'js', 'drink-art.js'));
const menu = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'seeds', 'data', 'ev2-menu.json'), 'utf8'));

describe('la carta entera queda ilustrada', () => {
  it('los 129 productos reales reciben un dibujo que existe', () => {
    const sinDibujo = menu.items.filter((i) => !Art.KINDS[Art.kindFor(i)]);
    expect(sinDibujo).toEqual([]);
  });

  it('cada uno devuelve un SVG, no una cadena vacía', () => {
    for (const item of menu.items) {
      const svg = Art.svgFor(item);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toContain('viewBox="0 0 48 48"');
    }
  });

  it('un producto sin nombre ni categoría tampoco se queda sin dibujo', () => {
    // Pasa si alguien da de alta un trago a medias desde el panel.
    expect(Art.KINDS[Art.kindFor({})]).toBeDefined();
    expect(Art.KINDS[Art.kindFor(null)]).toBeDefined();
  });
});

describe('el nombre manda sobre la categoría', () => {
  const cerveza = (name) => ({ name, category: 'Cervezas' });

  it('una cubeta es una cubeta, aunque viva en el grupo de cervezas', () => {
    expect(Art.kindFor(cerveza('CUB. TECATE ROJA 1/4'))).toBe('bucket');
    expect(Art.kindFor(cerveza('TECATE ROJA 1/4'))).toBe('beer_bottle');
  });

  it('una michelada no es una cerveza de botella', () => {
    expect(Art.kindFor(cerveza('MICHELADA TAMARINDO'))).toBe('michelada');
    expect(Art.kindFor(cerveza('CLAMATO PREPARADO'))).toBe('michelada');
  });

  it('una ronda son varios caballitos; un shot es uno', () => {
    expect(Art.kindFor({ name: 'RONDA PERLAS NEGRAS', category: 'Shots' })).toBe('shot_flight');
    expect(Art.kindFor({ name: 'SHOT DON JULIO 70', category: 'Shots' })).toBe('shot');
  });

  it('"en las rocas" es vaso bajo, no copa', () => {
    expect(Art.kindFor({ name: 'EN LAS ROCAS BLACK LABEL', category: 'Drinks' })).toBe('rocks');
  });

  it('lo mezclado con refresco va en vaso alto', () => {
    expect(Art.kindFor({ name: 'BACARDI - COCA COLA', category: 'Drinks' })).toBe('highball');
    expect(Art.kindFor({ name: 'TEQUILA MINERAL', category: 'Drinks' })).toBe('highball');
  });

  it('lo tropical va en copa huracán', () => {
    expect(Art.kindFor({ name: 'PIÑA COLADA', category: 'Drinks' })).toBe('tropical');
    expect(Art.kindFor({ name: 'BANANA COLADA', category: 'Drinks' })).toBe('tropical');
  });

  it('un coctel sin más señas va en copa', () => {
    expect(Art.kindFor({ name: 'AZULITO', category: 'Drinks' })).toBe('coupe');
  });
});

describe('las botellas se distinguen por lo que llevan dentro', () => {
  const bot = (name) => ({ name, category: 'Botellas' });

  it('el tequila y el mezcal llevan su propia botella', () => {
    expect(Art.kindFor(bot('DON JULIO 1942'))).toBe('bottle_agave');
    expect(Art.kindFor(bot('HERRADURA ULTRA'))).toBe('bottle_agave');
  });

  it('un blanco se pinta transparente y un añejo ámbar', () => {
    // Con cuatro 30-30 seguidos en la lista, el color es lo único que las separa.
    expect(Art.kindFor(bot('30-30 BLANCO'))).toBe('bottle_agave_clear');
    expect(Art.kindFor(bot('30-30 CRISTALINO'))).toBe('bottle_agave_clear');
    expect(Art.kindFor(bot('30-30 AÑEJO'))).toBe('bottle_agave');
    expect(Art.kindFor(bot('30-30 REPOSADO'))).toBe('bottle_agave');
  });

  it('el whisky es ámbar y el vodka transparente', () => {
    expect(Art.kindFor(bot('BUCHANANS 18'))).toBe('bottle_amber');
    expect(Art.kindFor(bot('BLACK LABEL'))).toBe('bottle_amber');
    expect(Art.kindFor(bot('ABSOLUT'))).toBe('bottle_clear');
    expect(Art.kindFor(bot('GREY GOOSE'))).toBe('bottle_clear');
  });

  it('la champaña tiene su propia botella', () => {
    expect(Art.kindFor(bot('DOM PERIGNON'))).toBe('bottle_sparkling');
    expect(Art.kindFor(bot('MOET'))).toBe('bottle_sparkling');
  });

  it('una botella que no reconocemos cae en la genérica, no revienta', () => {
    expect(Art.kindFor(bot('LICOR QUE NO EXISTE'))).toBe('bottle_clear');
  });
});

describe('lo que no se bebe', () => {
  it('pulseras y paquetes no son una copa', () => {
    expect(Art.kindFor({ name: 'PULSERA EXTRA VIP', category: 'VIP' })).toBe('package');
    expect(Art.kindFor({ name: 'PAQUETE CUMPLEAÑERO', category: 'VIP' })).toBe('package');
  });
});

describe('los acentos no estorban', () => {
  it('CAIPIRIÑA y CAIPIRINA se leen igual', () => {
    expect(Art.kindFor({ name: 'PIÑA COLADA', category: 'Drinks' }))
      .toBe(Art.kindFor({ name: 'PINA COLADA', category: 'Drinks' }));
  });

  it('minúsculas también', () => {
    expect(Art.kindFor({ name: 'shot de tequila', category: 'Shots' })).toBe('shot');
  });
});

describe('la foto siempre gana', () => {
  const trago = { name: 'AZULITO', category: 'Drinks' };

  it('sin foto se dibuja', () => {
    expect(Art.artFor(trago)).toMatchObject({ type: 'art', kind: 'coupe' });
  });

  it('con foto se usa la foto', () => {
    const art = Art.artFor({ ...trago, image_url: 'https://cdn.ev2.mx/azulito.jpg' });
    expect(art).toEqual({ type: 'photo', url: 'https://cdn.ev2.mx/azulito.jpg' });
  });

  it('una foto en blanco no cuenta como foto', () => {
    // La columna existe en 129 renglones y está vacía en todos: una cadena de espacios
    // dejaría un hueco gris en la carta en vez del dibujo.
    expect(Art.artFor({ ...trago, image_url: '   ' }).type).toBe('art');
    expect(Art.artFor({ ...trago, image_url: null }).type).toBe('art');
  });

  it('con foto no se genera SVG: sería peso de más en cada renglón', () => {
    expect(Art.svgFor({ ...trago, image_url: 'https://cdn.ev2.mx/a.jpg' })).toBe('');
  });
});
