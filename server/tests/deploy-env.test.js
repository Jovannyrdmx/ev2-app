/**
 * Lo que el `.env` promete tiene que llegar de verdad al contenedor.
 *
 * Esta prueba nace de tres defectos reales, los tres míos, los tres con la misma forma
 * fea: la variable está puesta en el `.env` del servidor, el gerente la ve ahí, y el
 * sistema insiste en que falta.
 *
 *   1. `PIN_LOOKUP_KEY` no viajaba. Sin ella no se le puede generar un PIN a un empleado
 *      nuevo y NADIE del piso puede entrar. Se descubrió dando de alta a alguien.
 *   2. `MERCADOPAGO_ENV` no viajaba, así que con las credenciales puestas el cobro con
 *      terminal contestaba "falta MERCADOPAGO_ENV".
 *   3. El compose pasaba `STRIPE_PUBLIC_KEY` y el código lee `STRIPE_PUBLISHABLE_KEY`,
 *      así que Stripe nunca se habría dado por configurado en producción.
 *
 * Ninguno de los tres se ve en desarrollo: ahí `dotenv` lee el `.env` entero y todo
 * funciona. Solo se ven en el servidor, de noche, con el club abierto. Por eso la
 * comprobación no es un comentario ni una lista en la documentación: es esto.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const RAIZ = path.join(__dirname, '..', '..');
const compose = yaml.load(
  fs.readFileSync(path.join(RAIZ, 'deploy', 'docker-compose.prod.yml'), 'utf8'));

const deServicio = (nombre) => new Set(
  Object.keys((compose.services[nombre] || {}).environment || {}));

/** Todo lo que el código lee de verdad de `process.env`. */
function leidasEnSrc() {
  const nombres = new Set();
  const recorrer = (dir) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const completo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) { recorrer(completo); continue; }
      if (!entrada.name.endsWith('.js')) continue;
      const fuente = fs.readFileSync(completo, 'utf8');
      const re = /process\.env\.([A-Z0-9_]+)/g;
      let m = re.exec(fuente);
      while (m) { nombres.add(m[1]); m = re.exec(fuente); }
    }
  };
  recorrer(path.join(__dirname, '..', 'src'));
  return nombres;
}

/**
 * Las que a propósito NO viajan, con el motivo escrito.
 *
 * Una lista de excepciones sin motivo se convierte en el sitio donde se esconde el
 * siguiente defecto: cada renglón de aquí dice por qué, y quien agregue uno tiene que
 * escribir el suyo.
 */
const A_PROPOSITO = {
  NODE_ENV: 'lo fija el propio compose',
  PORT: 'lo fija el propio compose',
  TZ: 'la pone la imagen',
  npm_package_version: 'la pone npm al arrancar',
  DATABASE_URL: 'el compose arma la conexión con DB_HOST/DB_USER/…, no con una URL',
  WS_PORT: 'el servicio ws recibe PORT; WS_PORT es solo para correrlo suelto en desarrollo',
  MERCADOPAGO_BASE_URL: 'apunta la pasarela a otro sitio. En producción eso NO debe ser '
    + 'configurable desde el .env: es la diferencia entre cobrar en Mercado Pago y cobrar '
    + 'en el servidor de quien haya editado el archivo',
  MERCADOPAGO_TIMEOUT_MS: 'solo para las pruebas',
  MERCADOPAGO_RECOVERY_MS: 'solo para las pruebas',
  SEED_PASSWORD: 'el seed de desarrollo NO debe poder correr en producción ni por accidente',
  TEST_DB_NAME: 'solo para las pruebas',
};

describe('El .env del servidor y el contenedor dicen lo mismo', () => {
  const api = deServicio('api');
  const ws = deServicio('ws');
  const leidas = leidasEnSrc();

  it('cada variable que el código lee llega a algún contenedor, o está excusada por escrito', () => {
    const faltan = [...leidas]
      .filter((n) => !api.has(n) && !ws.has(n))
      .filter((n) => !A_PROPOSITO[n]);
    expect(faltan.sort()).toEqual([]);
  });

  it('cada excusa tiene un motivo escrito, no una lista de nombres', () => {
    for (const [nombre, motivo] of Object.entries(A_PROPOSITO)) {
      expect(typeof motivo).toBe('string');
      expect(motivo.trim().length).toBeGreaterThan(10);
      expect(nombre).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });

  it('el compose no pasa variables que nadie lee', () => {
    // Una de más es una que alguien va a poner en el .env esperando que sirva.
    const delCompose = [...api, ...ws];
    const sobran = delCompose
      .filter((n) => !leidas.has(n))
      // El contenedor de Postgres y el de Caddy tienen las suyas, que el código de la
      // API no lee nunca y con razón.
      .filter((n) => !['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB',
        'EV2_DOMAIN', 'ACME_EMAIL', 'API_URL'].includes(n));
    expect(sobran.sort()).toEqual([]);
  });

  it('PIN_LOOKUP_KEY llega: sin ella no se puede dar de alta a un empleado', () => {
    // Explícita y aparte del barrido de arriba. Es la que rompió el alta de personal,
    // y una prueba con nombre propio es lo que hace que un cambio futuro la vea.
    expect(api.has('PIN_LOOKUP_KEY')).toBe(true);
  });

  it('las llaves de cobro llegan con el nombre EXACTO que lee el código', () => {
    for (const nombre of ['MERCADOPAGO_ACCESS_TOKEN', 'MERCADOPAGO_PUBLIC_KEY',
      'MERCADOPAGO_ENV', 'MERCADOPAGO_WEBHOOK_SECRET',
      'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET']) {
      expect(api.has(nombre)).toBe(true);
    }
  });

  it('ninguna variable obligatoria se queda sin aviso al arrancar', () => {
    // `${X:?mensaje}` hace que el compose se niegue a levantar diciendo qué falta, en
    // vez de arrancar y fallar de noche. Las que de verdad no tienen alternativa lo
    // llevan.
    const crudo = fs.readFileSync(
      path.join(RAIZ, 'deploy', 'docker-compose.prod.yml'), 'utf8');
    for (const nombre of ['JWT_SECRET', 'BANK_ENCRYPTION_KEY', 'DB_PASSWORD',
      'ALLOWED_ORIGINS']) {
      expect(crudo).toContain(`\${${nombre}:?`);
    }
  });
});
