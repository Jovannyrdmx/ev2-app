#!/usr/bin/env node
/**
 * EV2 — arranque de un servidor nuevo: crea el club y su PRIMER gerente.
 *
 * Por qué existe
 * --------------
 * `npm run seed` se niega a correr con NODE_ENV=production, y con razón: crea usuarios
 * de prueba con una contraseña conocida. Pero `/auth/register` siempre da de alta un
 * invitado, nunca un gerente. Sin este script, un servidor recién levantado no tiene
 * forma de que NADIE entre a administrarlo: el club no existe y no hay gerente que
 * pueda crear al resto del personal.
 *
 * Qué NO hace
 * -----------
 * No crea mesas, ni tragos, ni personal, ni datos de ejemplo. Solo el club y una
 * persona. Todo lo demás lo carga el gerente desde su pantalla o con `seed:floor` y
 * `seed:prices`, que sí son catálogo real del club.
 *
 * Por qué no es una puerta trasera
 * --------------------------------
 * Se niega a correr si el club ya tiene un gerente o un administrador. Es un arranque,
 * no un "crear gerente cuando se me olvide la contraseña": para eso está el reinicio de
 * contraseña desde otro gerente. Y solo se ejecuta desde la línea de comandos del
 * servidor, nunca por HTTP.
 *
 * Uso
 * ---
 *   CLUB_NAME="EV2 Clandestinoz" CLUB_SLUG=ev2 \
 *   MANAGER_EMAIL=dueno@ejemplo.com MANAGER_NAME="Nombre Apellido" \
 *   MANAGER_BIRTH_DATE=1985-04-23 \
 *   node scripts/bootstrap.js
 *
 * La contraseña se genera aquí y se imprime UNA sola vez. Si prefieres ponerla tú,
 * exporta MANAGER_PASSWORD (mínimo 12 caracteres).
 */
'use strict';

require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db/pool');

const MIN_PASSWORD = 12;

/**
 * Una contraseña que se pueda dictar por teléfono sin deletrear.
 *
 * Cuatro palabras y un número: el dueño la va a leer en una terminal y a teclearla en
 * un celular a oscuras. Una cadena en base64 se teclea mal tres veces y termina
 * apuntada en un papel pegado a la caja.
 */
const WORDS = [
  'ambar', 'bruma', 'cedro', 'duna', 'ebano', 'faro', 'grana', 'hielo',
  'indigo', 'jade', 'lienzo', 'manglar', 'nacar', 'onix', 'pluma', 'quinto',
  'roble', 'salvia', 'tinta', 'umbral', 'vela', 'yunque', 'zafiro', 'brisa',
];

function generatePassword() {
  const pick = () => WORDS[crypto.randomInt(0, WORDS.length)];
  const number = String(crypto.randomInt(1000, 10000));
  return `${pick()}-${pick()}-${pick()}-${number}`;
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Falta ${name} en el entorno`);
  return value;
}

/** El slug viaja en la URL y en el `<meta name="ev2:club">` de cada página. */
function slugify(value) {
  return String(value)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 100);
}

async function bootstrap() {
  const clubName = required('CLUB_NAME');
  const clubSlug = slugify(process.env.CLUB_SLUG || clubName);
  const email = required('MANAGER_EMAIL').toLowerCase();
  const fullName = required('MANAGER_NAME');
  const birthDate = required('MANAGER_BIRTH_DATE');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
    throw new Error('MANAGER_BIRTH_DATE debe ser AAAA-MM-DD');
  }
  const [firstName, ...rest] = fullName.split(/\s+/);
  const lastName = rest.join(' ');

  const password = process.env.MANAGER_PASSWORD || generatePassword();
  if (password.length < MIN_PASSWORD) {
    throw new Error(`MANAGER_PASSWORD debe tener al menos ${MIN_PASSWORD} caracteres`);
  }
  const generated = !process.env.MANAGER_PASSWORD;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // El club: se crea si no existe, y si existe se reutiliza. Volver a correr esto no
    // debe duplicar el club ni pisar su configuración.
    const found = await client.query('SELECT id, name FROM nightclubs WHERE slug = $1', [clubSlug]);
    let clubId;
    let clubCreated = false;
    if (found.rowCount > 0) {
      clubId = found.rows[0].id;
    } else {
      const created = await client.query(
        `INSERT INTO nightclubs (name, slug, city, country, timezone, currency_default)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [clubName, clubSlug,
          process.env.CLUB_CITY || null,
          process.env.CLUB_COUNTRY || 'MX',
          process.env.CLUB_TIMEZONE || 'America/Hermosillo',
          process.env.CLUB_CURRENCY || 'MXN']);
      clubId = created.rows[0].id;
      clubCreated = true;
    }

    // La puerta se cierra sola: si ya hay quien administre, este script no sirve para
    // fabricar otro. Un gerente que perdió su contraseña la recupera con otro gerente,
    // no ejecutando esto en el servidor.
    const admins = await client.query(
      `SELECT count(*)::int AS n FROM users
        WHERE nightclub_id = $1 AND role IN ('manager','admin') AND status <> 'deleted'`,
      [clubId]);
    if (admins.rows[0].n > 0) {
      await client.query('ROLLBACK');
      console.error(
        `El club "${clubSlug}" ya tiene ${admins.rows[0].n} cuenta(s) de gerente o administrador.\n`
        + 'Este script solo arranca un servidor vacío. Para dar de alta a alguien más, '
        + 'hazlo desde la pantalla del gerente; si nadie puede entrar, reinicia la '
        + 'contraseña directamente en la base de datos.');
      return 1;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    // `must_change_password` va en true incluso cuando el dueño eligió su contraseña:
    // esta viajó por una terminal, por el historial del shell y quizá por WhatsApp.
    // La que va a usar de verdad la escribe él, en su teléfono, y nadie más la ve.
    const user = await client.query(
      `INSERT INTO users (nightclub_id, email, password_hash, first_name, last_name,
                          display_name, role, birth_date, age_verified,
                          must_change_password, terms_version, terms_accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,'manager',$7,true,true,$8,now())
       RETURNING id`,
      [clubId, email, passwordHash, firstName, lastName, fullName, birthDate,
        process.env.TERMS_VERSION || '1.0']);

    await client.query('COMMIT');

    console.log('');
    console.log(clubCreated ? `Club creado:  ${clubName} (${clubSlug})` : `Club existente: ${clubSlug}`);
    console.log(`Gerente:      ${fullName} <${email}>`);
    console.log(`Id:           ${user.rows[0].id}`);
    console.log('');
    if (generated) {
      console.log('  Contraseña temporal (se muestra UNA sola vez):');
      console.log('');
      console.log(`      ${password}`);
      console.log('');
    }
    console.log('  El sistema va a pedir cambiarla en el primer acceso.');
    console.log(`  Pon <meta name="ev2:club" content="${clubSlug}"> en las páginas de web/.`);
    console.log('');
    return 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

bootstrap()
  .then((code) => pool.end().then(() => process.exit(code)))
  .catch(async (err) => {
    console.error(`Arranque fallido: ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
