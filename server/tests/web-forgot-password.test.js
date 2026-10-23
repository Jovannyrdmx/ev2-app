/**
 * "¿Olvidaste tu contraseña?" en la web (D127).
 *
 * Lo que vigila:
 *   1. Las NUEVE pantallas con formulario de correo y contraseña cargan el módulo, y lo
 *      cargan después de `format.js` (de donde toma los textos).
 *   2. El enlace se monta dentro del formulario, usa el correo que ya está escrito, y
 *      enseña el mismo mensaje haya o no cuenta. Sin correo escrito, lo pide en vez de
 *      mandar una petición vacía.
 *   3. `restablecer.html` tiene todo lo que su pantalla busca, lee la clave del
 *      fragmento (no de la query), y valida el par de contraseñas antes de mandar.
 *   4. Todos los textos nuevos existen en los dos idiomas.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const WEB = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');
const F = require(path.join(WEB, 'js', 'format.js'));
const Forgot = require(path.join(WEB, 'js', 'forgot-password.js'));
const Reset = require(path.join(WEB, 'js', 'reset-screen.js'));

const PANTALLAS_CON_ACCESO = ['index.html', 'manager.html', 'staff.html', 'caja.html',
  'bartender.html', 'driver.html', 'valet.html', 'employee-portal.html', 'almacen.html'];

const scriptsDe = (html) => [...html.matchAll(/<script src="js\/([a-z0-9-]+)\.js"><\/script>/g)]
  .map((m) => m[1]);

describe('El enlace en las pantallas de acceso', () => {
  it('todas las pantallas con #form-login cargan el módulo, después de format.js', () => {
    const conFormulario = fs.readdirSync(WEB).filter((f) => f.endsWith('.html'))
      .filter((f) => /id="form-login"/.test(leer(f))).sort();
    expect(conFormulario).toEqual([...PANTALLAS_CON_ACCESO].sort());
    for (const pagina of conFormulario) {
      const orden = scriptsDe(leer(pagina));
      expect({ pagina, cargado: orden.includes('forgot-password') })
        .toEqual({ pagina, cargado: true });
      expect(orden.indexOf('forgot-password')).toBeGreaterThan(orden.indexOf('format'));
    }
  });

  it('cada una tiene el campo de correo del que toma la dirección', () => {
    for (const pagina of PANTALLAS_CON_ACCESO) {
      const html = leer(pagina);
      expect({ pagina, tiene: /id="login-email"/.test(html) }).toEqual({ pagina, tiene: true });
    }
  });

  it('acepta el correo escrito aunque traiga mayúsculas y espacios, y rechaza lo que no es correo', () => {
    expect(Forgot.emailFrom({ value: '  Erick@Gmail.COM ' })).toBe('erick@gmail.com');
    expect(Forgot.emailFrom({ value: 'erick' })).toBeNull();
    expect(Forgot.emailFrom({ value: '' })).toBeNull();
    expect(Forgot.emailFrom(null)).toBeNull();
  });

  it('traduce cada respuesta del servidor a un texto que existe en los dos idiomas', () => {
    for (const status of [202, 429, 501, 400, 500, 0]) {
      const key = Forgot.messageKeyFor(status);
      F.setLanguage('es');
      expect(F.t(key)).not.toBe(key);
      F.setLanguage('en');
      expect(F.t(key)).not.toBe(key);
    }
    expect(Forgot.messageKeyFor(202)).toBe('forgot.sent');
    expect(Forgot.messageKeyFor(429)).toBe('forgot.tooMany');
    expect(Forgot.messageKeyFor(501)).toBe('forgot.unavailable');
  });

  describe('montado en index.html', () => {
    let dom; let llamadas;
    const esperar = () => new Promise((r) => setTimeout(r, 0));

    beforeEach(() => {
      dom = new JSDOM(leer('index.html'));
      llamadas = [];
    });
    afterEach(() => dom.window.close());

    const montar = (status = 202) => {
      F.setLanguage('es');
      const d = dom.window.document;
      return Forgot.mount({
        form: d.getElementById('form-login'),
        emailInput: d.getElementById('login-email'),
        apiBase: '/api',
        clubSlug: 'ev2',
        t: F.t,
        document: d,
        fetch: async (url, init) => {
          llamadas.push({ url, body: JSON.parse(init.body) });
          return { status };
        },
      });
    };

    it('pone el enlace DENTRO del formulario, para que se oculte con él al cambiar a "crear cuenta"', () => {
      const { link } = montar();
      const form = dom.window.document.getElementById('form-login');
      expect(form.contains(link)).toBe(true);
      expect(link.type).toBe('button');
      expect(link.textContent).toBe('¿Olvidaste tu contraseña?');
      expect(link.getAttribute('data-i18n')).toBe('forgot.link');
    });

    it('sin correo escrito, lo pide y NO manda nada', async () => {
      const { link, message } = montar();
      link.click();
      await esperar();
      expect(llamadas).toEqual([]);
      expect(message.hidden).toBe(false);
      expect(message.textContent).toBe(F.t('forgot.needEmail'));
    });

    it('con el correo escrito, pide el enlace para ese correo y ese club', async () => {
      const { link, message } = montar(202);
      dom.window.document.getElementById('login-email').value = ' Invitado@Test.MX ';
      link.click();
      await esperar();
      expect(llamadas).toEqual([{
        url: '/api/auth/password/forgot',
        body: { nightclub_slug: 'ev2', email: 'invitado@test.mx' },
      }]);
      expect(message.textContent).toBe(F.t('forgot.sent'));
      expect(link.disabled).toBe(false);
    });

    it('si el servidor no tiene correo configurado (501), lo dice en vez de prometer', async () => {
      const { link, message } = montar(501);
      dom.window.document.getElementById('login-email').value = 'a@b.mx';
      link.click();
      await esperar();
      expect(message.textContent).toBe(F.t('forgot.unavailable'));
    });

    it('se monta solo desde la página con lo que trae en sus <meta>', () => {
      const w = dom.window;
      w.fetch = async () => ({ status: 202 });
      w.EV2Format = F;
      const montado = Forgot.autoMount(w);
      expect(montado).not.toBeNull();
      expect(w.document.getElementById('forgot-password')).toBe(montado.link);
    });
  });
});

describe('La página de contraseña nueva', () => {
  const html = leer('restablecer.html');
  const modulo = leer('js/reset-screen.js');

  it('cada identificador que busca la pantalla existe en restablecer.html', () => {
    const dom = new JSDOM(html);
    const ids = new Set();
    for (const m of modulo.matchAll(/\$\('([a-z0-9-]+)'\)/gi)) ids.add(m[1]);
    for (const m of modulo.matchAll(/'(reset-(?:checking|form|invalid|done))'/g)) ids.add(m[1]);
    const faltan = [...ids].filter((id) => !dom.window.document.getElementById(id));
    expect(faltan).toEqual([]);
    expect(ids.size).toBeGreaterThan(6);
    dom.window.close();
  });

  it('es pública, no se indexa y vuelve a index.html para entrar o pedir otro enlace', () => {
    expect(html).toMatch(/name="robots" content="noindex, nofollow"/);
    expect(html).not.toMatch(/js\/api\.js/);
    expect(html).toMatch(/href="index\.html"/);
  });

  it('lee la clave del fragmento (#token=), que no viaja al servidor ni en el Referer', () => {
    expect(Reset.tokenFromHash('#token=abc_DEF-123')).toBe('abc_DEF-123');
    expect(Reset.tokenFromHash('#token=abc%2Bdef')).toBe('abc+def');
    expect(Reset.tokenFromHash('#otra=1&token=xyz')).toBe('xyz');
    expect(Reset.tokenFromHash('')).toBe('');
    expect(Reset.tokenFromHash('?token=no-en-query')).toBe('');
  });

  it('valida el par de contraseñas antes de mandar', () => {
    expect(Reset.validate('corta', 'corta')).toBe('reset.errShort');
    expect(Reset.validate('NuevaClave2026', 'OtraClave2026')).toBe('reset.errMismatch');
    expect(Reset.validate('NuevaClave2026', 'NuevaClave2026')).toBeNull();
  });

  it('traduce las respuestas de guardar a textos que existen', () => {
    expect(Reset.errorKeyFor(401)).toBe('reset.invalidNote');
    expect(Reset.errorKeyFor(429)).toBe('forgot.tooMany');
    for (const status of [400, 401, 429, 500, 0]) {
      const key = Reset.errorKeyFor(status);
      expect(F.t(key)).not.toBe(key);
    }
  });

  it('con un enlace vigente enseña el formulario y guarda la contraseña nueva', async () => {
    const dom = new JSDOM(html, { url: 'https://club.test/restablecer.html#token=abcdefghijklmnop' });
    const w = dom.window;
    const llamadas = [];
    w.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      llamadas.push({ url, body });
      if (url.endsWith('/check')) return { status: 200, json: async () => ({ valid: true, email_masked: 'i***o@test.mx' }) };
      return { status: 200, json: async () => ({ reset: true }) };
    };
    w.EV2Format = F;
    Reset.boot(w);
    await new Promise((r) => setTimeout(r, 0));
    const d = w.document;
    expect(d.getElementById('reset-form').hidden).toBe(false);
    expect(d.getElementById('reset-checking').hidden).toBe(true);
    expect(d.getElementById('reset-for').textContent).toContain('i***o@test.mx');
    expect(llamadas[0].body).toEqual({ token: 'abcdefghijklmnop' });

    d.getElementById('reset-password').value = 'NuevaClave2026';
    d.getElementById('reset-repeat').value = 'Distinta2026';
    d.getElementById('reset-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(d.getElementById('reset-error').hidden).toBe(false);
    expect(llamadas).toHaveLength(1);

    d.getElementById('reset-repeat').value = 'NuevaClave2026';
    d.getElementById('reset-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(llamadas[1]).toEqual({
      url: '/api/auth/password/reset',
      body: { token: 'abcdefghijklmnop', new_password: 'NuevaClave2026' },
    });
    expect(d.getElementById('reset-done').hidden).toBe(false);
    expect(d.getElementById('reset-form').hidden).toBe(true);
    dom.window.close();
  });

  it('con un enlace caducado lo dice de una vez, sin pedir la contraseña', async () => {
    const dom = new JSDOM(html, { url: 'https://club.test/restablecer.html#token=abcdefghijklmnop' });
    const w = dom.window;
    w.fetch = async () => ({ status: 200, json: async () => ({ valid: false }) });
    w.EV2Format = F;
    Reset.boot(w);
    await new Promise((r) => setTimeout(r, 0));
    expect(w.document.getElementById('reset-invalid').hidden).toBe(false);
    expect(w.document.getElementById('reset-form').hidden).toBe(true);
    dom.window.close();
  });

  it('sin clave en el enlace no pregunta nada al servidor', () => {
    const dom = new JSDOM(html, { url: 'https://club.test/restablecer.html' });
    const w = dom.window;
    let llamadas = 0;
    w.fetch = async () => { llamadas += 1; return { status: 200, json: async () => ({}) }; };
    w.EV2Format = F;
    Reset.boot(w);
    expect(llamadas).toBe(0);
    expect(w.document.getElementById('reset-invalid').hidden).toBe(false);
    expect(w.document.getElementById('reset-invalid-note').textContent).toBe(F.t('reset.noToken'));
    dom.window.close();
  });
});

describe('Los textos', () => {
  it('cada clave nueva existe en español y en inglés', () => {
    const claves = ['forgot.link', 'forgot.needEmail', 'forgot.sending', 'forgot.sent',
      'forgot.tooMany', 'forgot.unavailable', 'reset.title', 'reset.checking', 'reset.for',
      'reset.new', 'reset.repeat', 'reset.save', 'reset.saving', 'reset.errShort',
      'reset.errMismatch', 'reset.invalidTitle', 'reset.invalidNote', 'reset.noToken',
      'reset.doneTitle', 'reset.doneNote', 'reset.goLogin', 'reset.again'];
    for (const lang of ['es', 'en']) {
      F.setLanguage(lang);
      for (const k of claves) expect({ lang, k, texto: F.t(k) }).not.toEqual({ lang, k, texto: k });
    }
    F.setLanguage('en');
    expect(F.t('forgot.link')).toBe('Forgot your password?');
    expect(F.tf('reset.for', { email: 'a***@x.mx' })).toBe('For the account a***@x.mx.');
  });
});
