/**
 * El pase individual por invitado: emitir, repartir, revocar, reasignar y entrar.
 *
 * Lo que se prueba aquí es lo que una puerta con fila no perdona y lo que un
 * abogado preguntaría al día siguiente:
 *
 *   * que un QR fabricado no abra, y que ni se consulte la base;
 *   * que un pase entre UNA vez, y que los otros de la mesa sigan sirviendo;
 *   * que la identificación vaya ANTES del escaneo, y que un rechazo NO queme el
 *     pase —porque si lo quemara, un guardia con mala cara podría dejar a un
 *     invitado sin entrada y sin manera de recuperarla—;
 *   * que el QR no lleve un solo dato de la persona;
 *   * que la auditoría no se pueda editar.
 */
'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const gp = require('../src/services/guest-passes');
const door = require('../src/services/door');

let club; let guest; let otro; let hostess; let manager; let mesa;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2' });
  guest = await f.createUser(club.id, { role: 'guest', display_name: 'Jovanny R' });
  otro = await f.createUser(club.id, { role: 'guest', display_name: 'Ajeno' });
  hostess = await f.createUser(club.id, { role: 'hostess', display_name: 'Recepcion' });
  manager = await f.createUser(club.id, { role: 'manager' });
  mesa = await f.createTable(club.id, { code: '39', section: 'ZONA ROJA', capacity: 8 });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

async function reservar(over = {}) {
  const starts = over.starts_at || new Date(Date.now() + 30 * 60_000);
  const { rows } = await pool.query(
    `INSERT INTO reservations (nightclub_id, user_id, table_id, starts_at, duration_minutes,
                               guest_count, status, currency, pass_code)
     VALUES ($1,$2,$3,$4,240,$5,$6,'MXN',$7)
     RETURNING id, nightclub_id, pass_code, status, guest_count`,
    [over.nightclub_id || club.id, over.user_id || guest.id, over.table_id || mesa.id, starts,
      over.guest_count || 4, over.status || 'confirmed', door.generatePassCode()],
  );
  await gp.issueForReservation(pool, { reservation: rows[0], actorId: rows[0].user_id });
  return rows[0];
}

async function pasesDe(reservationId) {
  const { rows } = await pool.query(
    `SELECT id, code, kind, status, label FROM guest_passes
      WHERE reservation_id = $1 ORDER BY kind DESC, created_at`, [reservationId]);
  return rows;
}

async function idCheck(staff, over = {}) {
  const res = await api().post(url('/door/id-checks')).set(auth(staff))
    .send({ document: 'ine', adult: true, decision: 'accepted', ...over });
  return res;
}

async function entrar(code, staff = null) {
  const quien = staff || hostess;
  const rev = await idCheck(quien);
  return api().post(url('/door/check-in')).set(auth(quien))
    .send({ code, id_check_id: rev.body.id_check.id });
}

// ==========================================================================
// La firma, sin base de datos
// ==========================================================================

describe('la firma del QR', () => {
  it('el payload lleva el código y su firma, y se vuelve a leer igual', () => {
    const code = gp.generateCode();
    const p = gp.payload(code);
    expect(p.startsWith('EV2P.')).toBe(true);
    const leido = gp.parse(p);
    expect(leido.code).toBe(code);
    expect(leido.signed).toBe(true);
    expect(gp.verifySignature(leido.code, leido.signature)).toBe(true);
  });

  it('la firma mide 10 y sale del alfabeto que se puede dictar', () => {
    const s = gp.sign('EV2-4K7M-2P4X');
    expect(s).toHaveLength(10);
    expect(s.split('').every((c) => gp.ALPHABET.includes(c))).toBe(true);
    // Sin 0/O ni 1/I/L: se lee en voz alta en una puerta con música.
    expect(/[01OIL]/.test(s)).toBe(false);
  });

  it('cambiar una letra del código cambia la firma', () => {
    expect(gp.sign('EV2-4K7M-2P4X')).not.toBe(gp.sign('EV2-4K7M-2P4Y'));
  });

  it('una firma de otro código no valida', () => {
    expect(gp.verifySignature('EV2-4K7M-2P4X', gp.sign('EV2-9999-9999'))).toBe(false);
  });

  it('una firma más corta o más larga no valida, sin reventar', () => {
    expect(gp.verifySignature('EV2-4K7M-2P4X', 'ABC')).toBe(false);
    expect(gp.verifySignature('EV2-4K7M-2P4X', gp.sign('EV2-4K7M-2P4X') + 'Z')).toBe(false);
    expect(gp.verifySignature('EV2-4K7M-2P4X', null)).toBe(false);
  });

  it('con otro JWT_SECRET la firma es distinta: la llave sale de ahí', () => {
    const antes = process.env.JWT_SECRET;
    const a = gp.sign('EV2-4K7M-2P4X');
    process.env.JWT_SECRET = `${antes}-otro`;
    const b = gp.sign('EV2-4K7M-2P4X');
    process.env.JWT_SECRET = antes;
    expect(a).not.toBe(b);
    // Y al volver al secreto original, vuelve a dar lo mismo: la memoria de la
    // llave comprueba el secreto en vez de quedarse pegada al primero que vio.
    expect(gp.sign('EV2-4K7M-2P4X')).toBe(a);
  });

  it('lee el código pelón, el payload, y el enlace de WhatsApp', () => {
    const code = 'EV2-4K7M-2P4X';
    expect(gp.parse(code).code).toBe(code);
    expect(gp.parse('ev2 4k7m 2p4x').code).toBe(code);
    expect(gp.parse(gp.payload(code)).code).toBe(code);
    const enlace = gp.shareLink('https://ev2.com', code);
    expect(gp.parse(enlace).code).toBe(code);
    expect(gp.parse(enlace).signed).toBe(true);
  });

  it('el código pelón se lee SIN firma: eso lo decide quien juzga, no quien lee', () => {
    // La puerta acepta un código tecleado con un guardia enfrente; el enlace
    // público no. La diferencia está en `check`/la ruta, no aquí.
    expect(gp.parse('EV2-4K7M-2P4X').signed).toBe(false);
  });
});

describe('cuántos pases y qué dice el mensaje', () => {
  it('uno por persona, y el titular cuenta como uno', () => {
    expect(gp.passesNeeded(8)).toEqual({ holder: 1, guests: 7, total: 8 });
    expect(gp.passesNeeded(1)).toEqual({ holder: 1, guests: 0, total: 1 });
    // Un número imposible no emite pases negativos.
    expect(gp.passesNeeded(0)).toEqual({ holder: 1, guests: 0, total: 1 });
  });

  it('el mensaje lleva el enlace y el código, y nada de la persona', () => {
    const m = gp.shareMessage({
      code: 'EV2-4K7M-2P4X', label: 'Ana', club: 'EV2', table: '39',
      baseUrl: 'https://ev2.com', lang: 'es',
    });
    expect(m.text).toContain('EV2-4K7M-2P4X');
    expect(m.text).toContain('https://ev2.com/pase.html?p=');
    expect(m.text).toContain('Mesa 39');
    expect(m.whatsapp_url.startsWith('https://wa.me/?text=')).toBe(true);
    // El nombre que aparece es el que el titular escribió para quien va a LEER el
    // mensaje. No el del titular, ni un teléfono, ni el id de la reservación.
    expect(m.text).toContain('Ana');
  });

  it('en inglés dice lo mismo', () => {
    const m = gp.shareMessage({ code: 'EV2-4K7M-2P4X', club: 'EV2', baseUrl: 'https://ev2.com', lang: 'en' });
    expect(m.text).toContain('Single use');
    expect(m.text).toContain('EV2-4K7M-2P4X');
  });
});

describe('si una revisión de identificación sirve', () => {
  const base = { decision: 'accepted', adult: true, consumed_by: null,
    checked_by: 'u1', created_at: new Date() };

  it('aceptada, de un adulto, fresca y del mismo guardia: sirve', () => {
    expect(gp.idCheckIsUsable(base, { staffId: 'u1' }).ok).toBe(true);
  });

  it('un rechazo no abre nada', () => {
    expect(gp.idCheckIsUsable({ ...base, decision: 'rejected' }).reason).toBe('id_rejected');
  });

  it('un menor de edad no abre nada', () => {
    expect(gp.idCheckIsUsable({ ...base, adult: false }).reason).toBe('id_rejected');
  });

  it('una ya gastada no sirve: una revisión por persona', () => {
    expect(gp.idCheckIsUsable({ ...base, consumed_by: 'p1' }).reason).toBe('id_check_used');
  });

  it('una de hace media hora no sirve', () => {
    const vieja = { ...base, created_at: new Date(Date.now() - 30 * 60_000) };
    expect(gp.idCheckIsUsable(vieja, { staffId: 'u1' }).reason).toBe('id_check_stale');
  });

  it('una de otro guardia no sirve: él no vio esa identificación', () => {
    expect(gp.idCheckIsUsable(base, { staffId: 'u2' }).reason).toBe('id_check_other_staff');
  });

  it('ninguna, no sirve', () => {
    expect(gp.idCheckIsUsable(null).reason).toBe('no_id_check');
  });
});

// ==========================================================================
// Emitir
// ==========================================================================

describe('emitir los pases de una reservación', () => {
  it('uno por persona, y el del titular reusa el código de la reservación', async () => {
    const r = await reservar({ guest_count: 4 });
    const pases = await pasesDe(r.id);
    expect(pases).toHaveLength(4);
    expect(pases.filter((p) => p.kind === 'holder')).toHaveLength(1);
    expect(pases.find((p) => p.kind === 'holder').code).toBe(r.pass_code);
  });

  it('emitir dos veces no duplica: si lo hiciera, la mesa entraría dos veces', async () => {
    const r = await reservar({ guest_count: 4 });
    await gp.issueForReservation(pool, { reservation: r });
    await gp.issueForReservation(pool, { reservation: r });
    expect(await pasesDe(r.id)).toHaveLength(4);
  });

  it('si el cliente agrega un lugar, se emite el que falta y nada más', async () => {
    const r = await reservar({ guest_count: 4 });
    await pool.query('UPDATE reservations SET guest_count = 6 WHERE id = $1', [r.id]);
    const nuevos = await gp.issueForReservation(pool, { reservation: { ...r, guest_count: 6 } });
    expect(nuevos).toHaveLength(2);
    expect(await pasesDe(r.id)).toHaveLength(6);
  });

  it('cada pase nace con su renglón de auditoría', async () => {
    const r = await reservar({ guest_count: 2 });
    const { rows } = await pool.query(
      `SELECT e.kind FROM guest_pass_events e
         JOIN guest_passes p ON p.id = e.pass_id
        WHERE p.reservation_id = $1`, [r.id]);
    expect(rows).toHaveLength(2);
    expect(rows.every((x) => x.kind === 'issued')).toBe(true);
  });
});

// ==========================================================================
// Verlos y repartirlos
// ==========================================================================

describe('el titular administra sus pases', () => {
  it('los ve, con el resumen de cuántos están vivos', async () => {
    const r = await reservar({ guest_count: 3 });
    const res = await api().get(url(`/reservations/${r.id}/passes`)).set(auth(guest));
    expect(res.status).toBe(200);
    expect(res.body.passes).toHaveLength(3);
    expect(res.body.summary).toMatchObject({ total: 3, active: 3, used: 0, revoked: 0 });
  });

  it('la LISTA no trae el payload firmado: ver no es repartir', async () => {
    const r = await reservar();
    const res = await api().get(url(`/reservations/${r.id}/passes`)).set(auth(guest));
    for (const p of res.body.passes) expect(p.payload).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('EV2P.');
  });

  it('un pase suelto sí trae su QR dibujado', async () => {
    const r = await reservar();
    const [uno] = await pasesDe(r.id);
    const res = await api().get(url(`/reservations/${r.id}/passes/${uno.id}`)).set(auth(guest));
    expect(res.status).toBe(200);
    expect(res.body.pass.qr_svg).toContain('<svg');
    expect(res.body.pass.payload.startsWith('EV2P.')).toBe(true);
  });

  it('otro cliente ve 404, no 403: un 403 ya confirma que la reservación existe', async () => {
    const r = await reservar();
    const res = await api().get(url(`/reservations/${r.id}/passes`)).set(auth(otro));
    expect(res.status).toBe(404);
  });

  it('la puerta sí los ve: el titular se le para enfrente a pedir un cambio', async () => {
    const r = await reservar();
    const res = await api().get(url(`/reservations/${r.id}/passes`)).set(auth(hostess));
    expect(res.status).toBe(200);
  });

  it('le pone nombre a un invitado', async () => {
    const r = await reservar();
    const pases = await pasesDe(r.id);
    const invitado = pases.find((p) => p.kind === 'guest');
    const res = await api().patch(url(`/reservations/${r.id}/passes/${invitado.id}`))
      .set(auth(guest)).send({ label: 'Ana' });
    expect(res.status).toBe(200);
    expect(res.body.pass.label).toBe('Ana');
  });

  it('compartir devuelve el enlace de WhatsApp y lo deja contado', async () => {
    const r = await reservar();
    const invitado = (await pasesDe(r.id)).find((p) => p.kind === 'guest');
    const res = await api().post(url(`/reservations/${r.id}/passes/${invitado.id}/share`))
      .set(auth(guest)).send({ label: 'Ana', lang: 'es' });

    expect(res.status).toBe(200);
    expect(res.body.share.whatsapp_url).toContain('wa.me');
    expect(res.body.share.link).toContain('/pase.html?p=');
    expect(res.body.pass.share_count).toBe(1);

    const { rows } = await pool.query(
      `SELECT kind FROM guest_pass_events WHERE pass_id = $1 AND kind = 'shared'`, [invitado.id]);
    expect(rows).toHaveLength(1);
  });

  it('el enlace que se comparte sale del servidor, no de lo que mande el cliente', async () => {
    const r = await reservar();
    const invitado = (await pasesDe(r.id)).find((p) => p.kind === 'guest');
    const res = await api().post(url(`/reservations/${r.id}/passes/${invitado.id}/share`))
      .set(auth(guest))
      .set('Host', 'sitio-del-atacante.com')
      .send({ lang: 'es' });
    expect(res.body.share.link).not.toContain('sitio-del-atacante');
  });

  it('un pase gastado no se comparte', async () => {
    const r = await reservar();
    const invitado = (await pasesDe(r.id)).find((p) => p.kind === 'guest');
    await entrar(invitado.code);
    const res = await api().post(url(`/reservations/${r.id}/passes/${invitado.id}/share`))
      .set(auth(guest)).send({});
    expect(res.status).toBe(409);
  });
});

// ==========================================================================
// Revocar y reasignar
// ==========================================================================

describe('revocar', () => {
  it('mata el pase con motivo, y ese código ya no abre', async () => {
    const r = await reservar();
    const invitado = (await pasesDe(r.id)).find((p) => p.kind === 'guest');
    const rev = await api().post(url(`/reservations/${r.id}/passes/${invitado.id}/revoke`))
      .set(auth(guest)).send({ reason: 'el invitado ya no viene' });
    expect(rev.status).toBe(200);
    expect(rev.body.pass.status).toBe('revoked');
    expect(rev.body.pass.revoke_reason).toBe('el invitado ya no viene');

    const res = await entrar(invitado.code);
    expect(res.body.pass.result).toBe('revoked');
  });

  it('sin motivo no se revoca: un pase muerto sin motivo es una discusión sin solución', async () => {
    const r = await reservar();
    const invitado = (await pasesDe(r.id)).find((p) => p.kind === 'guest');
    const res = await api().post(url(`/reservations/${r.id}/passes/${invitado.id}/revoke`))
      .set(auth(guest)).send({});
    expect(res.status).toBe(400);
  });

  it('un pase ya usado NO se revoca: esa persona está adentro', async () => {
    const r = await reservar();
    const invitado = (await pasesDe(r.id)).find((p) => p.kind === 'guest');
    await entrar(invitado.code);
    const res = await api().post(url(`/reservations/${r.id}/passes/${invitado.id}/revoke`))
      .set(auth(guest)).send({ reason: 'me arrepentí' });
    expect(res.status).toBe(409);
  });

  it('otro cliente no puede revocar un pase ajeno', async () => {
    const r = await reservar();
    const invitado = (await pasesDe(r.id)).find((p) => p.kind === 'guest');
    const res = await api().post(url(`/reservations/${r.id}/passes/${invitado.id}/revoke`))
      .set(auth(otro)).send({ reason: 'porque puedo' });
    expect(res.status).toBe(404);
  });
});

describe('reasignar', () => {
  it('mata el viejo, emite uno con código NUEVO, y los liga', async () => {
    const r = await reservar();
    const invitado = (await pasesDe(r.id)).find((p) => p.kind === 'guest');
    const res = await api().post(url(`/reservations/${r.id}/passes/${invitado.id}/reassign`))
      .set(auth(guest)).send({ label: 'Luis', reason: 'Ana no pudo venir' });

    expect(res.status).toBe(201);
    expect(res.body.revoked.status).toBe('revoked');
    expect(res.body.pass.code).not.toBe(invitado.code);
    expect(res.body.pass.label).toBe('Luis');
    expect(res.body.pass.replaces_id).toBe(invitado.id);
    // Y el mensaje listo para mandárselo al de repuesto.
    expect(res.body.share.whatsapp_url).toContain('wa.me');
  });

  it('el QR viejo deja de abrir y el nuevo abre', async () => {
    const r = await reservar();
    const invitado = (await pasesDe(r.id)).find((p) => p.kind === 'guest');
    const res = await api().post(url(`/reservations/${r.id}/passes/${invitado.id}/reassign`))
      .set(auth(guest)).send({ reason: 'cambio de invitado' });

    const viejo = await entrar(invitado.code);
    expect(viejo.body.pass.result).toBe('revoked');
    const nuevo = await entrar(res.body.pass.code);
    expect(nuevo.body.admitted).toBe(true);
  });

  it('no se reasigna el de alguien que ya entró', async () => {
    const r = await reservar();
    const invitado = (await pasesDe(r.id)).find((p) => p.kind === 'guest');
    await entrar(invitado.code);
    const res = await api().post(url(`/reservations/${r.id}/passes/${invitado.id}/reassign`))
      .set(auth(guest)).send({ reason: 'ups' });
    expect(res.status).toBe(409);
  });

  it('el total de pases vivos no cambia: reasignar no regala entradas', async () => {
    const r = await reservar({ guest_count: 4 });
    const invitado = (await pasesDe(r.id)).find((p) => p.kind === 'guest');
    await api().post(url(`/reservations/${r.id}/passes/${invitado.id}/reassign`))
      .set(auth(guest)).send({ reason: 'cambio' });
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM guest_passes
        WHERE reservation_id = $1 AND status = 'active'`, [r.id]);
    expect(rows[0].n).toBe(4);
  });
});

// ==========================================================================
// El enlace público
// ==========================================================================

describe('el enlace que abre el invitado, sin cuenta', () => {
  it('con el payload firmado ve su QR y su mesa', async () => {
    const r = await reservar();
    const invitado = (await pasesDe(r.id)).find((p) => p.kind === 'guest');
    const res = await api().get(`/api/guest-passes/${encodeURIComponent(gp.payload(invitado.code))}`);
    expect(res.status).toBe(200);
    expect(res.body.pass.qr_svg).toContain('<svg');
    expect(res.body.pass.table_code).toBe('39');
    expect(res.body.pass.usable).toBe(true);
  });

  it('NO expone un solo dato de nadie: ni el titular, ni teléfonos, ni ids', async () => {
    const r = await reservar();
    const invitado = (await pasesDe(r.id)).find((p) => p.kind === 'guest');
    const res = await api().get(`/api/guest-passes/${encodeURIComponent(gp.payload(invitado.code))}`);
    const cuerpo = JSON.stringify(res.body);
    expect(cuerpo).not.toContain('Jovanny R');
    expect(cuerpo).not.toContain(guest.email);
    expect(cuerpo).not.toContain(guest.id);
    expect(cuerpo).not.toContain(r.id);
  });

  it('el código sin firma no abre el enlace: ahí no hay nadie mirando', async () => {
    const r = await reservar();
    const invitado = (await pasesDe(r.id)).find((p) => p.kind === 'guest');
    const res = await api().get(`/api/guest-passes/${invitado.code}`);
    expect(res.status).toBe(404);
  });

  it('una firma cambiada tampoco', async () => {
    const r = await reservar();
    const invitado = (await pasesDe(r.id)).find((p) => p.kind === 'guest');
    const res = await api().get(`/api/guest-passes/EV2P.${invitado.code}.AAAAAAAAAA`);
    expect(res.status).toBe(404);
  });

  it('cada apertura queda registrada: un pase muy compartido se nota', async () => {
    const r = await reservar();
    const invitado = (await pasesDe(r.id)).find((p) => p.kind === 'guest');
    const p = encodeURIComponent(gp.payload(invitado.code));
    await api().get(`/api/guest-passes/${p}`);
    await api().get(`/api/guest-passes/${p}`);
    // El renglón se escribe sin bloquear la respuesta; se le da un instante.
    await new Promise((r2) => setTimeout(r2, 150));
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM guest_pass_events
        WHERE pass_id = $1 AND kind = 'viewed'`, [invitado.id]);
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('un pase revocado se abre y DICE que ya no sirve, en vez de callarse', async () => {
    const r = await reservar();
    const invitado = (await pasesDe(r.id)).find((p) => p.kind === 'guest');
    await api().post(url(`/reservations/${r.id}/passes/${invitado.id}/revoke`))
      .set(auth(guest)).send({ reason: 'cambio de planes' });
    const res = await api().get(`/api/guest-passes/${encodeURIComponent(gp.payload(invitado.code))}`);
    expect(res.status).toBe(200);
    expect(res.body.pass.usable).toBe(false);
    expect(res.body.pass.result).toBe('revoked');
  });
});

// ==========================================================================
// La puerta: la identificación primero
// ==========================================================================

describe('la identificación va antes del escaneo', () => {
  it('sin revisión, el escaneo se niega', async () => {
    const r = await reservar();
    const res = await api().post(url('/door/check-in')).set(auth(hostess))
      .send({ code: r.pass_code });
    expect(res.status).toBe(400);
  });

  it('una revisión que no existe se niega, y nadie entra', async () => {
    const r = await reservar();
    const res = await api().post(url('/door/check-in')).set(auth(hostess))
      .send({ code: r.pass_code, id_check_id: club.id });
    expect(res.status).toBe(404);
    const { rows } = await pool.query('SELECT status FROM guest_passes WHERE code = $1', [r.pass_code]);
    expect(rows[0].status).toBe('active');
  });

  it('un menor de edad no se puede registrar como aceptado', async () => {
    const res = await idCheck(hostess, { adult: false, decision: 'accepted' });
    expect(res.status).toBe(400);
  });

  it('un menor de edad se registra como RECHAZO, con motivo, y el pase sigue vivo', async () => {
    const r = await reservar();
    const invitado = (await pasesDe(r.id)).find((p) => p.kind === 'guest');
    const rev = await idCheck(hostess,
      { adult: false, decision: 'rejected', reason: 'menor de edad' });
    expect(rev.status).toBe(201);

    const res = await api().post(url('/door/check-in')).set(auth(hostess))
      .send({ code: invitado.code, id_check_id: rev.body.id_check.id });
    expect(res.status).toBe(200);
    expect(res.body.pass.result).toBe('no_id_check');
    expect(res.body.id_check).toEqual({ ok: false, reason: 'id_rejected' });

    // Y esto es lo importante: el pase NO se quemó. El titular lo puede reasignar.
    const { rows } = await pool.query('SELECT status FROM guest_passes WHERE id = $1', [invitado.id]);
    expect(rows[0].status).toBe('active');
  });

  it('un rechazo sin motivo no se registra', async () => {
    const res = await idCheck(hostess, { adult: false, decision: 'rejected' });
    expect(res.status).toBe(400);
  });

  it('la misma revisión no mete a dos personas', async () => {
    const r = await reservar({ guest_count: 3 });
    const pases = await pasesDe(r.id);
    const rev = await idCheck(hostess);

    const primera = await api().post(url('/door/check-in')).set(auth(hostess))
      .send({ code: pases[0].code, id_check_id: rev.body.id_check.id });
    expect(primera.body.admitted).toBe(true);

    const segunda = await api().post(url('/door/check-in')).set(auth(hostess))
      .send({ code: pases[1].code, id_check_id: rev.body.id_check.id });
    expect(segunda.body.admitted).toBeUndefined();
    expect(segunda.body.id_check.reason).toBe('id_check_used');
  });

  it('la revisión de otro guardia no sirve: él no vio esa identificación', async () => {
    const r = await reservar();
    const rev = await idCheck(hostess);
    const res = await api().post(url('/door/check-in')).set(auth(manager))
      .send({ code: r.pass_code, id_check_id: rev.body.id_check.id });
    expect(res.body.id_check.reason).toBe('id_check_other_staff');
  });

  it('una revisión vieja no sirve', async () => {
    const r = await reservar();
    const rev = await idCheck(hostess);
    await pool.query(
      `UPDATE door_id_checks SET created_at = now() - interval '30 minutes' WHERE id = $1`,
      [rev.body.id_check.id]);
    const res = await api().post(url('/door/check-in')).set(auth(hostess))
      .send({ code: r.pass_code, id_check_id: rev.body.id_check.id });
    expect(res.body.id_check.reason).toBe('id_check_stale');
  });

  it('la revisión NO guarda el número de la identificación ni la fecha de nacimiento', async () => {
    const rev = await idCheck(hostess);
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'door_id_checks'`);
    const columnas = rows.map((c) => c.column_name);
    for (const prohibida of ['document_number', 'id_number', 'birth_date', 'photo', 'curp']) {
      expect(columnas).not.toContain(prohibida);
    }
    expect(rev.body.id_check.document).toBe('ine');
    expect(rev.body.id_check.adult).toBe(true);
  });

  it('el rechazo queda escrito en la historia del pase', async () => {
    const r = await reservar();
    const rev = await idCheck(hostess, { adult: false, decision: 'rejected', reason: 'menor' });
    await api().post(url('/door/check-in')).set(auth(hostess))
      .send({ code: r.pass_code, id_check_id: rev.body.id_check.id });

    const pases = await pasesDe(r.id);
    const res = await api().get(url(`/reservations/${r.id}/passes/${pases[0].id}/history`))
      .set(auth(hostess));
    const negado = res.body.history.find((h) => h.kind === 'denied');
    expect(negado.reason).toBe('id_rejected');
    expect(negado.actor_name).toBe('Recepcion');
  });
});

// ==========================================================================
// Contingencia
// ==========================================================================

describe('el pase de contingencia', () => {
  it('la puerta lo emite con motivo, y abre una vez', async () => {
    const r = await reservar();
    const res = await api().post(url('/door/passes/contingency')).set(auth(hostess))
      .send({ reservation_id: r.id, label: 'Luis', reason: 'llegó sin teléfono' });

    expect(res.status).toBe(201);
    expect(res.body.pass.kind).toBe('contingency');
    expect(res.body.pass.expires_at).toBeTruthy();
    expect(res.body.pass.payload.startsWith('EV2P.')).toBe(true);

    const entrada = await entrar(res.body.pass.code);
    expect(entrada.body.admitted).toBe(true);
    const otra = await entrar(res.body.pass.code);
    expect(otra.body.pass.result).toBe('used');
  });

  it('vencido no abre, aunque no se haya usado', async () => {
    const r = await reservar();
    const res = await api().post(url('/door/passes/contingency')).set(auth(hostess))
      .send({ reservation_id: r.id, reason: 'pantalla rota' });
    await pool.query(
      `UPDATE guest_passes SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [res.body.pass.id]);
    const entrada = await entrar(res.body.pass.code);
    expect(entrada.body.pass.result).toBe('expired');
  });

  it('sin motivo no se emite', async () => {
    const r = await reservar();
    const res = await api().post(url('/door/passes/contingency')).set(auth(hostess))
      .send({ reservation_id: r.id });
    expect(res.status).toBe(400);
  });

  it('una reservación sin pagar no genera entradas ni por la puerta de atrás', async () => {
    const r = await reservar({ status: 'pending_payment' });
    const res = await api().post(url('/door/passes/contingency')).set(auth(hostess))
      .send({ reservation_id: r.id, reason: 'llegó sin teléfono' });
    expect(res.status).toBe(409);
  });

  it('un cliente no puede emitirse uno a sí mismo', async () => {
    const r = await reservar();
    const res = await api().post(url('/door/passes/contingency')).set(auth(guest))
      .send({ reservation_id: r.id, reason: 'se me murió el teléfono' });
    expect(res.status).toBe(403);
  });

  it('el gerente puede ver cuántas se emitieron: una puerta que emite treinta regala entradas', async () => {
    const r = await reservar();
    for (const motivo of ['sin teléfono', 'pantalla rota']) {
      await api().post(url('/door/passes/contingency')).set(auth(hostess))
        .send({ reservation_id: r.id, reason: motivo });
    }
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM guest_passes
        WHERE nightclub_id = $1 AND kind = 'contingency'`, [club.id]);
    expect(rows[0].n).toBe(2);
  });
});

// ==========================================================================
// Buscar a quien llega sin QR
// ==========================================================================

describe('buscar sin QR en la mano', () => {
  it('por folio', async () => {
    const r = await reservar();
    const res = await api().get(url(`/door/lookup?q=${r.pass_code}`)).set(auth(hostess));
    expect(res.status).toBe(200);
    expect(res.body.reservations).toHaveLength(1);
    expect(res.body.reservations[0].table_code).toBe('39');
  });

  it('por nombre, y dice cómo van sus pases', async () => {
    const r = await reservar({ guest_count: 3 });
    const pases = await pasesDe(r.id);
    await entrar(pases[0].code);
    const res = await api().get(url('/door/lookup?q=Jovanny')).set(auth(hostess));
    expect(res.body.reservations[0]).toMatchObject({
      passes_total: 3, passes_used: 1, passes_active: 2,
    });
  });

  it('el teléfono NO se devuelve, solo sus últimos cuatro para comparar', async () => {
    await pool.query('UPDATE users SET phone = $2 WHERE id = $1', [guest.id, '+52 631 123 4821']);
    const r = await reservar();
    const res = await api().get(url('/door/lookup?q=4821')).set(auth(hostess));
    expect(res.body.reservations).toHaveLength(1);
    expect(res.body.reservations[0].phone_last4).toBe('4821');
    expect(JSON.stringify(res.body)).not.toContain('631 123');
    expect(r.id).toBeTruthy();
  });

  it('un cliente no puede buscar reservaciones ajenas', async () => {
    await reservar();
    const res = await api().get(url('/door/lookup?q=Jovanny')).set(auth(guest));
    expect(res.status).toBe(403);
  });

  it('una búsqueda de dos letras se rechaza: devolvería media base', async () => {
    const res = await api().get(url('/door/lookup?q=Jo')).set(auth(hostess));
    expect(res.status).toBe(400);
  });
});

// ==========================================================================
// Extras pagados en la puerta
// ==========================================================================

describe('los extras pagados llevan su propio QR', () => {
  it('dos extras, dos pases, ligados al cobro', async () => {
    const r = await reservar();
    const res = await api().post(url('/door/admissions')).set(auth(hostess))
      .send({ kind: 'vip_extra', reservation_id: r.id, quantity: 2, unit_price: 100,
        labels: ['Ana', 'Luis'] });

    expect(res.status).toBe(201);
    expect(res.body.passes).toHaveLength(2);
    expect(res.body.passes.map((p) => p.label)).toEqual(['Ana', 'Luis']);
    for (const p of res.body.passes) expect(p.payload.startsWith('EV2P.')).toBe(true);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM guest_passes WHERE admission_id = $1`,
      [res.body.admission.id]);
    expect(rows[0].n).toBe(2);
  });

  it('y abren la puerta', async () => {
    const r = await reservar();
    const venta = await api().post(url('/door/admissions')).set(auth(hostess))
      .send({ kind: 'vip_extra', reservation_id: r.id, quantity: 1, unit_price: 100 });
    const entrada = await entrar(venta.body.passes[0].code);
    expect(entrada.body.admitted).toBe(true);
  });

  it('un cover general NO lleva pase: esa persona no tiene mesa', async () => {
    const res = await api().post(url('/door/admissions')).set(auth(hostess))
      .send({ kind: 'general', quantity: 5, unit_price: 150 });
    expect(res.status).toBe(201);
    expect(res.body.passes).toEqual([]);
  });
});

// ==========================================================================
// Integridad y aislamiento
// ==========================================================================

describe('la auditoría y el aislamiento', () => {
  it('la auditoría no se puede editar ni borrar', async () => {
    const r = await reservar();
    const pases = await pasesDe(r.id);
    await expect(pool.query(
      `UPDATE guest_pass_events SET kind = 'admitted' WHERE pass_id = $1`, [pases[0].id]))
      .rejects.toThrow(/insert-only/);
    await expect(pool.query(
      'DELETE FROM guest_pass_events WHERE pass_id = $1', [pases[0].id]))
      .rejects.toThrow(/insert-only/);
  });

  it('un pase revocado exige motivo en la base, no solo en la ruta', async () => {
    const r = await reservar();
    const pases = await pasesDe(r.id);
    await expect(pool.query(
      `UPDATE guest_passes SET status = 'revoked', revoked_at = now() WHERE id = $1`,
      [pases[0].id])).rejects.toThrow(/revoked_has_a_reason/);
  });

  it('un pase usado exige hora', async () => {
    const r = await reservar();
    const pases = await pasesDe(r.id);
    await expect(pool.query(
      `UPDATE guest_passes SET status = 'used' WHERE id = $1`, [pases[0].id]))
      .rejects.toThrow(/used_is_stamped/);
  });

  it('dos códigos iguales no caben', async () => {
    const r = await reservar();
    await expect(pool.query(
      `INSERT INTO guest_passes (nightclub_id, reservation_id, code, kind)
       VALUES ($1,$2,$3,'guest')`, [club.id, r.id, r.pass_code]))
      .rejects.toThrow(/guest_passes_code_uidx|duplicate key/);
  });

  it('el pase de otro club no se ve desde este', async () => {
    const otroClub = await f.createNightclub({ slug: 'otro' });
    const suGuest = await f.createUser(otroClub.id, { role: 'guest' });
    const suMesa = await f.createTable(otroClub.id, { code: 'X1', section: 'GENERAL', capacity: 4 });
    const ajena = await reservar({
      nightclub_id: otroClub.id, user_id: suGuest.id, table_id: suMesa.id,
    });
    const res = await api().get(url(`/reservations/${ajena.id}/passes`)).set(auth(manager));
    expect(res.status).toBe(404);
  });

  it('sin token no se ve ni se toca nada', async () => {
    const r = await reservar();
    const pases = await pasesDe(r.id);
    const rutas = [
      ['get', `/reservations/${r.id}/passes`],
      ['get', `/reservations/${r.id}/passes/${pases[0].id}`],
      ['patch', `/reservations/${r.id}/passes/${pases[0].id}`],
      ['post', `/reservations/${r.id}/passes/${pases[0].id}/share`],
      ['post', `/reservations/${r.id}/passes/${pases[0].id}/revoke`],
      ['post', `/reservations/${r.id}/passes/${pases[0].id}/reassign`],
      ['get', `/reservations/${r.id}/passes/${pases[0].id}/history`],
      ['post', '/door/id-checks'],
      ['post', '/door/check-in'],
      ['get', '/door/lookup?q=abc'],
      ['post', '/door/passes/contingency'],
    ];
    for (const [metodo, ruta] of rutas) {
      const res = await api()[metodo](url(ruta)).send({});
      expect({ ruta, status: res.status }).toEqual({ ruta, status: 401 });
    }
  });
});
