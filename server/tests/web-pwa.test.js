/**
 * La cáscara que se guarda para trabajar sin señal.
 *
 * Esta prueba existe por un defecto real y repetido: cada vez que un paso agregó un
 * archivo de JavaScript nuevo a una pantalla, nadie lo agregó a la lista del service
 * worker. El resultado no era un error visible —la app abría igual— sino que SIN SEÑAL
 * la pestaña que dependía de ese archivo se quedaba en blanco. Se acumularon cinco, de
 * cuatro pasos distintos, antes de que alguien lo notara.
 *
 * La prueba que había comprobaba tres nombres a mano, así que pasó los cuatro pasos sin
 * decir nada. Esta lee los `<script>` de cada página que la cáscara promete guardar y
 * exige que todos estén: no se puede quedar atrás sin que la suite se ponga roja.
 *
 * Dónde peor duele: el almacén. Se cuenta de pie en una bodega, que es donde peor entra
 * la señal de todo el edificio. Si esa pantalla no abre completa sin red, el conteo se
 * hace en papel y se captura al día siguiente, que es como el inventario deja de
 * cuadrar.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const sw = leer('sw.js');

/**
 * Los archivos que el service worker promete guardar.
 *
 * Los comentarios se quitan antes de buscar: la lista lleva explicaciones, y un nombre
 * de archivo citado dentro de un comentario no es un archivo que se guarde.
 */
function shell() {
  const desde = sw.indexOf('const SHELL = [');
  const hasta = sw.indexOf('];', desde);
  expect(desde).toBeGreaterThan(-1);
  const codigo = sw.slice(desde, hasta)
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  return new Set([...codigo.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

/** Los `<script src="js/...">` de una página, en orden. */
const scriptsDe = (pagina) => [...leer(pagina).matchAll(/<script src="(js\/[^"]+)"/g)]
  .map((m) => m[1]);

describe('La cáscara guardada para trabajar sin señal', () => {
  const guardados = shell();
  const paginas = [...guardados].filter((f) => f.endsWith('.html'));

  it('guarda las pantallas que se usan en el club', () => {
    // Las cinco que se abren adentro, donde la señal es mala. `pase.html` NO: lo abre
    // un invitado desde su teléfono, en la calle, y su contenido es de un solo uso.
    for (const pagina of ['index.html', 'manager.html', 'almacen.html',
      'bartender.html', 'staff.html', 'valet.html', 'employee-portal.html', 'caja.html']) {
      expect({ pagina, guardada: guardados.has(pagina) })
        .toEqual({ pagina, guardada: true });
    }
  });

  it('cada archivo de la lista existe de verdad', () => {
    // Un nombre mal escrito no rompe nada al desplegar: `cache.add` falla en silencio
    // y ese archivo simplemente no se guarda. Se descubre sin señal, tarde.
    const faltantes = [...guardados].filter((f) => !fs.existsSync(path.join(ROOT, f)));
    expect(faltantes).toEqual([]);
  });

  it('NINGUNA pantalla guardada depende de un archivo que no se guarda', () => {
    // Esta es la prueba que importa, y la que faltaba. Sin ella la lista se queda atrás
    // cada vez que una pantalla crece, y el daño solo se ve sin señal.
    const huecos = {};
    for (const pagina of paginas.sort()) {
      const faltan = scriptsDe(pagina).filter((s) => !guardados.has(s));
      if (faltan.length) huecos[pagina] = faltan;
    }
    expect(huecos).toEqual({});
  });

  it('la versión se sube cuando la cáscara cambia', () => {
    // No es un adorno: mientras no se suba, la copia vieja se queda en el teléfono
    // ocupando espacio y sirviendo de respaldo a una versión que ya no existe.
    const version = (sw.match(/const VERSION = '([^']+)'/) || [])[1];
    expect(version).toMatch(/^ev2-v\d+$/);
    expect(Number(version.replace('ev2-v', ''))).toBeGreaterThanOrEqual(8);
  });

  it('los datos de la API NUNCA se guardan', () => {
    // Un plano de mesas de hace media hora dice que hay lugar donde ya no lo hay, y un
    // pedido "listo" que ya se entregó manda al mesero a la barra por nada.
    expect(sw).toMatch(/pathname\.startsWith\('\/api\/'\)/);
    expect(sw).toMatch(/pathname\.startsWith\('\/ws'\)/);
  });

  it('busca por red primero, para que un despliegue se vea sin borrar nada', () => {
    const cuerpo = sw.slice(sw.indexOf("addEventListener('fetch'"));
    // El `fetch` tiene que ir ANTES del `caches.match`: al revés, una pantalla nueva no
    // se ve hasta que alguien borre los datos del sitio a mano.
    expect(cuerpo.indexOf('await fetch(request)'))
      .toBeLessThan(cuerpo.indexOf('caches.match(request)'));
  });

  it('ninguna pantalla depende de un servidor ajeno para verse (D71)', () => {
    // Tailwind, los iconos y las letras venian de tres CDN. El service worker solo
    // guarda lo del mismo origen, asi que sin senal la app abria con los botones
    // grises del navegador. Todo lo que una pagina pide tiene que ser nuestro.
    const ajenos = {};
    for (const pagina of fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'))) {
      const html = leer(pagina);
      const urls = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="(https?:\/\/[^"]+)"/g)]
        .map((m) => m[1]).concat([...html.matchAll(/@import url\('?(https?:[^')]+)/g)].map((m) => m[1]));
      if (urls.length) ajenos[pagina] = urls;
    }
    expect(ajenos).toEqual({});
  });

  it('la hoja de estilo, sus letras y sus iconos se guardan con la cascara', () => {
    for (const pagina of paginas) {
      const hojas = [...leer(pagina).matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
      expect({ pagina, hojas }).toEqual({ pagina, hojas: ['css/ev2.css'] });
    }
    const css = leer('css/ev2.css');
    const letras = [...css.matchAll(/url\(\.\.\/(fonts\/[^)]+\.woff2)\)/g)].map((m) => m[1]);
    expect(letras.length).toBeGreaterThan(0);
    expect(letras.filter((f) => !guardados.has(f))).toEqual([]);
    // Los iconos van dentro de la hoja: si uno se pidiera aparte, sin senal faltaria.
    expect(css).toMatch(/\.fa-taxi\{--fa-icon:url\("data:image\/svg\+xml/);
  });
});
