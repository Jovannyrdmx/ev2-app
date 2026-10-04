/**
 * La pantalla de la barra contra el `web/bartender.html` REAL.
 *
 * Lo que se prueba aquí es lo que ninguna prueba de módulo ve: que el controlador y el
 * HTML se encuentren. Un `$('sale-total')` contra un `id="sale_total"` no rompe nada al
 * cargar — revienta cuando el cantinero ya tecleó la ronda y el cliente está esperando
 * con el billete en la mano.
 *
 * Y cuida lo que hace segura la venta en barra: que el folio del voucher exista, que
 * nazca escondido (solo lo pide la terminal) y que el botón de cobrar nazca apagado.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = leer('bartender.html');
const controlador = leer('js/bartender-screen.js');
const catalogo = require(path.join(ROOT, 'js', 'format.js'));

const abiertas = [];
afterEach(() => { while (abiertas.length) abiertas.pop().close(); });

function documento() {
  const dom = new JSDOM(html, { url: 'https://ev2.local/bartender.html' });
  abiertas.push(dom.window);
  return dom.window.document;
}

function idsQueBusca(fuente) {
  const ids = new Set();
  const re = /\$\('([a-z0-9-]+)'\)/g;
  let m = re.exec(fuente);
  while (m) { ids.add(m[1]); m = re.exec(fuente); }
  return [...ids];
}

describe('el controlador y el HTML se encuentran', () => {
  it('cada id que busca bartender-screen.js existe en bartender.html', () => {
    const doc = documento();
    const faltantes = idsQueBusca(controlador).filter((id) => !doc.getElementById(id));
    expect(faltantes).toEqual([]);
  });

  it('la barra ya no cobra: ni venta directa, ni terminal, ni corte (D77)', () => {
    // Todo eso es de la caja de cada barra (caja.html). Si vuelve a aparecer aquí, el
    // bartender estaría cobrando con un permiso que el servidor ya no le da.
    const doc = documento();
    for (const id of ['sale-sheet', 'btn-new-sale', 'btn-sale-charge', 'btn-cut']) {
      expect({ id, existe: Boolean(doc.getElementById(id)) }).toEqual({ id, existe: false });
    }
    expect(controlador).not.toMatch(/manual-payments|terminal-charges|shifts\/me/);
  });

  it('los chips de barra nacen escondidos: con una sola barra no hay nada que elegir', () => {
    expect(documento().getElementById('bar-chips').hasAttribute('hidden')).toBe(true);
  });

  it('carga la cola ANTES del controlador', () => {
    const doc = documento();
    const srcs = [...doc.querySelectorAll('script')].map((s) => s.getAttribute('src'));
    for (const src of ['js/api.js', 'js/bar-queue.js', 'js/bartender-screen.js']) {
      expect(srcs).toContain(src);
    }
    expect(srcs.indexOf('js/bar-queue.js')).toBeLessThan(srcs.indexOf('js/bartender-screen.js'));
  });

  it('no trae ningún número escrito a mano', () => {
    const doc = documento();
    for (const id of ['stat-open', 'stat-oldest']) {
      expect(doc.getElementById(id).textContent.trim()).toBe('—');
    }
    expect(doc.getElementById('lane-list').textContent.trim()).toBe('');
  });

  it('la hoja del almacén se esconde cuando el servidor exige cambiar la contraseña', () => {
    expect(controlador).toMatch(/PASSWORD_GATE_HIDES\s*=\s*\[[^\]]*'req-sheet'/);
  });
});

describe('nada sale sin traducir', () => {
  const claves = (fuente, attr) => {
    const out = new Set();
    const re = new RegExp(`${attr}="([^"]+)"`, 'g');
    let m = re.exec(fuente);
    while (m) { out.add(m[1]); m = re.exec(fuente); }
    return [...out];
  };

  it('cada data-i18n de bartender.html está en español y en inglés', () => {
    const usadas = [...claves(html, 'data-i18n'), ...claves(html, 'data-i18n-placeholder'),
      ...claves(html, 'data-i18n-title')];
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltantes = usadas.filter((k) => catalogo.t(k) === k);
      expect({ lang, faltantes }).toEqual({ lang, faltantes: [] });
    }
  });

  it('cada texto que pide el controlador de la barra existe en los dos idiomas', () => {
    const usadas = new Set();
    const re = /t\('((?:sale|bar|req)\.[a-zA-Z0-9_.]+)'/g;
    let m = re.exec(controlador);
    while (m) { usadas.add(m[1]); m = re.exec(controlador); }

    expect(usadas.size).toBeGreaterThanOrEqual(12);
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltantes = [...usadas].filter((k) => catalogo.t(k) === k);
      expect({ lang, faltantes }).toEqual({ lang, faltantes: [] });
    }
  });
});
