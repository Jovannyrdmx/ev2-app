/**
 * El arranque de un servidor nuevo: crear el club y su PRIMER gerente.
 *
 * Se prueba con cuidado porque es lo único en todo el sistema que fabrica una cuenta
 * de gerente sin que otro gerente lo autorice. Si algún día deja de negarse cuando ya
 * hay administradores, se convierte en una puerta trasera: cualquiera con acceso a la
 * terminal del servidor se haría gerente del club.
 */
'use strict';

const path = require('path');
const { execFile } = require('child_process');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'bootstrap.js');

/** Corre el script como lo haría el dueño en el servidor, con su propio entorno. */
function run(env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], {
      env: { ...process.env, ...env },
      cwd: path.join(__dirname, '..'),
    }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

const BASE = {
  CLUB_NAME: 'Club Arranque',
  CLUB_SLUG: 'club-arranque',
  MANAGER_EMAIL: 'dueno@arranque.test',
  MANAGER_NAME: 'Ana María Ruiz',
  MANAGER_BIRTH_DATE: '1985-04-23',
};

const clubRow = () => pool.query('SELECT id, name, slug, currency_default, timezone FROM nightclubs WHERE slug = $1', [BASE.CLUB_SLUG]);
const managers = (clubId) => pool.query(
  "SELECT id, email, role, must_change_password, age_verified, display_name, first_name, last_name FROM users WHERE nightclub_id = $1 AND role IN ('manager','admin')",
  [clubId]);

describe('Arranque de un servidor nuevo', () => {
  beforeAll(setupSchema);
  afterAll(closePool);
  beforeEach(truncateAll);

  it('crea el club y un gerente que puede administrarlo', async () => {
    const r = await run(BASE);
    expect(r.code).toBe(0);

    const club = await clubRow();
    expect(club.rowCount).toBe(1);
    expect(club.rows[0].name).toBe('Club Arranque');

    const staff = await managers(club.rows[0].id);
    expect(staff.rowCount).toBe(1);
    expect(staff.rows[0].role).toBe('manager');
  });

  it('la contraseña se genera y se imprime UNA vez, legible para dictarla', async () => {
    const r = await run(BASE);
    // Cuatro trozos separados por guiones: se teclea en un celular a oscuras sin
    // deletrear. Una cadena en base64 acaba apuntada en un papel junto a la caja.
    const match = r.stdout.match(/^\s+([a-z]+-[a-z]+-[a-z]+-\d{4})\s*$/m);
    expect(match).not.toBeNull();
    expect(r.stdout).toMatch(/UNA sola vez/);
  });

  it('el gerente nace obligado a cambiar la contraseña', async () => {
    // La temporal pasó por una terminal, por el historial del shell y quizá por
    // WhatsApp. La que se usa de verdad la escribe él y nadie más la ve.
    await run(BASE);
    const club = await clubRow();
    const staff = await managers(club.rows[0].id);
    expect(staff.rows[0].must_change_password).toBe(true);
  });

  it('SE NIEGA a correr si el club ya tiene un gerente', async () => {
    // Esta es la prueba que evita que el arranque se vuelva una puerta trasera.
    const first = await run(BASE);
    expect(first.code).toBe(0);

    const second = await run({ ...BASE, MANAGER_EMAIL: 'colado@arranque.test', MANAGER_NAME: 'Otro Nombre' });
    expect(second.code).toBe(1);
    expect(second.stderr).toMatch(/ya tiene/i);

    const club = await clubRow();
    const staff = await managers(club.rows[0].id);
    expect(staff.rowCount).toBe(1);
    expect(staff.rows[0].email).toBe(BASE.MANAGER_EMAIL);
  });

  it('tampoco se cuela un administrador cuando ya hay uno', async () => {
    await run(BASE);
    const club = await clubRow();
    await pool.query("UPDATE users SET role = 'admin' WHERE nightclub_id = $1", [club.rows[0].id]);

    const again = await run({ ...BASE, MANAGER_EMAIL: 'otro@arranque.test' });
    expect(again.code).toBe(1);
    expect((await managers(club.rows[0].id)).rowCount).toBe(1);
  });

  it('no crea mesas, tragos ni personal de ejemplo', async () => {
    // Es un arranque, no un seed: en un servidor de producción no debe aparecer
    // ni un solo dato inventado.
    await run(BASE);
    const club = await clubRow();
    const id = club.rows[0].id;
    for (const table of ['tables', 'drinks', 'drink_orders', 'reservations']) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE nightclub_id = $1`, [id]);
      expect(rows[0].n).toBe(0);
    }
    const others = await pool.query(
      "SELECT count(*)::int AS n FROM users WHERE nightclub_id = $1 AND role NOT IN ('manager','admin')", [id]);
    expect(others.rows[0].n).toBe(0);
  });

  it('vuelto a correr sobre un club existente NO lo duplica', async () => {
    await run(BASE);
    await pool.query("DELETE FROM users WHERE nightclub_id = (SELECT id FROM nightclubs WHERE slug = $1)", [BASE.CLUB_SLUG]);
    const again = await run(BASE);
    expect(again.code).toBe(0);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM nightclubs WHERE slug = $1', [BASE.CLUB_SLUG]);
    expect(rows[0].n).toBe(1);
  });

  it('acepta una contraseña puesta a mano, pero no una corta', async () => {
    const corta = await run({ ...BASE, MANAGER_PASSWORD: 'corta123' });
    expect(corta.code).toBe(1);
    expect(corta.stderr).toMatch(/al menos 12/);
    expect((await clubRow()).rowCount).toBe(0);

    const buena = await run({ ...BASE, MANAGER_PASSWORD: 'una-contrasena-bien-larga' });
    expect(buena.code).toBe(0);
    // Si la eligió el dueño, no se le imprime de vuelta: ya la tiene.
    expect(buena.stdout).not.toMatch(/una-contrasena-bien-larga/);
  });

  it('pide los datos que faltan por su nombre', async () => {
    for (const missing of ['CLUB_NAME', 'MANAGER_EMAIL', 'MANAGER_NAME', 'MANAGER_BIRTH_DATE']) {
      const env = { ...BASE };
      delete env[missing];
      const r = await run({ ...env, [missing]: '' });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(missing);
    }
  });

  it('rechaza una fecha de nacimiento mal escrita en vez de guardar basura', async () => {
    const r = await run({ ...BASE, MANAGER_BIRTH_DATE: '23/04/1985' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/AAAA-MM-DD/);
  });

  it('el slug se limpia: sin acentos, sin espacios, sin mayúsculas', async () => {
    await run({ ...BASE, CLUB_SLUG: '', CLUB_NAME: 'Antro Ñandú  Café' });
    const { rows } = await pool.query('SELECT slug FROM nightclubs ORDER BY created_at DESC LIMIT 1');
    expect(rows[0].slug).toBe('antro-nandu-cafe');
  });

  it('el correo se guarda en minúsculas, venga como venga', async () => {
    await run({ ...BASE, MANAGER_EMAIL: 'DUENO@Arranque.TEST' });
    const club = await clubRow();
    const staff = await managers(club.rows[0].id);
    expect(staff.rows[0].email).toBe('dueno@arranque.test');
  });

  it('el nombre completo se parte en nombre y apellidos', async () => {
    await run(BASE);
    const club = await clubRow();
    const staff = await managers(club.rows[0].id);
    expect(staff.rows[0].first_name).toBe('Ana');
    expect(staff.rows[0].last_name).toBe('María Ruiz');
    expect(staff.rows[0].display_name).toBe('Ana María Ruiz');
  });

  it('respeta la moneda y la zona horaria que se le pasen', async () => {
    await run({ ...BASE, CLUB_CURRENCY: 'USD', CLUB_TIMEZONE: 'America/Tijuana', CLUB_CITY: 'Tijuana' });
    const club = await clubRow();
    expect(club.rows[0].currency_default).toBe('USD');
    expect(club.rows[0].timezone).toBe('America/Tijuana');
  });
});
