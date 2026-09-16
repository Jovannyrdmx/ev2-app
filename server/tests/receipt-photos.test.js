/**
 * Las rutas de la foto del ticket, de punta a punta con una imagen real.
 *
 * Lo que se cuida aquí es el ORDEN, que es de donde viene todo el valor de esta
 * función y también todo su riesgo:
 *
 *   1. La foto se GUARDA primero. Aunque la lectura falle por completo, el
 *      comprobante queda adentro y la captura sigue a mano. La captura nunca depende
 *      de que Tesseract funcione.
 *   2. Lo leído NO mueve inventario. Subir una foto no cambia una sola existencia:
 *      `POST /supply-receipts` sigue siendo la única puerta, con una persona que
 *      revisó renglón por renglón.
 *   3. Una foto se usa UNA vez. El doble toque en un teléfono lento es lo que mete la
 *      misma entrega dos veces, y esa protección tiene que estar DENTRO de la misma
 *      transacción de la captura: si la foto ya se usó, la entrada tampoco entra.
 *   4. Nunca se borra. Es un comprobante; se marca `discarded` y se queda.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

const FIXTURE = path.join(__dirname, 'fixtures', 'factura-proveedor.jpg');

// Cada corrida escribe en su propio directorio temporal: probar contra el volumen de
// verdad dejaría basura, y peor, haría que una prueba dependiera de otra.
const RECEIPTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ev2-receipts-'));
process.env.RECEIPTS_DIR = RECEIPTS_DIR;

function tesseractReady() {
  try {
    return /^spa$/m.test(execFileSync('tesseract', ['--list-langs'], { encoding: 'utf8' }));
  } catch { return false; }
}
const CON_TESSERACT = tesseractReady();

let club; let warehouse; let manager; let almacenista; let bartender;

beforeAll(setupSchema);
afterAll(async () => {
  await closePool();
  fs.rmSync(RECEIPTS_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-photos' });
  warehouse = club.warehouse_id;
  manager = await f.createUser(club.id, { role: 'manager' });
  almacenista = await f.createUser(club.id, { role: 'warehouse' });
  bartender = await f.createUser(club.id, { role: 'bartender' });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

/** Sube la imagen como lo haría el teléfono: multipart, campo `photo`. */
const subir = (who = almacenista, file = FIXTURE) => api()
  .post(url('/receipt-photos'))
  .set(auth(who))
  .attach('photo', file);

const catalogo = () => Promise.all([
  'Tequila Don Julio 70 750 ml', 'Cerveza Corona 355 ml', 'Ron Bacardí Blanco 1 L',
  'Agua mineral Topo Chico 600 ml', 'Whisky Buchanans 12 750 ml',
].map((name) => f.createSupply(club.id, { name })));

describe('Subir la foto', () => {
  it('la guarda en disco y en la base, con quién la subió', async () => {
    const res = await subir();
    expect(res.status).toBe(201);
    expect(res.body.photo).toMatchObject({
      mime_type: 'image/jpeg', uploaded_by: almacenista.id, receipt_group: null,
    });
    expect(res.body.photo.bytes).toBeGreaterThan(1000);
    expect(res.body.photo.checksum).toMatch(/^[0-9a-f]{64}$/);

    // El archivo está de verdad en disco, y su ruta guardada es RELATIVA: mover el
    // volumen a otro disco no debe invalidar cada renglón de la tabla.
    const { rows } = await pool.query('SELECT file_path FROM receipt_photos WHERE id = $1',
      [res.body.photo.id]);
    expect(path.isAbsolute(rows[0].file_path)).toBe(false);
    expect(fs.existsSync(path.join(RECEIPTS_DIR, rows[0].file_path))).toBe(true);
  });

  it('NUNCA devuelve la ruta del disco del servidor', async () => {
    // Publicarla no le sirve al navegador —no puede abrirla— y sí le sirve a quien
    // esté buscando por dónde entrar.
    const res = await subir();
    expect(res.body.photo.file_path).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(RECEIPTS_DIR);
  });

  it('subir la misma foto dos veces devuelve la de antes, no una copia', async () => {
    const primera = await subir();
    const otra = await subir();
    expect(otra.status).toBe(200);
    expect(otra.body.already_uploaded).toBe(true);
    expect(otra.body.photo.id).toBe(primera.body.photo.id);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM receipt_photos');
    expect(rows[0].n).toBe(1);
  });

  it('el gerente también puede; un cantinero no', async () => {
    expect((await subir(manager)).status).toBe(201);
    expect((await subir(bartender)).status).toBe(403);
  });

  it('rechaza lo que no es una imagen', async () => {
    const res = await api().post(url('/receipt-photos')).set(auth(almacenista))
      .attach('photo', Buffer.from('%PDF-1.4 no soy una foto'),
        { filename: 'factura.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(422);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM receipt_photos');
    expect(rows[0].n).toBe(0);
  });

  it('sin archivo contesta que falta la imagen, no un error del servidor', async () => {
    const res = await api().post(url('/receipt-photos')).set(auth(almacenista));
    expect(res.status).toBe(422);
  });

  it('subir una foto NO mueve ni una existencia', async () => {
    const supply = await f.createSupply(club.id, { name: 'Cerveza Corona 355 ml' });
    await subir();
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM supply_movements WHERE supply_id = $1', [supply.id]);
    expect(rows[0].n).toBe(0);
  });

  (CON_TESSERACT ? it : it.skip)('lee la factura y propone los renglones', async () => {
    await catalogo();
    const res = await subir();
    expect(res.body.photo.status).toBe('parsed');
    expect(res.body.photo.error).toBeNull();
    const leido = res.body.photo.parsed;
    expect(leido.lines).toHaveLength(5);
    expect(leido.lines.filter((l) => l.supply_id).length).toBe(5);
    expect(leido.total_matches).toBe(true);
  });

  (CON_TESSERACT ? it : it.skip)('sin catálogo lee igual, y no propone insumos', async () => {
    const res = await subir();
    expect(res.body.photo.status).toBe('parsed');
    expect(res.body.photo.parsed.lines.filter((l) => l.supply_id).length).toBe(0);
  });

  it('si la lectura falla, la foto queda guardada y dice por qué', async () => {
    const antes = process.env.TESSERACT_BIN;
    process.env.TESSERACT_BIN = '/usr/bin/no-existe-tesseract';
    try {
      const res = await subir();
      // 201 a propósito: la foto SÍ se guardó, y eso es lo que se creó.
      expect(res.status).toBe(201);
      expect(res.body.photo.status).toBe('failed');
      expect(res.body.photo.error).toMatch(/no está instalado/);
      const { rows } = await pool.query('SELECT file_path FROM receipt_photos WHERE id = $1',
        [res.body.photo.id]);
      expect(fs.existsSync(path.join(RECEIPTS_DIR, rows[0].file_path))).toBe(true);
    } finally {
      if (antes === undefined) delete process.env.TESSERACT_BIN;
      else process.env.TESSERACT_BIN = antes;
    }
  });
});

describe('Ver y manejar las fotos', () => {
  it('la imagen se sirve con el token y solo a su club', async () => {
    const foto = (await subir()).body.photo;

    const ok = await api().get(url(`/receipt-photos/${foto.id}/image`)).set(auth(manager));
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toContain('image/jpeg');
    expect(ok.body.length).toBe(foto.bytes);
    // Privada: es una factura con el RFC del club y los precios de compra.
    expect(ok.headers['cache-control']).toContain('private');

    // Sin token, nada.
    expect((await api().get(url(`/receipt-photos/${foto.id}/image`))).status).toBe(401);

    // Y desde otro club, tampoco: el id de la foto no basta.
    const otro = await f.createNightclub({ slug: 'ev2-photos-2' });
    const ajeno = await f.createUser(otro.id, { role: 'manager' });
    const cruzado = await api()
      .get(`/api/nightclubs/${otro.id}/receipt-photos/${foto.id}/image`).set(auth(ajeno));
    expect(cruzado.status).toBe(404);
  });

  it('la lista esconde lo ya capturado y lo descartado, salvo que se pidan', async () => {
    const foto = (await subir()).body.photo;
    const abierta = await api().get(url('/receipt-photos')).set(auth(almacenista));
    expect(abierta.body.photos.map((p) => p.id)).toEqual([foto.id]);

    await api().post(url(`/receipt-photos/${foto.id}/discard`)).set(auth(almacenista))
      .send({ reason: 'salió borrosa' });

    const despues = await api().get(url('/receipt-photos')).set(auth(almacenista));
    expect(despues.body.photos).toHaveLength(0);
    const todas = await api().get(url('/receipt-photos?include_done=true')).set(auth(almacenista));
    expect(todas.body.photos.map((p) => p.status)).toEqual(['discarded']);
  });

  it('descartar NO borra: la foto es el comprobante', async () => {
    const foto = (await subir()).body.photo;
    const res = await api().post(url(`/receipt-photos/${foto.id}/discard`))
      .set(auth(almacenista)).send({ reason: 'se devolvió la entrega' });
    expect(res.status).toBe(200);
    expect(res.body.photo).toMatchObject({ status: 'discarded', error: 'se devolvió la entrega' });

    const { rows } = await pool.query('SELECT file_path FROM receipt_photos WHERE id = $1', [foto.id]);
    expect(rows).toHaveLength(1);
    expect(fs.existsSync(path.join(RECEIPTS_DIR, rows[0].file_path))).toBe(true);

    // Ni la base lo permite: el disparador de la migración 024 bloquea el DELETE.
    await expect(pool.query('DELETE FROM receipt_photos WHERE id = $1', [foto.id]))
      .rejects.toThrow();
  });

  it('descartar sin motivo no se acepta', async () => {
    const foto = (await subir()).body.photo;
    expect((await api().post(url(`/receipt-photos/${foto.id}/discard`))
      .set(auth(almacenista)).send({})).status).toBe(400);
    expect((await api().post(url(`/receipt-photos/${foto.id}/discard`))
      .set(auth(almacenista)).send({ reason: 'x' })).status).toBe(400);
  });

  (CON_TESSERACT ? it : it.skip)('volver a leer encuentra los insumos que faltaban', async () => {
    // El caso real: se sube el ticket, se descubre que los insumos no estaban en el
    // catálogo, se dan de alta, y ahora el parecido sí los encuentra. Sin esto habría
    // que volver a fotografiar el papel, que a esa hora ya no está.
    const foto = (await subir()).body.photo;
    expect(foto.parsed.lines.filter((l) => l.supply_id).length).toBe(0);

    await catalogo();
    const otra = await api().post(url(`/receipt-photos/${foto.id}/reparse`)).set(auth(almacenista));
    expect(otra.status).toBe(200);
    expect(otra.body.photo.parsed.lines.filter((l) => l.supply_id).length).toBe(5);
  });
});

describe('La foto y la captura, amarradas', () => {
  /** La entrada tal como la manda la pantalla después de la revisión. */
  const capturar = (photoId, lines) => api().post(url('/supply-receipts'))
    .set(auth(almacenista))
    .send({ location_id: warehouse, ...(photoId ? { photo_id: photoId } : {}), lines });

  it('la captura marca la foto como usada y la amarra al lote', async () => {
    const supply = await f.createSupply(club.id, { name: 'Cerveza Corona 355 ml', package_size: 355 });
    const foto = (await subir()).body.photo;

    const res = await capturar(foto.id, [{ supply_id: supply.id, packages: 6, package_cost: 25.5 }]);
    expect(res.status).toBe(201);
    const grupo = res.body.receipt.receipt_group;

    const { rows } = await pool.query(
      'SELECT status, receipt_group, used_at FROM receipt_photos WHERE id = $1', [foto.id]);
    expect(rows[0]).toMatchObject({ status: 'used', receipt_group: grupo });
    expect(rows[0].used_at).not.toBeNull();
  });

  it('la misma foto no se captura dos veces, y la segunda entrada NO entra', async () => {
    const supply = await f.createSupply(club.id, { name: 'Cerveza Corona 355 ml', package_size: 355 });
    const foto = (await subir()).body.photo;
    const linea = [{ supply_id: supply.id, packages: 6, package_cost: 25.5 }];

    expect((await capturar(foto.id, linea)).status).toBe(201);
    const otra = await capturar(foto.id, linea);
    expect(otra.status).toBe(409);

    // Lo importante no es el 409: es que el inventario NO se movió dos veces. Sin la
    // comprobación dentro de la misma transacción, el doble toque en un teléfono
    // lento mete la entrega dos veces y solo se descubre contando el estante.
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM supply_movements WHERE supply_id = $1', [supply.id]);
    expect(rows[0].n).toBe(1);
  });

  it('una foto descartada ya no sirve para capturar', async () => {
    const supply = await f.createSupply(club.id, { name: 'Cerveza Corona 355 ml', package_size: 355 });
    const foto = (await subir()).body.photo;
    await api().post(url(`/receipt-photos/${foto.id}/discard`)).set(auth(almacenista))
      .send({ reason: 'salió borrosa' });

    const res = await capturar(foto.id, [{ supply_id: supply.id, packages: 6, package_cost: 25.5 }]);
    expect(res.status).toBe(409);
  });

  it('una foto ya capturada no se puede volver a leer', async () => {
    const supply = await f.createSupply(club.id, { name: 'Cerveza Corona 355 ml', package_size: 355 });
    const foto = (await subir()).body.photo;
    await capturar(foto.id, [{ supply_id: supply.id, packages: 6, package_cost: 25.5 }]);
    const res = await api().post(url(`/receipt-photos/${foto.id}/reparse`)).set(auth(almacenista));
    expect(res.status).toBe(409);
  });

  it('la captura sin foto sigue funcionando igual', async () => {
    // La foto ahorra teclado; no es un requisito. Una entrega sin ticket a la mano se
    // captura igual, y eso no puede romperse nunca.
    const supply = await f.createSupply(club.id, { name: 'Cerveza Corona 355 ml', package_size: 355 });
    const res = await capturar(null, [{ supply_id: supply.id, packages: 6, package_cost: 25.5 }]);
    expect(res.status).toBe(201);
  });

  it('una foto de otro club no se puede amarrar a esta captura', async () => {
    const otro = await f.createNightclub({ slug: 'ev2-photos-3' });
    const ajeno = await f.createUser(otro.id, { role: 'warehouse' });
    const suya = await api().post(`/api/nightclubs/${otro.id}/receipt-photos`)
      .set(auth(ajeno)).attach('photo', FIXTURE);
    const supply = await f.createSupply(club.id, { name: 'Cerveza Corona 355 ml', package_size: 355 });

    const res = await capturar(suya.body.photo.id,
      [{ supply_id: supply.id, packages: 6, package_cost: 25.5 }]);
    expect(res.status).toBe(409);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM supply_movements WHERE supply_id = $1', [supply.id]);
    expect(rows[0].n).toBe(0);
  });
});
