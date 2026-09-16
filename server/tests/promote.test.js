/**
 * `npm run promote`: el único camino para que una cuenta llegue a `admin`.
 *
 * Se prueba con el mismo cuidado que `bootstrap`, y por la misma razón: es lo único en
 * todo el sistema que otorga el rol más alto sin que nadie lo autorice por HTTP. Si
 * algún día deja de negarse con una cuenta de cliente, un correo mal teclado convierte
 * a un invitado en administrador del club.
 */
'use strict';

const path = require('path');
const { execFile } = require('child_process');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const f = require('./helpers/factories');
const { parseArgs, TARGET_ROLES } = require('../scripts/promote');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'promote.js');

/** Corre el script como lo haría el dueño en la consola del servidor. */
function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env },
      cwd: path.join(__dirname, '..'),
    }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

const roleOf = async (id) => (await pool.query('SELECT role FROM users WHERE id = $1', [id])).rows[0].role;
const auditFor = (id) => pool.query(
  `SELECT actor_id, before, after FROM audit_log
    WHERE action = 'role_changed_from_console' AND entity_id = $1`, [id]);

describe('Lectura de los argumentos', () => {
  it('acepta las dos formas de escribirlos', () => {
    expect(parseArgs(['--email', 'a@b.c', '--role', 'admin']))
      .toEqual({ email: 'a@b.c', role: 'admin' });
    expect(parseArgs(['--email=a@b.c', '--role=admin']))
      .toEqual({ email: 'a@b.c', role: 'admin' });
  });

  it('una bandera sin valor no se come la siguiente', () => {
    expect(parseArgs(['--reason', '--role', 'admin']))
      .toEqual({ reason: true, role: 'admin' });
  });

  it('solo hay dos destinos posibles', () => {
    expect(TARGET_ROLES).toEqual(['manager', 'admin']);
  });
});

describe('Cambio de rol desde la consola', () => {
  let club; let manager; let guest; let waiter;

  beforeAll(setupSchema);
  afterAll(closePool);

  beforeEach(async () => {
    await truncateAll();
    club = await f.createNightclub({ slug: 'ev2-promote' });
    manager = await f.createUser(club.id, { role: 'manager', email: 'ger@promote.test', display_name: 'Ana Ruiz' });
    guest = await f.createUser(club.id, { role: 'guest', email: 'cliente@promote.test' });
    waiter = await f.createUser(club.id, { role: 'waiter', email: 'mesero@promote.test' });
  });

  it('sube al gerente a administrador y lo deja en audit_log', async () => {
    const res = await run(['--email', 'ger@promote.test', '--role', 'admin', '--reason', 'dueño del club']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('manager → admin');
    expect(await roleOf(manager.id)).toBe('admin');

    const { rows } = await auditFor(manager.id);
    expect(rows).toHaveLength(1);
    // Nadie lo pidió por HTTP: el actor de la app es NULL a propósito, y quién lo
    // corrió se guarda como lo que de verdad se sabe.
    expect(rows[0].actor_id).toBeNull();
    expect(rows[0].before).toEqual({ role: 'manager' });
    expect(rows[0].after).toMatchObject({ role: 'admin', reason: 'dueño del club' });
    expect(rows[0].after.operator).toMatch(/.+@.+/);
  });

  it('también sirve para nombrar gerente a alguien de piso', async () => {
    expect((await run(['--email', 'mesero@promote.test', '--role', 'manager'])).code).toBe(0);
    expect(await roleOf(waiter.id)).toBe('manager');
  });

  it('se niega con una cuenta de cliente y explica qué hacer', async () => {
    const res = await run(['--email', 'cliente@promote.test', '--role', 'admin']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('guest');
    expect(await roleOf(guest.id)).toBe('guest');
    expect((await auditFor(guest.id)).rows).toHaveLength(0);
  });

  it('se niega si el correo no existe, sin tocar nada', async () => {
    const res = await run(['--email', 'nadie@promote.test', '--role', 'admin']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('nadie@promote.test');
  });

  it('se niega con un rol que no es manager ni admin', async () => {
    for (const role of ['waiter', 'guest', 'root', '']) {
      const res = await run(['--email', 'ger@promote.test', '--role', role]);
      expect(res.code).toBe(1);
    }
    expect(await roleOf(manager.id)).toBe('manager');
  });

  it('sin argumentos imprime el uso y no hace nada', async () => {
    const res = await run([]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('--email');
    expect(await roleOf(manager.id)).toBe('manager');
  });

  it('no repite el cambio ni el registro si ya tiene el rol', async () => {
    expect((await run(['--email', 'ger@promote.test', '--role', 'admin'])).code).toBe(0);
    const otra = await run(['--email', 'ger@promote.test', '--role', 'admin']);
    expect(otra.code).toBe(0);
    expect(otra.stdout).toContain('ya tiene el rol');
    expect((await auditFor(manager.id)).rows).toHaveLength(1);
  });

  it('se niega con una cuenta bloqueada', async () => {
    await pool.query("UPDATE users SET status = 'blocked' WHERE id = $1", [waiter.id]);
    const res = await run(['--email', 'mesero@promote.test', '--role', 'manager']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('blocked');
    expect(await roleOf(waiter.id)).toBe('waiter');
  });

  it('con el mismo correo en dos clubes pide --club y no adivina', async () => {
    const otro = await f.createNightclub({ slug: 'ev2-promote-2' });
    const gemelo = await f.createUser(otro.id, { role: 'manager', email: 'ger@promote.test' });

    const ambiguo = await run(['--email', 'ger@promote.test', '--role', 'admin']);
    expect(ambiguo.code).toBe(1);
    expect(ambiguo.stderr).toContain('--club');
    expect(await roleOf(manager.id)).toBe('manager');
    expect(await roleOf(gemelo.id)).toBe('manager');

    const claro = await run(['--email', 'ger@promote.test', '--role', 'admin', '--club', 'ev2-promote-2']);
    expect(claro.code).toBe(0);
    expect(await roleOf(gemelo.id)).toBe('admin');
    expect(await roleOf(manager.id)).toBe('manager');
  });
});
