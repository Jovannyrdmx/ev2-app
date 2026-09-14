/**
 * La página del pase contra el `web/pase.html` REAL, y la puerta contra `staff.html`.
 *
 * `pase.html` la abre un invitado sin cuenta, desde un mensaje de WhatsApp, en la
 * banqueta. Si un `$('pass-code')` no encuentra su `id`, no pasa nada al cargar:
 * revienta cuando esa persona ya está en la fila. Y como es una página PÚBLICA,
 * aquí también se comprueba lo que no debe llevar: service worker, indexación, ni
 * un solo dato escrito a mano.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = leer('pase.html');
const controlador = leer('js/pass-screen.js');
const staffHtml = leer('staff.html');
const staffJs = leer('js/staff-screen.js');
const indexHtml = leer('index.html');
const bookingJs = leer('js/booking-screen.js');
const catalogo = require(path.join(ROOT, 'js', 'format.js'));
const Scan = require(path.join(ROOT, 'js', 'door-scan.js'));

const abiertas = [];
afterEach(() => { while (abiertas.length) abiertas.pop().close(); });

function documento(fuente = html) {
  const dom = new JSDOM(fuente, { url: 'https://ev2.systems/pase.html?p=EV2P.EV2-4K7M-2P4X.AAAAAAAAAA' });
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

describe('la página del pase y su controlador se encuentran', () => {
  it('cada id que busca pass-screen.js existe en pase.html', () => {
    const doc = documento();
    const faltantes = idsQueBusca(controlador).filter((id) => !doc.getElementById(id));
    expect(faltantes).toEqual([]);
  });

  it('arranca cargando: ni la tarjeta ni el error se ven todavía', () => {
    const doc = documento();
    expect(doc.getElementById('pass-loading').hasAttribute('hidden')).toBe(false);
    expect(doc.getElementById('pass-card').hasAttribute('hidden')).toBe(true);
    expect(doc.getElementById('pass-error').hasAttribute('hidden')).toBe(true);
  });

  it('el aviso de estado nace escondido: un pase que sirve no necesita cartel', () => {
    expect(documento().getElementById('pass-state').hasAttribute('hidden')).toBe(true);
  });

  it('no trae ningún dato escrito a mano', () => {
    const doc = documento();
    for (const id of ['pass-club', 'pass-for', 'pass-code', 'pass-table', 'pass-when']) {
      expect(doc.getElementById(id).textContent.trim()).toMatch(/^(—|-)$/);
    }
    expect(doc.getElementById('pass-qr').textContent.trim()).toBe('');
  });

  it('NO carga el service worker: es una página que se abre una vez y se olvida', () => {
    const doc = documento();
    const srcs = [...doc.querySelectorAll('script')].map((s) => s.getAttribute('src'));
    expect(srcs).not.toContain('js/pwa.js');
    expect(html).not.toContain('serviceWorker');
  });

  it('no se indexa: el pase es de quien lo trae, no de un buscador', () => {
    const robots = documento().querySelector('meta[name="robots"]');
    expect(robots.content).toMatch(/noindex/);
  });

  it('carga el catálogo de textos y el módulo de la puerta ANTES del controlador', () => {
    const doc = documento();
    const srcs = [...doc.querySelectorAll('script')].map((s) => s.getAttribute('src'));
    expect(srcs).toContain('js/format.js');
    expect(srcs).toContain('js/door-scan.js');
    expect(srcs.indexOf('js/format.js')).toBeLessThan(srcs.indexOf('js/pass-screen.js'));
    expect(srcs.indexOf('js/door-scan.js')).toBeLessThan(srcs.indexOf('js/pass-screen.js'));
  });

  it('pide el pase a la ruta PÚBLICA, sin sesión', () => {
    // Si alguien la cambiara por `createClient`, la página pediría un token que el
    // invitado no tiene y no cargaría nunca.
    expect(controlador).toContain('/guest-passes/');
    // Se busca la LLAMADA, no la palabra: el comentario de arriba del archivo
    // explica justamente por qué no se usa, y contarlo como uso haría que la
    // prueba castigara la explicación.
    expect(controlador).not.toMatch(/EV2\.createClient\s*\(/);
    expect(controlador).toContain('fetch(');
  });

  it('el QR lo dibuja el servidor: la página solo lo mete en su hueco', () => {
    // Un generador de QR en el navegador no falla ruidosamente: dibuja algo que se
    // ve bien y no lee, y eso se descubre con la fila enfrente.
    expect(controlador).toContain('pass.qr_svg');
    expect(controlador).not.toMatch(/reed|solomon|qrcode\s*\(/i);
  });
});

describe('la puerta: la identificación va antes del código', () => {
  it('el campo del código nace DESHABILITADO', () => {
    const doc = documento(staffHtml);
    expect(doc.getElementById('scan-code').hasAttribute('disabled')).toBe(true);
    expect(doc.getElementById('btn-scan-code').hasAttribute('disabled')).toBe(true);
  });

  it('y dice por qué, en vez de quedarse muerto sin explicación', () => {
    const doc = documento(staffHtml);
    expect(doc.getElementById('scan-blocked').hasAttribute('hidden')).toBe(false);
  });

  it('el panel de la identificación está ANTES del del código en el documento', () => {
    const doc = documento(staffHtml);
    const idc = doc.getElementById('idc-panel');
    const codigo = doc.getElementById('scan-form');
    // `DOCUMENT_POSITION_FOLLOWING` = el código viene después. El orden en pantalla
    // es el orden del procedimiento, y al revés se lee como si fuera opcional.
    expect(idc.compareDocumentPosition(codigo)
      & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('el motivo del rechazo nace escondido: en el caso normal estorba', () => {
    expect(documento(staffHtml).getElementById('idc-reject-why').hasAttribute('hidden')).toBe(true);
  });

  it('NO hay ningún campo para el número de la identificación ni la fecha de nacimiento', () => {
    const doc = documento(staffHtml);
    const panel = doc.getElementById('idc-panel');
    expect(panel.querySelectorAll('input').length).toBe(0);
    for (const prohibido of ['idc-number', 'idc-birth', 'idc-curp', 'idc-photo']) {
      expect(doc.getElementById(prohibido)).toBeNull();
    }
    // Y lo dice en pantalla, porque quien lo usa tiene derecho a saberlo.
    expect(staffHtml).toContain('idc.noStore');
  });

  it('el escaneo manda la revisión: sin eso el servidor lo rechaza', () => {
    expect(staffJs).toContain('id_check_id');
  });

  it('el guardia no puede registrar "aceptado" y "menor de edad" a la vez', () => {
    // La combinación no existe en el módulo: `adult:false` siempre es rechazo.
    expect(Scan.idCheckPayload({ document: 'ine', adult: false }).decision).toBe('rejected');
    expect(Scan.idCheckPayload({ document: 'ine', adult: true }).decision).toBe('accepted');
  });

  it('un rechazo siempre lleva motivo', () => {
    expect(Scan.idCheckPayload({ document: 'none', adult: false }).reason).toBeTruthy();
    expect(Scan.idRejectionPayload({ document: 'ine' }).reason).toBeTruthy();
  });

  it('el pase de contingencia pide motivo antes de emitirse', () => {
    expect(Scan.contingencyBlocker({ reservationId: 'r1', reason: '' })).toBe('cont.errReason');
    expect(Scan.contingencyBlocker({ reservationId: null, reason: 'sin teléfono' }))
      .toBe('cont.errNoReservation');
    expect(Scan.contingencyBlocker({ reservationId: 'r1', reason: 'llegó sin teléfono' })).toBeNull();
  });

  it('la caja de contingencia nace escondida y sin código', () => {
    const doc = documento(staffHtml);
    expect(doc.getElementById('cont-box').hasAttribute('hidden')).toBe(true);
    expect(doc.getElementById('cont-result').hasAttribute('hidden')).toBe(true);
    expect(doc.getElementById('cont-code').textContent.trim()).toBe('—');
  });

  it('no se puede escanear sin código ni sin revisión', () => {
    expect(Scan.scanBlocker({ code: '', idCheckId: 'c1' })).toBe('scan.errNoCode');
    expect(Scan.scanBlocker({ code: 'EV2-A', idCheckId: null })).toBe('scan.errNoIdCheck');
    expect(Scan.scanBlocker({ code: 'EV2-A', idCheckId: 'c1' })).toBeNull();
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

  it('cada data-i18n de pase.html está en español y en inglés', () => {
    const usadas = [...claves(html, 'data-i18n'), ...claves(html, 'data-i18n-placeholder'),
      ...claves(html, 'data-i18n-title')];
    expect(usadas.length).toBeGreaterThan(5);
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltantes = usadas.filter((k) => catalogo.t(k) === k);
      expect({ lang, faltantes }).toEqual({ lang, faltantes: [] });
    }
  });

  it('cada texto que pide pass-screen.js existe en los dos idiomas', () => {
    const usadas = new Set();
    const re = /t\('((?:pass|scan|take|error)\.[a-zA-Z0-9_.]+)'/g;
    let m = re.exec(controlador);
    while (m) { usadas.add(m[1]); m = re.exec(controlador); }
    expect(usadas.size).toBeGreaterThanOrEqual(5);
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltantes = [...usadas].filter((k) => catalogo.t(k) === k);
      expect({ lang, faltantes }).toEqual({ lang, faltantes: [] });
    }
  });

  it('los nombres de los tipos de pase existen en los dos idiomas', () => {
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      for (const kind of ['holder', 'guest', 'extra', 'contingency']) {
        expect(catalogo.t(`scan.kind_${kind}`)).not.toBe(`scan.kind_${kind}`);
      }
    }
  });

  it('cada resultado del escaneo tiene su frase, y ninguna repetida', () => {
    const vistas = new Set();
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      for (const motivo of Object.keys(Scan.RESULTS)) {
        const clave = Scan.RESULTS[motivo].key;
        expect(catalogo.t(clave)).not.toBe(clave);
        if (lang === 'es') vistas.add(clave);
      }
    }
    // Dos resultados con la misma frase dejan a la puerta sin saber cuál pasó.
    expect(vistas.size).toBe(Object.keys(Scan.RESULTS).length);
  });

  it('cada texto de la identificación y de la búsqueda existe en los dos idiomas', () => {
    const usadas = new Set();
    const re = /t\('((?:idc|look|cont)\.[a-zA-Z0-9_.]+)'/g;
    let m = re.exec(staffJs);
    while (m) { usadas.add(m[1]); m = re.exec(staffJs); }
    for (const d of Scan.ID_DOCUMENTS) usadas.add(Scan.documentKey(d));
    expect(usadas.size).toBeGreaterThanOrEqual(12);
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltantes = [...usadas].filter((k) => catalogo.t(k) === k);
      expect({ lang, faltantes }).toEqual({ lang, faltantes: [] });
    }
  });
});

describe('el titular administra los pases de su mesa', () => {
  it('cada id que busca booking-screen.js existe en index.html', () => {
    // No había ninguna prueba que atara esos dos archivos, y es justo el fallo que
    // no se nota al cargar: la hoja del pase abre, el bloque de los invitados no
    // aparece, y nadie se entera hasta que el titular quiere repartirlos.
    const doc = documento(indexHtml);
    const faltantes = idsQueBusca(bookingJs).filter((id) => !doc.getElementById(id));
    expect(faltantes).toEqual([]);
  });

  it('el bloque de los pases nace escondido y vacío', () => {
    const doc = documento(indexHtml);
    expect(doc.getElementById('gp-block').hasAttribute('hidden')).toBe(true);
    expect(doc.getElementById('gp-list').textContent.trim()).toBe('');
    expect(doc.getElementById('gp-summary').textContent.trim()).toBe('—');
  });

  it('va DEBAJO del QR del titular: en la puerta lo primero es su código', () => {
    const doc = documento(indexHtml);
    const qr = doc.getElementById('pass-qr');
    const bloque = doc.getElementById('gp-block');
    expect(qr.compareDocumentPosition(bloque)
      & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('la hoja del motivo nace cerrada y fuera de la del pase', () => {
    const doc = documento(indexHtml);
    expect(doc.getElementById('gp-reason-sheet').hasAttribute('hidden')).toBe(true);
    // Fuera, no dentro: anidada, cerrar la del pase se llevaría la del motivo a
    // media escritura.
    expect(doc.getElementById('pass-sheet').contains(doc.getElementById('gp-reason-sheet')))
      .toBe(false);
  });

  it('el campo del nombre solo sale al reasignar, así que nace escondido', () => {
    expect(documento(indexHtml).getElementById('gp-reason-name').hasAttribute('hidden')).toBe(true);
  });

  it('la lista NO pide el payload firmado: ver no es repartir', () => {
    // Se pide pase por pase al compartir. Si la lista lo trajera, la credencial
    // quedaría en la caché del navegador y en el historial.
    expect(bookingJs).toContain('/passes`');
    expect(bookingJs).not.toMatch(/passes\?.*payload/);
  });

  it('cada texto de los pases existe en los dos idiomas', () => {
    const usadas = new Set();
    const re = /t\('(gp\.[a-zA-Z0-9_.]+)'/g;
    let m = re.exec(bookingJs);
    while (m) { usadas.add(m[1]); m = re.exec(bookingJs); }
    expect(usadas.size).toBeGreaterThanOrEqual(10);
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltantes = [...usadas].filter((k) => catalogo.t(k) === k);
      expect({ lang, faltantes }).toEqual({ lang, faltantes: [] });
    }
  });
});
