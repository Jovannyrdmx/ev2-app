/**
 * La foto del ticket: leerla, proponer renglones, y NO mover nada del inventario.
 *
 * Lo que se prueba aquí no es "que Tesseract funcione" —eso lo prueba Tesseract—.
 * Es lo que decide si esta función sirve o es peligrosa:
 *
 *   1. La aritmética manda. `cantidad × precio = importe` es la única forma de saber,
 *      sin ver la foto, si un dígito se leyó mal. Un renglón que no cuadra sale
 *      MARCADO, nunca aceptado en silencio.
 *   2. El nombre no se adivina. Con dos insumos parecidos —Don Julio 70 y Don Julio
 *      Reposado— el renglón se queda SIN insumo, porque elegir mete la botella
 *      equivocada al estante y no se descubre hasta el conteo.
 *   3. La presentación se queda en el nombre. En "DON JULIO 70 750ML 900.00 1,800.00",
 *      el 70 y el 750 son lo que distingue una botella de otra; tomarlos por precios
 *      deja "DON JULIO", que se parece igual a cuatro insumos.
 *   4. La foto se guarda ANTES de leerla, y si la lectura falla la foto sigue adentro.
 *      El comprobante vale por sí solo; la captura nunca depende del OCR.
 *
 * Hay pruebas contra una imagen REAL (`tests/fixtures/factura-proveedor.jpg`, una
 * factura de proveedor con ruido y torcida, como sale del teléfono) y no solo contra
 * texto: un parser de renglones que solo se prueba con texto perfecto se rompe la
 * primera vez que ve una foto de verdad.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const f = require('./helpers/factories');
const ocr = require('../src/services/receipt-ocr');

const FIXTURE = path.join(__dirname, 'fixtures', 'factura-proveedor.jpg');
// Un TICKET, que es otro problema que una factura: angosto, impresion termica gris y
// gastada, papel curvado, fotografiado torcido sobre una mesa oscura. Y sobre todo:
// con el renglon PARTIDO en dos, que es lo que rompio esto en el club de verdad.
const TICKET = path.join(__dirname, 'fixtures', 'ticket-termico.jpg');

/**
 * ¿Está Tesseract con español en esta máquina?
 *
 * Las pruebas del lector se saltan si no —una máquina de desarrollo sin el paquete
 * instalado no debe ver una suite roja que no puede arreglar— pero las del parser y
 * las del guardado corren siempre, porque son las que de verdad protegen el
 * inventario. En el contenedor de producción va instalado (`deploy/Dockerfile.api`).
 */
function tesseractReady() {
  try {
    const langs = execFileSync('tesseract', ['--list-langs'], { encoding: 'utf8' });
    return /^spa$/m.test(langs);
  } catch { return false; }
}
const CON_TESSERACT = tesseractReady();
const siOCR = CON_TESSERACT ? it : it.skip;

if (!CON_TESSERACT) {
  // eslint-disable-next-line no-console
  console.warn('Tesseract con español no está instalado: se saltan las pruebas del lector.');
}

// ========================================================== los números de un renglón

describe('Convertir lo que dice el papel a números', () => {
  it('distingue el separador de miles del decimal en las dos escrituras', () => {
    expect(ocr.toNumber('1,800.00')).toBe(1800);
    expect(ocr.toNumber('1.800,00')).toBe(1800);
    expect(ocr.toNumber('900.00')).toBe(900);
    expect(ocr.toNumber('25,50')).toBe(25.5);
    // Tres dígitos detrás de un solo separador son miles, no decimales: un precio de
    // bebidas con tres decimales no existe.
    expect(ocr.toNumber('1,800')).toBe(1800);
    expect(ocr.toNumber('153')).toBe(153);
  });

  it('arregla los dígitos confundidos solo donde ya había dígitos', () => {
    expect(ocr.fixDigits('9O0.00')).toBe('900.00');
    expect(ocr.fixDigits('1,8OO.00')).toBe('1,800.00');
    // "SOL" es una cerveza, no el número 501. Sin esta regla, una Cerveza Sol se
    // convierte en un precio y el renglón entero se lee mal.
    expect(ocr.fixDigits('SOL')).toBe('SOL');
    expect(ocr.fixDigits('CORONA')).toBe('CORONA');
  });
});

describe('Un renglón del ticket', () => {
  const leer = (texto) => {
    const line = ocr.parseLine(texto);
    return line ? ocr.reconcile(line) : null;
  };

  it('saca cantidad, precio e importe, y comprueba la cuenta', () => {
    expect(leer('6  CERVEZA CORONA 355 ML   25.50   153.00')).toMatchObject({
      description: 'CERVEZA CORONA 355 ML', quantity: 6, unit_cost: 25.5,
      line_total: 153, math: 'ok',
    });
  });

  it('deja la presentación en el nombre y no la toma por precio', () => {
    // Lo que distingue un Don Julio 70 de un Reposado es justo el "70 750ML".
    expect(leer('2 TEQUILA DON JULIO 70 750ML 900.00 1,800.00').description)
      .toBe('TEQUILA DON JULIO 70 750ML');
    expect(leer('12 AGUA MINERAL TOPO CHICO 600 18.00 216.00').description)
      .toBe('AGUA MINERAL TOPO CHICO 600');
  });

  it('marca el renglón cuando la cuenta NO cuadra', () => {
    // 6 × 25.50 son 153, no 200. Un dígito se leyó mal y hay que ir al papel.
    expect(leer('6 CERVEZA CORONA 25.50 200.00').math).toBe('mismatch');
  });

  it('deduce el dato que falta, y dice que lo dedujo', () => {
    // Cantidad y unitario, sin importe: el importe se calcula y se dice que se calculó.
    expect(leer('4 JUGO DE TORONJA 2L 22.00 88.00')).toMatchObject({
      quantity: 4, unit_cost: 22, line_total: 88, math: 'ok',
    });
    // Sin cantidad pero con los dos importes: 153 / 25.50 = 6 justo, así que se puede.
    expect(leer('CERVEZA CORONA 355ML 25.50 153.00')).toMatchObject({
      quantity: 6, math: 'derived_quantity',
    });
    // Cantidad 1: unitario e importe son el mismo número, no hay nada que adivinar.
    expect(leer('1 RON BACARDI BLANCO 1L 320.00')).toMatchObject({
      quantity: 1, unit_cost: 320, line_total: 320, math: 'derived_unit',
    });
  });

  it('con UNA sola cifra y varias piezas, no adivina el costo', () => {
    // "4 JUGO 22.00": ¿22 cada uno, o 22 los cuatro? Las dos lecturas dan costos que
    // se diferencian por cuatro, y guardar la equivocada envenena el costo promedio
    // de ese insumo sin que nadie lo note hasta que el margen del trago sale mal.
    const linea = leer('4 JUGO DE TORONJA 2L 22.00');
    expect(linea).toMatchObject({ quantity: 4, unit_cost: null, math: 'one_amount' });
  });

  it('no inventa una cantidad que no sale entera', () => {
    // 150 / 25.50 = 5.88: uno de los dos números se leyó mal, y adivinar "6" metería
    // una botella que nadie entregó.
    expect(leer('CERVEZA CORONA 355ML 25.50 150.00').quantity).toBeNull();
  });

  it('con tres columnas, la aritmética decide cuáles son precio', () => {
    // 5 × 45 = 225, así que 1,200.00 es un acumulado del ticket y no el importe.
    expect(leer('5 REDBULL LATA 250 ML 45.00 225.00 1,200.00')).toMatchObject({
      description: 'REDBULL LATA 250 ML', unit_cost: 45, line_total: 225, math: 'ok',
    });
  });

  it('descarta lo que no es mercancía', () => {
    const noSon = [
      'SUBTOTAL 5,939.00', 'TOTAL 6,889.24', 'IVA 16% 950.24',
      'RFC: DNO120315AB2', 'FACTURA A-10482 FECHA 12/09/2026',
      'DISTRIBUIDORA DEL NOROESTE SA DE CV', 'CLIENTE: EV2 CLANDESTINOZ SA DE CV',
      'GRACIAS POR SU COMPRA', 'CANT DESCRIPCION P.UNIT IMPORTE',
      'Av. Obregon 1420, Nogales, Son.',
    ];
    expect(noSon.filter((linea) => ocr.parseLine(linea) !== null)).toEqual([]);
  });
});

describe('El renglón partido de un ticket angosto', () => {
  /**
   * Este es el defecto que hizo que en el club la foto no llenara nada, y no era la
   * calidad de la imagen: era el FORMATO del papel. Un ticket térmico mide ocho
   * centímetros y no le caben el nombre y las columnas de precio en la misma línea.
   */
  const TERMICO = [
    '6  TEQ DON JULIO 70 690ML',
    '        1150.00      6900.00',
    '24 RON BACARDI BCO 750ML',
    '         285.00      6840.00',
    'SUBTOTAL',
    '             13740.00',
  ].join('\n');

  it('une el nombre con las cifras que vienen abajo', () => {
    const renglones = ocr.parseReceipt(TERMICO);
    expect(renglones).toHaveLength(2);
    expect(renglones[0]).toMatchObject({
      quantity: 6, unit_cost: 1150, line_total: 6900, math: 'ok',
    });
    expect(renglones[0].description).toBe('TEQ DON JULIO 70 690ML');
    expect(renglones[1]).toMatchObject({ quantity: 24, unit_cost: 285, math: 'ok' });
  });

  it('el pie partido también se junta, y por eso se reconoce y se descarta', () => {
    // Sin unirlo, "SUBTOTAL" se va solo y la cifra de abajo entra como un producto.
    expect(ocr.documentTotals(ocr.joinWrappedLines(TERMICO)).subtotal).toBe(13740);
    expect(ocr.parseReceipt(TERMICO).some((l) => /subtotal/i.test(l.description))).toBe(false);
  });

  it('NO junta dos renglones de mercancía seguidos', () => {
    // La regla es estrecha a propósito: solo se une con un renglón de PURAS cifras.
    const seguidos = '6 CERVEZA CORONA 355 ML 25.50 153.00\n4 JUGO PIÑA 1L 42.00 168.00';
    const renglones = ocr.parseReceipt(seguidos);
    expect(renglones).toHaveLength(2);
    expect(renglones.map((l) => l.quantity)).toEqual([6, 4]);
  });

  it('un renglón suelto de cifras, sin nombre arriba, no inventa un producto', () => {
    expect(ocr.parseReceipt('1150.00 6900.00')).toEqual([]);
  });

  it('descarta el pie que el lector mordió, por su forma', () => {
    // "TOTAL" leído como "'OTAL" se le escapa a la lista de palabras. Una sola
    // palabra, un solo importe y ninguna cantidad es una etiqueta, no mercancía.
    expect(ocr.parseLine("'OTAL 32336.16")).toBeNull();
    expect(ocr.parseLine('SUBTOTAI 27876.00')).toBeNull();
    // Y la mercancía de verdad, que se describe con varias palabras, sigue pasando.
    expect(ocr.parseLine('CERVEZA CORONA 355ML 25.50')).not.toBeNull();
  });
});

describe('El pie del documento', () => {
  const FACTURA = [
    '2 TEQUILA DON JULIO 70 750ML 900.00 1,800.00',
    'SUBTOTAL 1,800.00',
    'IVA 16% 288.00',
    'TOTAL 2,088.00',
  ].join('\n');

  it('lee subtotal, impuesto y total por separado', () => {
    expect(ocr.documentTotals(FACTURA)).toEqual({
      subtotal: 1800, tax: 288, total: 2088,
    });
  });

  it('compara los renglones contra el SUBTOTAL, no contra el total', () => {
    // Comparar contra el total da una alarma falsa en cada factura con IVA: los
    // renglones nunca traen el impuesto.
    expect(ocr.comparableTotal({ subtotal: 1800, tax: 288, total: 2088 })).toBe(1800);
    // Un ticket térmico sin subtotal desglosado: se resta el impuesto.
    expect(ocr.comparableTotal({ subtotal: null, tax: 288, total: 2088 })).toBe(1800);
    // Y sin nada desglosado, el total tal cual.
    expect(ocr.comparableTotal({ subtotal: null, tax: null, total: 2088 })).toBe(2088);
  });
});

// ============================================================ hallar el insumo

beforeAll(setupSchema);
afterAll(closePool);

describe('Encontrar el insumo del catálogo', () => {
  let club;

  beforeEach(async () => {
    await truncateAll();
    club = await f.createNightclub({ slug: 'ev2-ocr' });
  });

  const buscar = (description) => ocr.matchSupplies(pool, { nightclubId: club.id, description });

  it('encuentra el insumo aunque el ticket lo abrevie', async () => {
    await f.createSupply(club.id, { name: 'Tequila Don Julio 70 Añejo Cristalino' });
    const hallados = await buscar('TEQ DON JULIO 70 750ML');
    expect(hallados.length).toBeGreaterThan(0);
    expect(hallados[0].name).toContain('Don Julio 70');
  });

  it('los acentos no estorban: "ANEJO" encuentra "Añejo"', async () => {
    await f.createSupply(club.id, { name: 'Tequila Don Julio Añejo' });
    const hallados = await buscar('TEQUILA DON JULIO ANEJO');
    expect(hallados[0].name).toBe('Tequila Don Julio Añejo');
  });

  it('NO elige cuando el papel no alcanza para distinguir', async () => {
    await f.createSupply(club.id, { name: 'Tequila Don Julio 70' });
    await f.createSupply(club.id, { name: 'Tequila Don Julio Reposado' });
    // El renglón no dice ni "70" ni "reposado": los dos nombres son posibles y
    // ninguno está completo en el papel.
    const hallados = await buscar('TEQUILA DON JULIO');
    const elegido = ocr.bestMatch(hallados, 'TEQUILA DON JULIO');
    expect(hallados.length).toBe(2);
    // Se proponen los dos y el renglón se queda sin insumo hasta que una persona
    // escoja: meter el Reposado donde iba el 70 no se descubre hasta el conteo.
    expect(elegido.confident).toBe(false);
  });

  it('sí elige cuando hay un ganador claro', async () => {
    await f.createSupply(club.id, { name: 'Cerveza Corona 355 ml' });
    await f.createSupply(club.id, { name: 'Ron Bacardí Blanco 1 L' });
    const elegido = ocr.bestMatch(await buscar('CERVEZA CORONA 355 ML'), 'CERVEZA CORONA 355 ML');
    expect(elegido.confident).toBe(true);
    expect(elegido.supply.name).toBe('Cerveza Corona 355 ml');
  });

  /**
   * Estos cuatro casos salieron del catálogo REAL del club y de una factura escrita
   * como la escribe un proveedor. Con solo el puntaje de trigramas, los cuatro se
   * quedaban sin insumo —el correcto salía primero, pero por menos de 0.12 de
   * diferencia— y el almacenista tenía que escogerlos a mano uno por uno.
   */
  describe('El nombre completo dentro del renglón', () => {
    it('la palabra abreviada cuenta; los números, exactos', () => {
      expect(ocr.sameToken('tequila', 'teq')).toBe(true);
      expect(ocr.sameToken('blanco', 'blco')).toBe(false);
      // Tres letras mínimo: "de" no debe emparejar con medio catálogo.
      expect(ocr.sameToken('de', 'don')).toBe(false);
      // Y un 12 NO es un 1234: sin esto, un Buchannans 12 emparejaría con cualquier
      // cosa que traiga un número que empiece con 12.
      expect(ocr.sameToken('12', '1234')).toBe(false);
      expect(ocr.sameToken('12', '12')).toBe(true);
    });

    it('reconoce el nombre entero aunque el ticket abrevie y agregue la medida', () => {
      expect(ocr.nameCovered('TEQUILA DON JULIO 70', 'TEQ DON JULIO 70 690ML')).toBe(true);
      // "REPOSADO" no aparece en el papel: ese no es.
      expect(ocr.nameCovered('TEQUILA DON JULIO REPOSADO', 'TEQ DON JULIO 70 690ML')).toBe(false);
      expect(ocr.nameCovered('JUGO PIÑA', 'JUGO PINA 1L')).toBe(true);
    });

    it('elige el Absolut sin sabor entre seis Absolut con sabor', async () => {
      for (const name of ['VODKA ABSOLUT', 'VODKA ABSOLUT LIMON', 'VODKA ABSOLUT MANGO',
        'VODKA ABSOLUT PERA', 'VODKA ABSOLUT RASPBERRY', 'VODKA ABSOLUT SANDIA']) {
        // eslint-disable-next-line no-await-in-loop
        await f.createSupply(club.id, { name });
      }
      const desc = 'VODKA ABSOLUT 750ML';
      const hallados = await buscar(desc);
      // Por trigramas empatan: comparten casi todas las letras.
      expect(hallados[0].score).toBe(hallados[1].score);
      // Pero solo uno no menciona un sabor que el papel no dice.
      const elegido = ocr.bestMatch(hallados, desc);
      expect(elegido.confident).toBe(true);
      expect(elegido.supply.name).toBe('VODKA ABSOLUT');
    });

    it('elige el Buchannans 12 entre el 18, el 21 y el Master', async () => {
      for (const name of ['WHISKY BUCHANNANS 12', 'WHISKY BUCHANNANS 18',
        'WHISKY BUCHANNANS 21 *RED SEAL*', 'WHISKY BUCHANNANS MASTER',
        'WHISKY BUCHANNANS PIÑA']) {
        // eslint-disable-next-line no-await-in-loop
        await f.createSupply(club.id, { name });
      }
      const desc = 'WHISKY BUCHANNANS 12 750';
      const elegido = ocr.bestMatch(await buscar(desc), desc);
      expect(elegido.confident).toBe(true);
      expect(elegido.supply.name).toBe('WHISKY BUCHANNANS 12');
    });

    it('con dos nombres completos, decide el puntaje y gana el más específico', async () => {
      // El renglón dice "BLANCO", así que los dos nombres del catálogo caben dentro de
      // él. La regla del nombre completo no desempata y decide el parecido, que aquí
      // acierta: el que también dice "blanco".
      await f.createSupply(club.id, { name: 'RON BACARDI' });
      await f.createSupply(club.id, { name: 'RON BACARDI BLANCO' });
      const desc = 'RON BACARDI BLANCO 750ML';
      const hallados = await buscar(desc);
      expect(hallados.filter((c) => ocr.nameCovered(c.name, desc))).toHaveLength(2);
      const elegido = ocr.bestMatch(hallados, desc);
      expect(elegido.confident).toBe(true);
      expect(elegido.supply.name).toBe('RON BACARDI BLANCO');
    });

    it('y si el puntaje tampoco desempata, no elige', async () => {
      // Dos presentaciones del mismo producto con nombres igual de parecidos al
      // renglón. Aquí no hay forma de saber, y adivinar mete la botella equivocada.
      await f.createSupply(club.id, { name: 'TECATE ROJA' });
      await f.createSupply(club.id, { name: 'TECATE LIGHT' });
      const desc = 'CERVEZA TECATE 24 PZ';
      const elegido = ocr.bestMatch(await buscar(desc), desc);
      expect(elegido.confident).toBe(false);
    });
  });

  it('no propone insumos de otro club ni dados de baja', async () => {
    const otro = await f.createNightclub({ slug: 'ev2-ocr-2' });
    await f.createSupply(otro.id, { name: 'Cerveza Corona 355 ml' });
    const baja = await f.createSupply(club.id, { name: 'Cerveza Corona Light 355 ml' });
    await pool.query('UPDATE supplies SET active = false WHERE id = $1', [baja.id]);
    expect(await buscar('CERVEZA CORONA 355 ML')).toEqual([]);
  });

  it('la normalización de JavaScript es la misma que la de la base', async () => {
    // Si una cambia sin la otra, el índice por parecido deja de servir en silencio:
    // sigue devolviendo resultados, solo que peores.
    const muestras = ['Tequila Don Julio 70 Añejo', '  CERVEZA  Corona 355 ML ', 'Ñandú Ünico'];
    const { rows } = await pool.query(
      'SELECT ev2_norm(x) AS sql FROM unnest($1::text[]) AS x', [muestras]);
    expect(rows.map((r) => r.sql)).toEqual(muestras.map((m) => ocr.norm(m)));
  });
});

// ============================================================ la imagen de verdad

describe('Leer una foto real', () => {
  let club;

  beforeEach(async () => {
    await truncateAll();
    club = await f.createNightclub({ slug: 'ev2-ocr-img' });
  });

  it('la imagen de prueba existe en el repositorio', () => {
    expect(fs.existsSync(FIXTURE)).toBe(true);
  });

  siOCR('saca los cinco renglones de mercancía y ninguno del encabezado', async () => {
    const texto = await ocr.ocrText(FIXTURE);
    const renglones = ocr.parseReceipt(texto);
    expect(renglones).toHaveLength(5);
    expect(renglones.map((l) => l.math)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(renglones[0]).toMatchObject({ quantity: 2, unit_cost: 900, line_total: 1800 });
    expect(renglones[0].description).toContain('DON JULIO');
  });

  siOCR('propone los insumos del catálogo y avisa si la suma no cuadra', async () => {
    for (const name of ['Tequila Don Julio 70 750 ml', 'Cerveza Corona 355 ml',
      'Ron Bacardí Blanco 1 L', 'Agua mineral Topo Chico 600 ml',
      'Whisky Buchanans 12 750 ml']) {
      // eslint-disable-next-line no-await-in-loop
      await f.createSupply(club.id, { name });
    }
    const leido = await ocr.readReceipt(pool, { nightclubId: club.id, imagePath: FIXTURE });

    expect(leido.lines).toHaveLength(5);
    // Los cinco insumos se encontraron solos: eso es lo que convierte veinte minutos
    // de teclado en dos de revisión.
    expect(leido.lines.filter((l) => l.supply_id).length).toBe(5);
    expect(leido.lines.every((l) => l.confidence === 'high')).toBe(true);
    // El papel dice 5,939 de subtotal y los renglones suman lo mismo.
    expect(leido.document_subtotal).toBe(5939);
    expect(leido.document_total).toBe(6889.24);
    expect(leido.lines_total).toBe(5939);
    expect(leido.total_matches).toBe(true);
  });

  siOCR('sin el catálogo cargado, lee igual pero no propone insumo', async () => {
    const leido = await ocr.readReceipt(pool, { nightclubId: club.id, imagePath: FIXTURE });
    expect(leido.lines).toHaveLength(5);
    expect(leido.lines.filter((l) => l.supply_id).length).toBe(0);
    expect(leido.lines.every((l) => l.confidence === 'low')).toBe(true);
  });

  siOCR('lee un ticket térmico curvado y torcido, con el renglón partido', async () => {
    // La prueba que faltaba. Todo lo que se había probado eran facturas anchas de hoja
    // carta, generadas limpias: por eso esto llegó al club roto.
    const texto = await ocr.ocrText(TICKET);
    const renglones = ocr.parseReceipt(texto);

    // Cuatro de los cinco productos salen completos y con la cuenta comprobada. El
    // quinto pierde sus cifras en la foto —el papel está gastado ahí— y sale MARCADO,
    // que es lo correcto: se teclea a mano, no se inventa.
    const cuadran = renglones.filter((l) => l.math === 'ok');
    expect(cuadran.length).toBeGreaterThanOrEqual(4);
    expect(cuadran[0]).toMatchObject({ quantity: 6, unit_cost: 1150, line_total: 6900 });
    expect(renglones.every((l) => l.math === 'ok' || l.confidence !== 'high')).toBe(true);

    // Y ningún renglón del pie se coló como producto.
    const nombres = renglones.map((l) => ocr.norm(l.description));
    expect(nombres.filter((n) => /total|iva|gracias/.test(n))).toEqual([]);

    // El subtotal impreso se encuentra aunque venga partido en dos renglones.
    expect(ocr.documentTotals(ocr.joinWrappedLines(texto)).subtotal).toBe(27876);
  });

  it('dice claramente cuando el programa no está instalado', async () => {
    // El mensaje importa: un despliegue sin Tesseract y una foto ilegible se ven
    // igual desde la pantalla, y se arreglan de formas muy distintas.
    const antes = process.env.TESSERACT_BIN;
    process.env.TESSERACT_BIN = '/usr/bin/no-existe-tesseract';
    try {
      await expect(ocr.ocrText(FIXTURE)).rejects.toThrow(/no está instalado/);
    } finally {
      if (antes === undefined) delete process.env.TESSERACT_BIN;
      else process.env.TESSERACT_BIN = antes;
    }
  });
});

// ============================================================ guardar el archivo

describe('Guardar la imagen', () => {
  const buffer = Buffer.from('una foto cualquiera');

  it('el nombre sale del contenido, no del teléfono', () => {
    const checksum = ocr.checksumOf(buffer);
    const ruta = ocr.storagePath({
      nightclubId: '11111111-1111-1111-1111-111111111111',
      checksum,
      mimeType: 'image/jpeg',
      now: new Date('2026-09-15T22:00:00Z'),
    });
    // Por club y por día: sin eso, un club que recibe tres veces por semana acaba con
    // un directorio de miles de archivos que nadie puede revisar.
    expect(ruta).toBe(path.join('11111111-1111-1111-1111-111111111111', '2026-09-15',
      `${checksum.slice(0, 16)}.jpg`));
  });

  it('la misma foto da el mismo checksum, y una distinta no', () => {
    expect(ocr.checksumOf(buffer)).toBe(ocr.checksumOf(Buffer.from('una foto cualquiera')));
    expect(ocr.checksumOf(buffer)).not.toBe(ocr.checksumOf(Buffer.from('otra foto')));
  });

  it('rechaza lo que no es una imagen que se pueda leer', () => {
    expect(() => ocr.checkUpload(null)).toThrow(/ninguna imagen/);
    expect(() => ocr.checkUpload({ buffer: Buffer.alloc(0), mimetype: 'image/jpeg' }))
      .toThrow(/ninguna imagen/);
    expect(() => ocr.checkUpload({ buffer, mimetype: 'application/pdf' }))
      .toThrow(/no se puede leer/);
    expect(() => ocr.checkUpload({ buffer: Buffer.alloc(ocr.MAX_BYTES + 1), mimetype: 'image/jpeg' }))
      .toThrow(/pesa más/);
    expect(() => ocr.checkUpload({ buffer, mimetype: 'image/jpeg' })).not.toThrow();
  });
});
