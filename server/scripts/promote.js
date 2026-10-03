#!/usr/bin/env node
/**
 * EV2 — cambia el rol de una cuenta desde la consola del servidor.
 *
 * Por qué existe
 * --------------
 * `scripts/bootstrap.js` crea al PRIMER gerente y después se cierra solo. Pero el
 * dueño del club no es un gerente: es el administrador, y el rol `admin` no lo puede
 * otorgar ninguna pantalla —si un gerente pudiera nombrarse administrador, el permiso
 * no significaría nada—. Este script es la única puerta, y está donde debe estar: en
 * la consola del servidor, que solo abre quien ya tiene la llave de la máquina.
 *
 * Alternativa que se descartó: un `UPDATE users SET role = 'admin'` a mano en
 * producción. Funciona una vez y no deja rastro. Esto deja el cambio en `audit_log`,
 * se puede repetir igual dentro de seis meses, y se niega a hacer lo que no debe.
 *
 * Qué NO hace
 * -----------
 * No crea cuentas —para eso están `bootstrap` y la pantalla del gerente— ni toca
 * contraseñas, ni da roles de piso (un mesero se da de alta como mesero, no se
 * "promueve"). Solo mueve una cuenta que ya existe entre `manager` y `admin`.
 *
 * Uso
 * ---
 *   npm run promote -- --email dueno@ejemplo.com --role admin
 *   npm run promote -- --email dueno@ejemplo.com --role admin --reason "dueño del club"
 *
 * Con --club <slug> cuando la misma base tiene más de un club y el correo se repite.
 */
'use strict';

require('dotenv').config();
const os = require('os');
const { pool } = require('../src/db/pool');

/** Los dos únicos destinos. Un rol de piso se da de alta, no se promueve. */
const TARGET_ROLES = ['manager', 'admin'];

/**
 * De dónde SÍ se puede promover.
 *
 * Un `guest` es un cliente del club: su cuenta se creó desde la pantalla pública, sin
 * verificación de identidad ni expediente. Convertir una en administrador por un
 * correo mal teclado sería el peor accidente posible de este script, así que se niega
 * y dice qué hacer en su lugar.
 */
const PROMOTABLE_FROM = [
  'waiter', 'bartender', 'dancer', 'dj', 'light_tech', 'valet', 'hostess',
  'driver', 'warehouse', 'manager', 'admin',
];

/** `--email x --role admin` → `{ email: 'x', role: 'admin' }`. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split('=');
    if (inline !== undefined) { out[name] = inline; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[name] = true; continue; }
    out[name] = next;
    i += 1;
  }
  return out;
}

const USAGE = `
Uso:
  npm run promote -- --email <correo> --role <manager|admin> [--club <slug>] [--reason "<texto>"]

Ejemplo:
  npm run promote -- --email dueno@ejemplo.com --role admin --reason "dueño del club"
`;

async function promote(argv) {
  const args = parseArgs(argv);
  const email = String(args.email || '').trim().toLowerCase();
  const role = String(args.role || '').trim();
  const clubSlug = args.club ? String(args.club).trim() : null;
  const reason = args.reason && args.reason !== true ? String(args.reason).trim() : null;

  if (!email || !role) {
    console.error(USAGE.trim());
    return 1;
  }
  if (!TARGET_ROLES.includes(role)) {
    console.error(`--role debe ser uno de: ${TARGET_ROLES.join(', ')}`);
    return 1;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // `FOR UPDATE OF u` y no `FOR UPDATE`: el `LEFT JOIN` con los clubes no se puede
    // bloquear (trampa 3 de CLAUDE.md), y tampoco hace falta.
    const found = await client.query(
      `SELECT u.id, u.role, u.display_name, u.status, u.nightclub_id, c.slug AS club_slug
         FROM users u
         LEFT JOIN nightclubs c ON c.id = u.nightclub_id
        WHERE lower(u.email) = $1
          AND u.status <> 'deleted'
          AND ($2::text IS NULL OR c.slug = $2::text)
        FOR UPDATE OF u`,
      [email, clubSlug]);

    if (found.rowCount === 0) {
      await client.query('ROLLBACK');
      console.error(`No hay ninguna cuenta activa con el correo ${email}`
        + (clubSlug ? ` en el club "${clubSlug}"` : '')
        + '.\nRevisa el correo, o crea la cuenta antes de cambiarle el rol.');
      return 1;
    }
    if (found.rowCount > 1) {
      await client.query('ROLLBACK');
      console.error(`Ese correo existe en ${found.rowCount} clubes `
        + `(${found.rows.map((r) => r.club_slug || 'sin club').join(', ')}).\n`
        + 'Agrega --club <slug> para decir cuál.');
      return 1;
    }

    const user = found.rows[0];

    if (!PROMOTABLE_FROM.includes(user.role)) {
      await client.query('ROLLBACK');
      console.error(`La cuenta ${email} tiene el rol "${user.role}" y no se puede promover.\n`
        + 'Una cuenta de cliente (guest) no se convierte en personal: da de alta a esa '
        + 'persona desde la pantalla del gerente, con su expediente, y promueve esa cuenta.');
      return 1;
    }
    if (user.status !== 'active') {
      await client.query('ROLLBACK');
      console.error(`La cuenta ${email} está en estado "${user.status}". `
        + 'Reactívala antes de cambiarle el rol.');
      return 1;
    }
    if (user.role === role) {
      await client.query('ROLLBACK');
      console.log(`${user.display_name} <${email}> ya tiene el rol "${role}". No se cambió nada.`);
      return 0;
    }

    await client.query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1',
      [user.id, role]);

    // `actor_id` va en NULL a propósito: esto no lo pidió nadie por HTTP, lo corrió
    // alguien con acceso al servidor. Quién fue se guarda como lo que de verdad se
    // sabe —el usuario del sistema y la máquina—, no como una cuenta de la app.
    await client.query(
      `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, before, after)
       VALUES ($1, NULL, 'role_changed_from_console', 'user', $2, $3, $4)`,
      [user.nightclub_id, user.id,
        JSON.stringify({ role: user.role }),
        JSON.stringify({
          role,
          reason,
          operator: `${os.userInfo().username}@${os.hostname()}`,
        })]);

    await client.query('COMMIT');

    console.log('');
    console.log(`Cuenta:  ${user.display_name} <${email}>`);
    console.log(`Club:    ${user.club_slug || '—'}`);
    console.log(`Rol:     ${user.role} → ${role}`);
    console.log('');
    console.log('  El cambio queda en audit_log. La sesión abierta de esa persona sigue');
    console.log('  con el rol viejo hasta que su token caduque (15 min) o vuelva a entrar.');
    console.log('');
    return 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { parseArgs, TARGET_ROLES, PROMOTABLE_FROM, promote };

if (require.main === module) {
  promote(process.argv.slice(2))
    .then((code) => pool.end().then(() => process.exit(code)))
    .catch(async (err) => {
      console.error(`No se pudo cambiar el rol: ${err.message}`);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}
