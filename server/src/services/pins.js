/**
 * EV2 — el PIN de 6 dígitos con el que entra el personal (D46).
 *
 * ---------------------------------------------------------------------------
 * Lo primero, porque decide todo lo demás
 * ---------------------------------------------------------------------------
 * El dueño escogió que se entre **solo con el PIN**: sin número de empleado y sin
 * escoger el nombre de una lista. Es lo más rápido con las manos ocupadas, y tiene un
 * costo que este archivo existe para pagar:
 *
 *   Seis dígitos son 1,000,000 de combinaciones. Con 40 empleados, cada intento a
 *   ciegas le atina a ALGUIEN con probabilidad 1 en 25,000. El atacante no le pega a
 *   una cuenta: le pega al espacio entero.
 *
 * De ahí salen las tres reglas de aquí, y ninguna es opcional:
 *
 *  1. **El freno se cuenta por CLUB.** Bloquear "la cuenta atacada" no sirve cuando no
 *     se sabe cuál es, y limitar por IP no alcanza si el atacante trae diez. Pasados
 *     unos fallos, cada intento empieza a tardar más. **No se cierra la puerta**:
 *     dejar al personal entero sin entrar a las once de un sábado es peor que el
 *     riesgo, y además le regalaría a cualquiera una forma de apagar el club tecleando
 *     PINs equivocados a propósito.
 *
 *  2. **Los PIN obvios no existen.** Con un millón de combinaciones y gente escogiendo
 *     a mano, 123456 y 000000 se los llevan los primeros. Prohibirlos no es paternal:
 *     es que sin eso el millón se vuelve una docena.
 *
 *  3. **Un rechazo no dice POR QUÉ.** Como los PIN son únicos, decirle a alguien "ese
 *     ya está en uso" le acaba de revelar el PIN de otro. Débil y ocupado comparten un
 *     solo mensaje, a propósito, y `changePin` los devuelve con el mismo código.
 *
 * ---------------------------------------------------------------------------
 * Por qué dos huellas del mismo PIN
 * ---------------------------------------------------------------------------
 * `pin_hash` es bcrypt: lleva sal, así que el mismo PIN da un hash distinto cada vez y
 * sirve para VERIFICAR pero no para BUSCAR. `pin_lookup` es un HMAC con una llave que
 * vive en el `.env` y nunca en la base: es determinista, se indexa, y es lo que hace
 * cumplir que el PIN no se repita. Con la base robada pero sin la llave, nadie puede
 * recorrer el millón de combinaciones para armar la tabla inversa.
 */
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { ApiError } = require('../middleware/errors');

const PIN_LENGTH = 6;

/**
 * La llave del HMAC. Sin ella el PIN no funciona, y el servidor lo dice al arrancar
 * en vez de fallar en el primer acceso de la noche.
 */
function lookupKey() {
  const key = process.env.PIN_LOOKUP_KEY;
  if (!key || key.length < 32) {
    throw new Error('Falta PIN_LOOKUP_KEY en el entorno (mínimo 32 caracteres). '
      + 'Sin ella el acceso por PIN no puede funcionar; genera una con '
      + '`openssl rand -base64 48` y ponla en el .env.');
  }
  return key;
}

/** ¿Está configurado el acceso por PIN en este servidor? */
const isConfigured = () => Boolean(process.env.PIN_LOOKUP_KEY
  && process.env.PIN_LOOKUP_KEY.length >= 32);

/** La huella con la que se busca. Determinista, indexable, inútil sin la llave. */
const lookupOf = (pin) => crypto.createHmac('sha256', lookupKey())
  .update(String(pin)).digest('hex');

// ---------------------------------------------------------------- qué PIN se permite

/**
 * Los PIN que no se pueden usar.
 *
 * No es una lista de "contraseñas comunes" copiada de internet: son los patrones que
 * de verdad teclea alguien a quien le acaban de pedir seis dígitos. Con un millón de
 * combinaciones, que los primeros veinte se los lleven estos deja el espacio real en
 * casi nada.
 */
function isWeakPin(pin) {
  const s = String(pin);
  if (!/^\d{6}$/.test(s)) return true;
  // Todos iguales: 000000, 111111…
  if (/^(\d)\1{5}$/.test(s)) return true;
  // Escaleras para arriba y para abajo, empezando donde sea: 123456, 456789, 987654.
  const sube = '01234567890123456789';
  const baja = '98765432109876543210';
  if (sube.includes(s) || baja.includes(s)) return true;
  // Parejas y tríos repetidos: 121212, 123123, 112233.
  if (/^(\d{2})\1{2}$/.test(s) || /^(\d{3})\1$/.test(s)) return true;
  if (/^(\d)\1(\d)\2(\d)\3$/.test(s)) return true;
  return false;
}

/**
 * ¿El PIN es la fecha de nacimiento de esa persona?
 *
 * Es lo segundo que teclea quien no quiere pensarlo, y es lo primero que prueba quien
 * conoce al empleado — que en un club es medio mundo. Se cubren las tres formas de
 * escribirla, incluida la invertida.
 */
function looksLikeBirthDate(pin, birthDate) {
  if (!birthDate) return false;
  // Postgres entrega una columna DATE como un objeto `Date` de JavaScript, no como
  // "1996-05-04". Sin normalizarlo aquí, la expresión de abajo no casa NUNCA con lo
  // que viene de la base y esta comprobación se vuelve decorativa: aceptaría la fecha
  // de nacimiento como PIN sin decir nada. Lo encontró una prueba, no la lectura.
  const texto = birthDate instanceof Date
    ? birthDate.toISOString().slice(0, 10)
    : String(birthDate).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (!m) return false;
  const [, yyyy, mm, dd] = m;
  const yy = yyyy.slice(2);
  return [
    `${dd}${mm}${yy}`, `${mm}${dd}${yy}`, `${yy}${mm}${dd}`,
    `${dd}${mm}${yyyy.slice(0, 2)}`, `${yyyy}${mm}`.slice(0, 6), `${dd}${mm}${dd}`,
  ].includes(String(pin));
}

/**
 * Un PIN al azar que no sea de los prohibidos.
 *
 * `crypto.randomInt` y no `Math.random`: un PIN que se puede predecir sabiendo la hora
 * a la que se dio de alta al empleado no es un PIN.
 */
function generatePin({ birthDate = null } = {}) {
  for (let i = 0; i < 100; i += 1) {
    const pin = String(crypto.randomInt(0, 1000000)).padStart(PIN_LENGTH, '0');
    if (!isWeakPin(pin) && !looksLikeBirthDate(pin, birthDate)) return pin;
  }
  // Con 100 tiros y menos de 200 patrones prohibidos esto no pasa nunca; si pasara,
  // fallar es mejor que entregar un PIN débil.
  throw new Error('No se pudo generar un PIN aceptable');
}

// ---------------------------------------------------------------- el freno del club

/** Cuántos fallos seguidos empiezan a costar tiempo, y cuánto. */
const THROTTLE = [
  { failures: 100, delayMs: 5000 },
  { failures: 30, delayMs: 2000 },
];
const WINDOW_MINUTES = 10;

/** Los fallos de este club en la ventana. Una sola consulta, contra el índice. */
async function recentFailures(runner, { nightclubId, minutes = WINDOW_MINUTES }) {
  const { rows } = await runner.query(
    `SELECT count(*)::int AS n FROM pin_attempts
      WHERE nightclub_id = $1 AND NOT ok
        AND created_at > now() - ($2::int * interval '1 minute')`,
    [nightclubId, minutes]);
  return rows[0].n;
}

/** Cuánto hay que hacer esperar al siguiente intento, según cuántos fallos van. */
function delayFor(failures) {
  const regla = THROTTLE.find((r) => failures >= r.failures);
  return regla ? regla.delayMs : 0;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Queda el intento escrito. El acierto también: sin él no se distingue un ataque de un teclado pegajoso. */
async function recordAttempt(runner, {
  nightclubId, ip = null, ok, userId = null,
}) {
  await runner.query(
    'INSERT INTO pin_attempts (nightclub_id, ip, ok, user_id) VALUES ($1,$2,$3,$4)',
    [nightclubId, ip, ok, userId]);
}

// ---------------------------------------------------------------- entrar y cambiar

/** Los roles que entran con PIN. La gerencia, solo desde la red del club (ver rutas). */
const PIN_ROLES = ['waiter', 'bartender', 'dancer', 'dj', 'light_tech', 'valet',
  'hostess', 'warehouse', 'driver', 'manager', 'admin'];

/**
 * Busca al dueño del PIN y lo verifica.
 *
 * Devuelve `{ user }` o `{ user: null }`. **Nunca** dice si el PIN existía pero la
 * cuenta estaba bloqueada, ni ninguna otra distinción: cualquier diferencia entre
 * "ese PIN no es de nadie" y "ese PIN es de alguien pero…" es una forma de averiguar
 * PINes ajenos de a uno por intento.
 */
async function findByPin(runner, { nightclubId, pin }) {
  const { rows } = await runner.query(
    `SELECT u.* FROM users u
      WHERE u.nightclub_id = $1 AND u.pin_lookup = $2`,
    [nightclubId, lookupOf(pin)]);
  const user = rows[0];
  if (!user) return { user: null };

  // Se compara igual contra bcrypt aunque el HMAC ya haya coincidido: el HMAC dice
  // "este renglón corresponde a este PIN", bcrypt lo confirma. Si algún día la llave
  // del HMAC se filtra, esto sigue siendo lo que impide entrar.
  const ok = await bcrypt.compare(String(pin), user.pin_hash || '');
  if (!ok) return { user: null };
  if (user.status !== 'active') return { user: null };
  if (!PIN_ROLES.includes(user.role)) return { user: null };
  return { user };
}

/**
 * El acceso completo: frena si hace falta, busca, y deja el intento escrito.
 *
 * El freno se aplica ANTES de buscar, y también cuando el PIN resulta correcto: si
 * solo se frenara a los que fallan, un atacante mediría el tiempo de respuesta para
 * saber cuándo le atinó.
 */
async function attemptLogin(runner, { nightclubId, pin, ip = null }) {
  const fallos = await recentFailures(runner, { nightclubId });
  const espera = delayFor(fallos);
  if (espera > 0) await sleep(espera);

  const { user } = await findByPin(runner, { nightclubId, pin });
  await recordAttempt(runner, {
    nightclubId, ip, ok: Boolean(user), userId: user ? user.id : null,
  });
  return { user, throttledMs: espera, recentFailures: fallos };
}

/** Lo que se guarda de un PIN nuevo. */
async function hashPin(pin) {
  return { pin_hash: await bcrypt.hash(String(pin), 10), pin_lookup: lookupOf(pin) };
}

/**
 * Le pone un PIN a alguien. Devuelve `false` si ya lo tiene otro en el club.
 *
 * El choque se detecta por el índice único de la base y NO leyendo antes: entre el
 * "¿está libre?" y el "tómalo" cabe otro que lo tome primero, y a las once de la noche
 * dando de alta a dos personas a la vez eso pasa.
 */
async function setPin(runner, { userId, pin, mustChange = false, issuedBy = null }) {
  const { pin_hash: hash, pin_lookup: lookup } = await hashPin(pin);
  try {
    const { rows } = await runner.query(
      `UPDATE users
          SET pin_hash = $2, pin_lookup = $3, pin_set_at = now(),
              must_change_pin = $4,
              pin_issued_by = COALESCE($5, pin_issued_by),
              pin_issued_at = CASE WHEN $5 IS NULL THEN pin_issued_at ELSE now() END,
              updated_at = now()
        WHERE id = $1
        RETURNING id`,
      [userId, hash, lookup, mustChange, issuedBy]);
    return rows.length > 0;
  } catch (err) {
    if (err.code === '23505') return false;
    throw err;
  }
}

/**
 * Genera un PIN libre y se lo asigna. Devuelve el PIN en claro, UNA vez.
 *
 * Reintenta ante un choque en vez de fallar: con 40 empleados en un millón de
 * combinaciones el choque es rarísimo, pero cuando pasa lo correcto es tirar otro
 * dado, no hacer que el administrador lo intente de nuevo a mano.
 */
async function issuePin(runner, { userId, birthDate = null, issuedBy = null }) {
  for (let i = 0; i < 20; i += 1) {
    const pin = generatePin({ birthDate });
    // En serie a proposito: cada intento depende de si el anterior choco.
    const ok = await setPin(runner, { userId, pin, mustChange: true, issuedBy });
    if (ok) return pin;
  }
  throw ApiError.conflict('No se pudo generar un PIN libre para este club');
}

/**
 * El empleado cambia su PIN.
 *
 * Débil y ocupado devuelven **el mismo** código a propósito: son los dos únicos
 * motivos de rechazo, y distinguirlos convertiría esta ruta en una forma de averiguar
 * los PIN de los demás de a uno por intento.
 */
async function changePin(runner, { user, newPin }) {
  if (!/^\d{6}$/.test(String(newPin))) return { ok: false, code: 'format' };
  if (isWeakPin(newPin) || looksLikeBirthDate(newPin, user.birth_date)) {
    return { ok: false, code: 'unavailable' };
  }
  const puesto = await setPin(runner, { userId: user.id, pin: newPin, mustChange: false });
  if (!puesto) return { ok: false, code: 'unavailable' };
  return { ok: true };
}

module.exports = {
  PIN_LENGTH,
  PIN_ROLES,
  THROTTLE,
  WINDOW_MINUTES,
  isConfigured,
  lookupOf,
  isWeakPin,
  looksLikeBirthDate,
  generatePin,
  recentFailures,
  delayFor,
  recordAttempt,
  findByPin,
  attemptLogin,
  hashPin,
  setPin,
  issuePin,
  changePin,
};
