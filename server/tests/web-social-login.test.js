/**
 * El acceso con una cuenta de otro, del lado del navegador.
 *
 * Dos cosas se prueban aquí, y las dos han roto pantallas antes:
 *
 * 1. **Que los `id` existan.** `index-screen.js` busca sus elementos con `$('id')`.
 *    Un `id` que no está no falla al cargar la página: revienta cuando la persona
 *    vuelve de Facebook, que es el único momento en que ese código corre.
 *
 * 2. **Que el pase NO se quede en el historial.** Lo que vuelve en `#h=` abre una
 *    sesión, y el fragmento sobrevive en el historial del navegador aunque no viaje
 *    al servidor. En un teléfono prestado eso sería la cuenta del cliente al alcance
 *    del siguiente que le dé al botón de atrás.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const indexHtml = leer('index.html');
const controlador = leer('js/index-screen.js');
const Social = require(path.join(ROOT, 'js', 'social-login.js'));
const catalogo = require(path.join(ROOT, 'js', 'format.js'));

const abiertas = [];
afterEach(() => { while (abiertas.length) abiertas.pop().close(); });

function documento(url = 'https://ev2.systems/index.html') {
  const dom = new JSDOM(indexHtml, { url });
  abiertas.push(dom.window);
  return dom;
}

// ===========================================================================
// El HTML y su controlador se encuentran
// ===========================================================================

describe('index.html tiene lo que el controlador social busca', () => {
  const NECESARIOS = [
    'social-block', 'social-buttons',
    'social-finish', 'social-finish-note', 'social-finish-cancel',
    'social-email', 'social-birth', 'social-terms',
    'social-panel', 'social-panel-list', 'social-panel-add',
    'social-panel-empty', 'social-panel-note', 'social-panel-error',
  ];

  it.each(NECESARIOS)('el id "%s" existe en index.html', (id) => {
    const doc = documento().window.document;
    expect(doc.getElementById(id)).not.toBeNull();
  });

  it('el controlador no busca ningún id social que no exista', () => {
    const doc = documento().window.document;
    const buscados = new Set();
    const re = /\$\('(social[a-z0-9-]*)'\)/g;
    let m = re.exec(controlador);
    while (m) { buscados.add(m[1]); m = re.exec(controlador); }

    expect(buscados.size).toBeGreaterThan(0);
    const faltantes = [...buscados].filter((id) => doc.getElementById(id) === null);
    expect(faltantes).toEqual([]);
  });

  it('el formulario de completar y el panel nacen ocultos', () => {
    const doc = documento().window.document;
    expect(doc.getElementById('social-finish').hidden).toBe(true);
    expect(doc.getElementById('social-panel').hidden).toBe(true);
    // El bloque de botones también: solo se enseña si el servidor reporta alguno
    // encendido. Un botón de Facebook sin credenciales manda a la persona a una
    // pantalla de Meta que la rechaza.
    expect(doc.getElementById('social-block').hidden).toBe(true);
    expect(doc.getElementById('social-buttons').children).toHaveLength(0);
  });

  it('index.html carga social-login.js antes del controlador', () => {
    const social = indexHtml.indexOf('js/social-login.js');
    const screen = indexHtml.indexOf('js/index-screen.js');
    expect(social).toBeGreaterThan(-1);
    expect(social).toBeLessThan(screen);
  });

  it('la fecha de nacimiento y los términos son obligatorios en el HTML', () => {
    const doc = documento().window.document;
    // El servidor los exige igual; esto es para que el navegador lo diga antes de
    // que la persona mande un formulario que va a ser rechazado.
    expect(doc.getElementById('social-birth').required).toBe(true);
    expect(doc.getElementById('social-terms').required).toBe(true);
  });
});

// ===========================================================================
// Los textos existen en los dos idiomas
// ===========================================================================

describe('los textos del acceso social están en español y en inglés', () => {
  const CLAVES = [
    'social.or', 'social.with', 'social.link', 'social.unlink', 'social.linked',
    'social.linkedAccounts', 'social.none', 'social.lastWayIn',
    'social.finishTitle', 'social.finishNote', 'social.finishNoteGeneric',
    'social.finish', 'social.cancel',
  ];

  it.each(CLAVES)('la clave "%s" está en los dos idiomas', (clave) => {
    catalogo.setLanguage('es');
    expect(catalogo.t(clave)).not.toBe(clave);
    catalogo.setLanguage('en');
    expect(catalogo.t(clave)).not.toBe(clave);
    catalogo.setLanguage('es');
  });

  it('cada error del servidor tiene su texto en los dos idiomas', () => {
    for (const clave of Object.values(Social.ERROR_KEYS)) {
      catalogo.setLanguage('es');
      expect(catalogo.t(clave)).not.toBe(clave);
      catalogo.setLanguage('en');
      expect(catalogo.t(clave)).not.toBe(clave);
    }
    catalogo.setLanguage('es');
  });

  it('el texto de "correo ya usado" explica el único camino que hay', () => {
    catalogo.setLanguage('es');
    const texto = catalogo.t('social.errEmailTaken');
    // Sin esto la persona vuelve a apretar el mismo botón tres veces y se va.
    expect(texto).toMatch(/contraseña/i);
    expect(texto).toMatch(/perfil/i);
  });

  it('el nombre del proveedor se sustituye de verdad', () => {
    catalogo.setLanguage('es');
    expect(catalogo.tf('social.with', { provider: 'Facebook' })).toBe('Entrar con Facebook');
  });
});

// ===========================================================================
// Leer la vuelta del proveedor
// ===========================================================================

describe('EV2Social.readHash', () => {
  it('reconoce el pase de sesión', () => {
    expect(Social.readHash('#h=abc123')).toEqual({ kind: 'session', value: 'abc123' });
  });

  it('reconoce el registro por terminar', () => {
    expect(Social.readHash('#oauth_signup=tok.en.aqui'))
      .toEqual({ kind: 'signup', value: 'tok.en.aqui' });
  });

  it('reconoce la cuenta ligada y el error', () => {
    expect(Social.readHash('#oauth_linked=facebook'))
      .toEqual({ kind: 'linked', value: 'facebook' });
    expect(Social.readHash('#oauth_error=email_taken'))
      .toEqual({ kind: 'error', value: 'email_taken' });
  });

  it('un fragmento vacío o ajeno no es nada', () => {
    expect(Social.readHash('')).toBeNull();
    expect(Social.readHash('#')).toBeNull();
    expect(Social.readHash('#seccion-precios')).toBeNull();
    expect(Social.readHash(undefined)).toBeNull();
  });
});

describe('EV2Social.takeFromLocation', () => {
  it('BORRA el pase del historial en la misma operación en que lo lee', () => {
    const { window } = documento('https://ev2.systems/index.html#h=pase-secreto');

    const leido = Social.takeFromLocation(window.location, window.history);

    expect(leido).toEqual({ kind: 'session', value: 'pase-secreto' });
    // Lo que queda en la barra y en el historial ya no lleva el pase.
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('pase-secreto');
  });

  it('reemplaza la entrada del historial en vez de añadir una nueva', () => {
    const { window } = documento('https://ev2.systems/index.html#h=pase-secreto');
    const replaceState = jest.fn();

    Social.takeFromLocation(window.location, { replaceState });

    // `location.hash = ''` añadiría una entrada NUEVA y dejaría la vieja —con el
    // pase— justo detrás del botón de atrás.
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0][2]).not.toContain('pase-secreto');
  });

  it('conserva la búsqueda de la dirección al limpiar', () => {
    const { window } = documento('https://ev2.systems/index.html?club=ev2#h=pase');
    const replaceState = jest.fn();

    Social.takeFromLocation(window.location, { replaceState });

    expect(replaceState.mock.calls[0][2]).toContain('?club=ev2');
  });

  it('sin fragmento no toca el historial', () => {
    const { window } = documento();
    const replaceState = jest.fn();

    expect(Social.takeFromLocation(window.location, { replaceState })).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('si el navegador no deja tocar el historial, igual devuelve lo leído', () => {
    const { window } = documento('https://ev2.systems/index.html#h=pase');
    const replaceState = () => { throw new Error('bloqueado'); };

    expect(Social.takeFromLocation(window.location, { replaceState }))
      .toEqual({ kind: 'session', value: 'pase' });
  });
});

// ===========================================================================
// La dirección de ida y la lista de botones
// ===========================================================================

describe('EV2Social.startUrl', () => {
  it('lleva el club y el destino', () => {
    const url = new URL(Social.startUrl({
      baseUrl: '/api', provider: 'facebook', clubSlug: 'ev2',
    }), 'https://ev2.systems');

    expect(url.pathname).toBe('/api/auth/oauth/facebook/start');
    expect(url.searchParams.get('nightclub_slug')).toBe('ev2');
    expect(url.searchParams.get('redirect_to')).toBe('index.html');
  });

  it('no duplica la barra si la base la trae', () => {
    expect(Social.startUrl({ baseUrl: 'https://ev2.systems/api/', provider: 'facebook', clubSlug: 'ev2' }))
      .toContain('https://ev2.systems/api/auth/oauth/facebook/start');
  });

  it('escapa el club: un slug con caracteres raros no rompe la dirección', () => {
    const url = Social.startUrl({ provider: 'facebook', clubSlug: 'club & bar' });
    expect(url).not.toContain(' ');
    expect(new URL(url, 'https://ev2.systems').searchParams.get('nightclub_slug'))
      .toBe('club & bar');
  });
});

describe('EV2Social.enabledProviders', () => {
  const estado = {
    providers: [
      { provider: 'facebook', label: 'Facebook', enabled: true, available: true },
      { provider: 'instagram', label: 'Instagram', enabled: false, available: false },
    ],
  };

  it('solo devuelve los encendidos, con su cara', () => {
    const lista = Social.enabledProviders(estado);
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ provider: 'facebook', label: 'Facebook' });
    expect(lista[0].icon).toContain('facebook');
  });

  it('Instagram no se pinta: el login de consumidor ya no existe', () => {
    expect(Social.enabledProviders(estado).map((p) => p.provider)).not.toContain('instagram');
  });

  it('una respuesta vacía o rota no revienta la pantalla de acceso', () => {
    expect(Social.enabledProviders(null)).toEqual([]);
    expect(Social.enabledProviders({})).toEqual([]);
    expect(Social.enabledProviders({ providers: [null] })).toEqual([]);
  });
});

// ===========================================================================
// Desvincular y completar
// ===========================================================================

describe('EV2Social.canUnlink', () => {
  it('con contraseña, sí', () => {
    expect(Social.canUnlink({ has_password: true, identities: [{ provider: 'facebook' }] }))
      .toBe(true);
  });

  it('sin contraseña y con una sola cuenta ligada, NO', () => {
    expect(Social.canUnlink({ has_password: false, identities: [{ provider: 'facebook' }] }))
      .toBe(false);
  });

  it('sin contraseña pero con dos cuentas, sí', () => {
    expect(Social.canUnlink({
      has_password: false,
      identities: [{ provider: 'facebook' }, { provider: 'google' }],
    })).toBe(true);
  });
});

describe('EV2Social.peekToken y signupNeeds', () => {
  const token = (datos) => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${b64({ alg: 'HS256' })}.${b64(datos)}.firma-que-aqui-no-se-comprueba`;
  };

  it('lee el correo y el proveedor para rellenar la pantalla', () => {
    expect(Social.peekToken(token({ email: 'ana@correo.mx', provider: 'facebook' })))
      .toEqual({ email: 'ana@correo.mx', provider: 'facebook' });
  });

  it('lee bien los acentos', () => {
    expect(Social.peekToken(token({ email: 'añó@correo.mx', provider: 'facebook' })).email)
      .toBe('añó@correo.mx');
  });

  it('un token roto no revienta: devuelve null', () => {
    expect(Social.peekToken('no-es-un-token')).toBeNull();
    expect(Social.peekToken('')).toBeNull();
    expect(Social.peekToken('a.b.c')).toBeNull();
  });

  it('si el proveedor dio correo, no se pide otra vez', () => {
    const falta = Social.signupNeeds(token({ email: 'ana@correo.mx', provider: 'facebook' }),
      Social.peekToken);
    expect(falta.email).toBe(false);
    expect(falta.suggested_email).toBe('ana@correo.mx');
  });

  it('si no lo dio, se pide', () => {
    const falta = Social.signupNeeds(token({ provider: 'facebook' }), Social.peekToken);
    expect(falta.email).toBe(true);
    expect(falta.suggested_email).toBe('');
  });

  it('la fecha de nacimiento y los términos se piden SIEMPRE', () => {
    // De la fecha depende dejar entrar a alguien a un negocio de alcohol, y
    // Facebook no la da de forma fiable. No hay caso en que se salte.
    for (const datos of [{ email: 'a@b.mx' }, {}, { provider: 'google' }]) {
      const falta = Social.signupNeeds(token(datos), Social.peekToken);
      expect(falta.birth_date).toBe(true);
      expect(falta.accept_terms).toBe(true);
    }
  });
});

describe('EV2Social.errorKey', () => {
  it('traduce cada código del servidor', () => {
    expect(Social.errorKey('cancelled')).toBe('social.errCancelled');
    expect(Social.errorKey('email_taken')).toBe('social.errEmailTaken');
    expect(Social.errorKey('expired_state')).toBe('social.errExpired');
  });

  it('un código que no conocemos cae a un texto que igual sirve', () => {
    expect(Social.errorKey('algo_nuevo')).toBe('social.errProvider');
    expect(Social.errorKey(undefined)).toBe('social.errProvider');
  });
});
