/**
 * Leer la foto de un ticket o una factura, y proponer los renglones de la entrada.
 *
 * Lo que este archivo NO es
 * -------------------------
 * No es una forma de dar entrada a mercancía. Ni un renglón de aquí toca el
 * inventario: todo sale como PROPUESTA y una persona la revisa renglón por renglón
 * antes de guardar. La razón es simple y se ve en cualquier ticket térmico real: la
 * impresora se está acabando, el papel se arruga, y el reconocimiento lee "l" donde
 * dice "1" y confunde un 8 con un 3. Un inventario que se llena solo con eso miente
 * con más confianza que uno vacío.
 *
 * Lo que sí hace, y por qué vale la pena
 * --------------------------------------
 * Quince renglones tecleados de pie, a la hora que llega el camión, con una caja en
 * la otra mano, es lo que hace que a la tercera entrega ya nadie capture nada. Leer
 * la foto y pre-llenar esos quince renglones convierte veinte minutos de teclado en
 * dos de revisión. Y la foto queda guardada como comprobante, que vale por sí solo
 * aunque el reconocimiento falle por completo.
 *
 * ---------------------------------------------------------------------------
 * La comprobación que hace útil todo esto
 * ---------------------------------------------------------------------------
 * `cantidad × precio unitario = importe` es la única forma de saber, sin ver la foto,
 * si un número se leyó mal. Un ticket que dice 6 × 25.50 = 153.00 se comprueba solo;
 * si el OCR leyó 8 en vez de 6, la cuenta no cuadra y el renglón sale marcado para
 * que quien captura lo mire. Sin esa cuenta, un dígito mal leído entra silencioso y
 * el costo promedio de ese insumo queda envenenado para siempre.
 *
 * ---------------------------------------------------------------------------
 * Por qué Tesseract y no un servicio en la nube
 * ---------------------------------------------------------------------------
 * Decisión del dueño (D45). Un servicio en la nube lee mejor los tickets térmicos
 * —bastante mejor—, pero manda la factura del club a un tercero y cobra por hoja. Se
 * queda en el servidor. Lo que se pierde en precisión se compensa con la revisión
 * obligatoria, que de todos modos tenía que existir.
 */
'use strict';

const { execFile } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs/promises');

const { ApiError } = require('../middleware/errors');

/**
 * El programa. Se lee en cada llamada, no al cargar el módulo: así se puede apuntar a
 * otro binario —o a uno que no existe, para probar el mensaje de error— sin tener que
 * reiniciar el proceso.
 */
const tesseractBin = () => process.env.TESSERACT_BIN || 'tesseract';

/**
 * Español primero, inglés de respaldo.
 *
 * Las facturas mexicanas traen "CANTIDAD", "DESCRIPCIÓN", "IMPORTE", y con el modelo
 * inglés solo la acentuada ya se lee mal. Pero muchas marcas y presentaciones vienen
 * en inglés ("DRY GIN", "BLUE LABEL"), así que van los dos: Tesseract acepta la lista
 * y usa el que mejor explique cada palabra.
 */
const LANGS = process.env.TESSERACT_LANGS || 'spa+eng';

/** Un ticket largo tarda; más de esto es que algo se atoró. */
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 45000);

const MAX_BYTES = Number(process.env.RECEIPT_MAX_BYTES || 12 * 1024 * 1024);

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

/** Cuántos renglones se proponen como máximo. Coincide con el tope de la captura. */
const MAX_LINES = 100;

/**
 * La MISMA normalización que `ev2_norm()` en la migración 024.
 *
 * Si una cambia sin la otra, el parecido por trigramas deja de servir en silencio:
 * sigue devolviendo resultados, solo que peores.
 */
function norm(value) {
  return String(value === null || value === undefined ? '' : value)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------- leer la imagen

/**
 * Pasa la imagen por Tesseract y devuelve el texto.
 *
 * `--psm 6` ("un bloque uniforme de texto") y no el automático: el automático trata
 * de encontrar columnas y en un ticket angosto parte los renglones a la mitad, que es
 * justo lo que no se puede perder —la cantidad se va de un renglón y el importe se
 * queda en otro—.
 *
 * `-c preserve_interword_spaces=1` mantiene los espacios largos entre columnas, que
 * es la única pista de dónde acaba la descripción y empiezan los números.
 */
function ocrText(imagePath, { langs = LANGS, timeoutMs = OCR_TIMEOUT_MS } = {}) {
  const args = [imagePath, 'stdout', '-l', langs, '--psm', '6',
    '-c', 'preserve_interword_spaces=1'];
  const bin = tesseractBin();
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) { resolve(String(stdout || '')); return; }
        // Cada falla se distingue, porque se arreglan de formas distintas: un
        // programa que no está instalado es un despliegue incompleto; un idioma que
        // falta es un paquete; un timeout es una foto de veinte megapíxeles.
        if (err.code === 'ENOENT') {
          reject(new Error('Tesseract no está instalado en el servidor '
            + `(se buscó "${bin}")`));
          return;
        }
        if (err.killed || err.signal) {
          reject(new Error(`La lectura tardó más de ${Math.round(timeoutMs / 1000)}s`));
          return;
        }
        const detalle = String(stderr || err.message || '').trim().split('\n')[0];
        if (/failed loading language|Could not initialize tesseract/i.test(detalle)) {
          reject(new Error(`Falta el idioma "${langs}" en el servidor: ${detalle}`));
          return;
        }
        reject(new Error(detalle || 'Tesseract falló sin decir por qué'));
      });
  });
}

// ---------------------------------------------------------------- leer los números

/**
 * Renglones que NO son mercancía.
 *
 * Un "SUBTOTAL 1,680.00" leído como renglón es una entrada de 1,680 piezas de algo
 * llamado subtotal. Se descartan por lo que dicen, no por dónde están: el pie de un
 * ticket térmico no siempre está al final —la foto sale torcida y el orden cambia—.
 */
const NOT_A_LINE = new RegExp([
  'sub\\s*total', '\\btotal\\b', '\\biva\\b', 'i\\.v\\.a', '\\bieps\\b', 'impuesto',
  '\\brfc\\b', 'r\\.f\\.c', 'regimen', 'folio', '\\buuid\\b', 'certificad',
  'factura', '\\bcfdi\\b', 'sello', 'cadena original', 'timbre',
  'descuento', 'anticipo', 'saldo', 'forma de pago', 'metodo de pago',
  'efectivo', 'tarjeta', 'cambio', 'propina', 'redondeo',
  'cantidad\\s+descripcion', 'cant\\.?\\s+desc', 'p\\.?\\s*unitario\\s+importe',
  'clave\\s+unidad', 'gracias por su compra', 'atendio', 'caja\\b', 'ticket',
  // El encabezado de la factura: razón social del proveedor y datos del cliente.
  's\\.?a\\.? de c\\.?v', '\\bs\\.? de r\\.?l', '\\bcliente\\b', '\\bproveedor\\b',
  'telefono', 'direccion', 'calle', 'colonia', 'c\\.p\\.', '\\bcp\\b\\s*\\d{5}',
].join('|'), 'i');

/** Una cifra de dinero: 1,800.00 · 1.800,00 · 900.00 · 25.5 · 153 */
const MONEY = /\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/g;

/**
 * Convierte "1,800.00" o "1.800,00" a 1800 sin adivinar mal.
 *
 * El separador de MILES es el que aparece con tres dígitos justos después; el otro es
 * el decimal. Si solo hay uno y trae tres dígitos detrás, es miles ("1,800" = 1800),
 * porque un precio con tres decimales en una factura de bebidas no existe.
 */
function toNumber(raw) {
  const s = String(raw).trim();
  if (!/\d/.test(s)) return null;
  const coma = s.lastIndexOf(',');
  const punto = s.lastIndexOf('.');
  let limpio;
  if (coma >= 0 && punto >= 0) {
    const decimal = coma > punto ? ',' : '.';
    const miles = decimal === ',' ? '.' : ',';
    limpio = s.split(miles).join('').replace(decimal, '.');
  } else if (coma >= 0 || punto >= 0) {
    const sep = coma >= 0 ? ',' : '.';
    const cola = s.slice(s.lastIndexOf(sep) + 1);
    limpio = cola.length === 3 ? s.split(sep).join('') : s.replace(sep, '.');
  } else {
    limpio = s;
  }
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

/**
 * Arregla las confusiones típicas del OCR, SOLO donde ya sabemos que hay un número.
 *
 * Hacerlo en todo el texto convertiría "COLA" en "C0LA" y arruinaría la descripción,
 * que es justo lo que sirve para encontrar el insumo. Aquí solo entran tokens que ya
 * son casi todo dígitos.
 */
function fixDigits(token) {
  // Sin un solo dígito de verdad, no hay nada que arreglar: "SOL" es una cerveza, no
  // el número 501, y "CORONA" no es un precio.
  if (!/\d/.test(token)) return token;
  const arreglado = token
    .replace(/[OoQ]/g, '0')
    .replace(/[lIi|]/g, '1')
    .replace(/[Ss]/g, '5')
    .replace(/[B]/g, '8');
  const digitos = (arreglado.match(/\d/g) || []).length;
  // Se acepta el arreglo solo si el token ERA mayormente numérico: "S" sola no es 5.
  return digitos >= 2 && digitos / arreglado.replace(/[.,]/g, '').length >= 0.6
    ? arreglado : token;
}

/** ¿La descripción tiene suficiente letra para poder buscarla en el catálogo? */
function hasWords(text) {
  const letras = (text.match(/[a-záéíóúñ]/gi) || []).length;
  return letras >= 3;
}

/** Dos cifras de dinero que deberían ser la misma, con la tolerancia del redondeo. */
const sameMoney = (a, b) => Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.005);

/** Cómo se ve una cifra de dinero completa, ya arreglada. Sobra o falta algo: no es. */
const MONEY_SHAPE = /^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?$|^\d+(?:[.,]\d{1,2})?$/;

/**
 * ¿Este token suelto es una cifra de dinero? Devuelve el número, o null.
 *
 * Acepta las confusiones del OCR —"9O0.00" por "900.00"— pero solo si el token YA
 * traía dígitos de verdad. Sin esa condición, "SOL" se arregla a "501" y una cerveza
 * Sol se convierte en un precio: el tipo de error que nadie encuentra después.
 */
function amountOf(token) {
  const limpio = String(token).replace(/^[$*|(]+|[)*|:;]+$/g, '').replace(/[.,]$/, '');
  if (!/\d/.test(limpio)) return null;
  const arreglado = fixDigits(limpio);
  if (!MONEY_SHAPE.test(arreglado)) return null;
  return toNumber(arreglado);
}

/** El renglón partido en palabras, con dónde empieza cada una. */
function tokenize(texto) {
  const out = [];
  const re = /\S+/g;
  let m = re.exec(texto);
  while (m) { out.push({ raw: m[0], at: m.index }); m = re.exec(texto); }
  return out;
}

/**
 * Un renglón del ticket → una propuesta de entrada.
 *
 * Devuelve null cuando el renglón no parece mercancía. Preferir null a una propuesta
 * dudosa es deliberado: un renglón de más que hay que borrar molesta más que uno de
 * menos que hay que teclear, porque el de más se puede guardar por descuido.
 */
function parseLine(raw) {
  const texto = String(raw).replace(/\s+/g, ' ').trim();
  if (texto.length < 4) return null;
  if (NOT_A_LINE.test(norm(texto))) return null;

  const tokens = tokenize(texto);
  if (tokens.length < 2) return null;

  // Los importes se buscan DESDE LA DERECHA, no como "los números que siguen a la
  // descripción". La diferencia importa: en "TEQUILA DON JULIO 70 750ML 900.00
  // 1,800.00" el 70 y el 750 son parte del NOMBRE —son justo lo que distingue un Don
  // Julio 70 de un Reposado—, y tomarlos por precios deja "TEQUILA DON JULIO", que se
  // parece igual a cuatro insumos distintos del catálogo.
  //
  // Se toman a lo más dos —unitario e importe— y se paran en la primera palabra que
  // no es una cifra completa. "355ML" no lo es, así que se queda en el nombre; una
  // tercera columna de la derecha (descuento, IEPS, acumulado) no se usa para dar
  // entrada y parar en dos la deja fuera sola.
  const hallados = [];
  const cortes = [];
  for (let i = tokens.length - 1; i >= 1 && hallados.length < 3; i -= 1) {
    const valor = amountOf(tokens[i].raw);
    if (valor === null) break;
    hallados.unshift(valor);
    cortes.unshift(i);
  }
  let importes = hallados.slice(-2);
  let corte = cortes.length ? cortes[cortes.length - importes.length] : tokens.length;

  // La cantidad: la primera palabra, si es un número y todavía queda descripción
  // detrás. Una factura mexicana pone la cantidad en la primera columna casi siempre.
  // "3 x WHISKY" y "2x CERVEZA" son la misma cosa escrita de dos formas.
  let inicio = 0;
  let quantity = null;
  const primero = amountOf(tokens[0].raw.replace(/x$/i, ''));
  if (primero !== null && primero > 0 && primero <= 9999 && corte > 1) {
    quantity = primero;
    inicio = 1;
    if (inicio < corte && /^x$/i.test(tokens[inicio].raw)) inicio += 1;
  }

  // Con TRES cifras a la derecha, la de más a la izquierda puede ser el unitario y la
  // última un acumulado —algunos tickets imprimen la columna corrida—, o puede ser
  // parte del nombre: "TOPO CHICO 600  18.00  216.00". La aritmética lo decide, que
  // es lo único que no se equivoca: si cantidad × la primera da la segunda, las dos
  // primeras son el precio y el nombre acaba antes; si no, la primera se queda en el
  // nombre, donde el 600 de la presentación tiene que estar.
  if (quantity && hallados.length === 3 && sameMoney(quantity * hallados[0], hallados[1])) {
    importes = hallados.slice(0, 2);
    [corte] = cortes;
  }

  // Un renglón sin cantidad Y sin importe no es mercancía: es el nombre del
  // proveedor, su dirección, o el pie del ticket. Sin esta regla, "DISTRIBUIDORA DEL
  // NOROESTE SA DE CV" entra como un insumo llamado así, y quien revisa tiene que
  // borrar tres renglones inventados antes de llegar a los suyos.
  if (importes.length === 0 && quantity === null) return null;

  const desc = tokens.slice(inicio, corte).map((tk) => tk.raw).join(' ')
    .replace(/^[\s.:,;|*-]+|[\s.:,;|*-]+$/g, '');
  if (!hasWords(desc)) return null;

  // El último importe es el de la línea, el anterior el unitario. Con uno solo no se
  // sabe cuál es, y la cuenta de `reconcile` lo decide.
  let unitCost = null;
  let lineTotal = null;
  if (importes.length === 2) { [unitCost, lineTotal] = importes; } else if (importes.length === 1) {
    [lineTotal] = importes;
  }

  return {
    text: texto,
    description: desc,
    quantity,
    unit_cost: unitCost,
    line_total: lineTotal,
  };
}

/**
 * La comprobación aritmética, que es de donde sale la confianza de verdad.
 *
 * Con cantidad, unitario e importe se puede saber si los tres se leyeron bien sin
 * mirar la foto. Cuando solo hay dos, se deduce el tercero y se dice que se dedujo:
 * un número calculado y uno leído no valen lo mismo y la pantalla los pinta distinto.
 */
function reconcile(line) {
  const { quantity: q, unit_cost: u, line_total: t } = line;
  if (q && u !== null && t !== null) {
    if (sameMoney(q * u, t)) return { ...line, math: 'ok' };
    // No cuadra. Antes de rendirse: en muchos tickets la cola trae [importe, total
    // acumulado] en vez de [unitario, importe]. Si el primero cuadra como unitario
    // al dividir, es eso.
    if (sameMoney(t / q, u)) return { ...line, math: 'ok' };
    return { ...line, math: 'mismatch' };
  }
  if (q && u !== null && t === null) {
    return { ...line, line_total: Number((q * u).toFixed(2)), math: 'derived_total' };
  }
  if (q && u === null && t !== null) {
    // Con UNA sola cifra no se sabe si es el precio unitario o el importe del
    // renglón, y las dos lecturas dan costos que se diferencian por la cantidad: si
    // "4 JUGO 22.00" son 22 cada uno y se guarda como 5.50, el costo promedio de ese
    // insumo queda envenenado cuatro veces a la baja y nadie lo nota hasta que el
    // margen del trago sale mal. Así que no se adivina: se marca y una persona teclea
    // el costo. Con cantidad 1 no hay ambigüedad —unitario e importe son el mismo
    // número— y sí se deduce.
    if (q === 1) return { ...line, unit_cost: t, math: 'derived_unit' };
    return { ...line, unit_cost: null, math: 'one_amount' };
  }
  if (!q && u !== null && t !== null && u > 0) {
    const veces = t / u;
    // Solo si sale una cantidad entera limpia: 153.00 / 25.50 = 6. Un 5.97 significa
    // que uno de los dos se leyó mal, y en ese caso no se inventa la cantidad.
    if (Math.abs(veces - Math.round(veces)) < 0.02 && Math.round(veces) >= 1) {
      return { ...line, quantity: Math.round(veces), math: 'derived_quantity' };
    }
  }
  return { ...line, math: 'incomplete' };
}

/** El texto completo → los renglones que parecen mercancía, ya comprobados. */
function parseReceipt(text) {
  const renglones = String(text || '').split(/\r?\n/);
  const out = [];
  for (const raw of renglones) {
    const line = parseLine(raw);
    if (line) out.push(reconcile(line));
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

/** La última cifra de un renglón del pie: "SUBTOTAL   5,939.00" → 5939. */
function footerAmount(raw) {
  const numeros = [...String(raw).matchAll(MONEY)].map((m) => toNumber(fixDigits(m[0])))
    .filter((n) => n !== null && n > 0);
  return numeros.length ? numeros[numeros.length - 1] : null;
}

/**
 * El pie del documento: subtotal, impuesto y total, los que aparezcan.
 *
 * Sirve para lo mismo que la cuenta por renglón, un nivel arriba: si la suma de los
 * renglones leídos no llega a lo impreso, se leyó de menos y falta mercancía. Es la
 * única forma de notar un renglón que el OCR se comió por completo.
 *
 * Los tres se leen por separado porque comparar contra el que no es da una alarma
 * falsa en cada factura con IVA: los renglones suman el SUBTOTAL, nunca el total.
 */
function documentTotals(text) {
  const out = { subtotal: null, tax: null, total: null };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const linea = norm(raw);
    if (/sub\s*total/.test(linea)) {
      out.subtotal = footerAmount(raw) ?? out.subtotal;
    } else if (/\biva\b|i\.v\.a|\bieps\b|impuesto/.test(linea)) {
      // "IVA 16% 950.24": el 16 es la tasa, no el impuesto. La última cifra es la
      // buena, y `footerAmount` se queda justo con esa.
      out.tax = footerAmount(raw) ?? out.tax;
    } else if (/\btotal\b/.test(linea)) {
      out.total = footerAmount(raw) ?? out.total;
    }
  }
  return out;
}

/**
 * Contra qué se compara la suma de los renglones.
 *
 * El subtotal si está; si no, el total menos el impuesto; y si el ticket no desglosa
 * nada —los térmicos casi nunca—, el total tal cual.
 */
function comparableTotal({ subtotal, tax, total }) {
  if (subtotal !== null) return subtotal;
  if (total !== null && tax !== null) return Number((total - tax).toFixed(2));
  return total;
}

/** El total impreso del documento, para mostrarlo. */
const documentTotal = (text) => documentTotals(text).total;

// ---------------------------------------------------------------- hallar el insumo

/**
 * Qué insumos del catálogo se parecen a lo que dice el renglón.
 *
 * El parecido es por trigramas y en dos formas, porque los tickets abrevian: el
 * parecido completo funciona cuando el nombre viene entero, y `word_similarity`
 * cuando el ticket trae un pedazo ("DON JULIO 70" dentro de "Tequila Don Julio 70
 * Añejo"). Se toma el mejor de los dos.
 *
 * El umbral es bajo a propósito (0.25): esto PROPONE, no decide, y una propuesta
 * mediocre que la persona descarta con un toque cuesta menos que buscar entre
 * ochocientos insumos a mano. Lo que no se hace nunca es elegir sola: `confident`
 * solo cuando hay un claro ganador, y la pantalla igual lo muestra para revisión.
 */
async function matchSupplies(client, { nightclubId, description, limit = 4 }) {
  const query = norm(description);
  if (query.length < 3) return [];
  const { rows } = await client.query(
    `SELECT id, name, unit, package_size::float8 AS package_size, package_label,
            avg_cost::float8 AS avg_cost,
            GREATEST(similarity(ev2_norm(name), $2),
                     word_similarity($2, ev2_norm(name)))::float8 AS score
       FROM supplies
      WHERE nightclub_id = $1
        AND active
        AND GREATEST(similarity(ev2_norm(name), $2),
                     word_similarity($2, ev2_norm(name))) >= 0.25
      ORDER BY score DESC, name
      LIMIT $3`,
    [nightclubId, query, limit],
  );
  return rows.map((r) => ({ ...r, score: Number(r.score.toFixed(3)) }));
}

/**
 * ¿Son la misma palabra? Con la abreviatura del ticket contando como la palabra larga.
 *
 * "TEQ" por "TEQUILA" y "BLCO" por "BLANCO" es como escribe un proveedor, así que se
 * acepta que una sea prefijo de la otra, con tres letras mínimo para que "DE" no
 * empareje con medio catálogo.
 *
 * Los números, EXACTOS. Sin esta excepción "12" sería prefijo de "1234", y un Whisky
 * Buchannans 12 emparejaría con cualquier cosa que traiga un 12 adelante — que es
 * justo el error que esta función existe para no cometer.
 */
function sameToken(a, b) {
  if (a === b) return true;
  if (/^\d+$/.test(a) || /^\d+$/.test(b)) return false;
  const [corto, largo] = a.length <= b.length ? [a, b] : [b, a];
  return corto.length >= 3 && largo.startsWith(corto);
}

const words = (value) => norm(value).split(/[^a-z0-9]+/).filter((w) => w.length > 0);

/**
 * ¿Aparece el nombre COMPLETO del insumo en lo que dice el renglón?
 *
 * Es la señal que de verdad distingue una botella de otra, y funciona donde el
 * parecido por trigramas se queda corto. El ticket dice "TEQ DON JULIO 70 690ML":
 * "Tequila Don Julio 70" está entero ahí dentro, mientras que "Tequila Don Julio
 * Reposado" trae un "reposado" que el papel NO menciona. Los trigramas ven las dos
 * casi igual —comparten casi todas las letras— y por eso hacía falta esto.
 */
const nameCovered = (candidateName, description) => {
  const necesarias = words(candidateName);
  const dichas = words(description);
  return necesarias.length > 0
    && necesarias.every((n) => dichas.some((h) => sameToken(n, h)));
};

/**
 * ¿Se puede dar por bueno el insumo propuesto?
 *
 * Dos caminos, y el primero es el bueno:
 *
 *  1. **Un solo insumo cuyo nombre completo está en el renglón.** Con el catálogo real
 *     del club esto resuelve los casos que el puntaje no podía: "VODKA ABSOLUT 750ML"
 *     contra seis Absolut de sabores empata al 0.70 por trigramas, pero solo uno
 *     —"VODKA ABSOLUT"— no menciona un sabor que el papel no dice.
 *  2. Si no, el puntaje: el primero tiene que parecerse bastante Y ganarle claro al
 *     segundo.
 *
 * Cuando ninguno gana, se devuelve `confident: false` y el renglón se queda SIN
 * insumo. "TEQUILA DON JULIO", sin número, entre un 70 y un Reposado es exactamente el
 * caso en que elegir mete la botella equivocada al estante, y el error no se descubre
 * hasta el conteo.
 */
function bestMatch(candidates, description = null) {
  const list = candidates || [];
  if (list.length === 0) return { supply: null, confident: false };
  if (description) {
    const cubiertos = list.filter((c) => nameCovered(c.name, description));
    if (cubiertos.length === 1) return { supply: cubiertos[0], confident: true };
  }
  const [first, second] = list;
  const claro = !second || (first.score - second.score) >= 0.12;
  return { supply: first, confident: first.score >= 0.45 && claro };
}

/**
 * Qué tan fiable es el renglón completo, en una palabra.
 *
 * La pantalla pinta `high` en verde y lo demás en ámbar, y ordena los dudosos
 * primero: es lo que hace que la revisión tarde dos minutos en vez de veinte.
 */
function lineConfidence(line, match) {
  if (!match.confident) return 'low';
  if (line.math === 'ok' && line.quantity) return 'high';
  if (line.math === 'mismatch' || line.math === 'incomplete') return 'low';
  return 'medium';
}

/**
 * De la foto a las propuestas. Es la única función que usa la ruta.
 *
 * Nunca lanza por un renglón malo: devuelve lo que se pudo leer y deja el resto en
 * `null` para que una persona lo llene. Si lo que falla es Tesseract entero, eso sí
 * sube, porque significa que la foto no se leyó y hay que decirlo.
 */
async function readReceipt(client, { nightclubId, imagePath, langs }) {
  const text = await ocrText(imagePath, langs ? { langs } : {});
  const renglones = parseReceipt(text);

  const lines = [];
  for (const line of renglones) {
    // En serie y no en paralelo: son quince consultas cortas contra un índice, y
    // quince conexiones simultáneas por cada foto subida no valen los milisegundos.
    const candidates = await matchSupplies(client, { nightclubId, description: line.description });
    const match = bestMatch(candidates, line.description);
    lines.push({
      ...line,
      supply_id: match.confident ? match.supply.id : null,
      supply_name: match.confident ? match.supply.name : null,
      candidates,
      confidence: lineConfidence(line, match),
    });
  }

  const pie = documentTotals(text);
  const contra = comparableTotal(pie);
  const suma = lines.reduce((acc, l) => acc + (l.line_total || 0), 0);

  return {
    text,
    lines,
    document_total: pie.total,
    document_subtotal: pie.subtotal,
    document_tax: pie.tax,
    lines_total: Number(suma.toFixed(2)),
    // Cuando lo impreso no coincide con la suma de los renglones, falta o sobra
    // mercancía leída. Es la única forma de notar un renglón que se comió el OCR, y la
    // pantalla lo avisa arriba, antes de que alguien guarde. Se compara contra el
    // subtotal —no contra el total— porque los renglones no traen el IVA.
    compared_against: contra,
    total_matches: contra === null ? null : sameMoney(suma, contra),
    read_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- el archivo

/** El nombre con el que se guarda: por club y por día, para poder encontrarlo. */
function storagePath({ nightclubId, checksum, mimeType, now = new Date() }) {
  const ext = ({
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif',
  })[mimeType] || 'bin';
  const day = now.toISOString().slice(0, 10);
  return path.join(nightclubId, day, `${checksum.slice(0, 16)}.${ext}`);
}

const checksumOf = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** Revisa la subida antes de escribir nada en disco. */
function checkUpload(file) {
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw ApiError.unprocessable('No llegó ninguna imagen');
  }
  if (!ALLOWED_MIME.has(file.mimetype)) {
    throw ApiError.unprocessable(`Ese tipo de archivo no se puede leer (${file.mimetype}). `
      + 'Manda una foto en JPG o PNG.');
  }
  if (file.buffer.length > MAX_BYTES) {
    throw ApiError.unprocessable(`La imagen pesa más de ${Math.round(MAX_BYTES / (1024 * 1024))} MB`);
  }
}

/**
 * Guarda la imagen en disco y devuelve su ruta relativa.
 *
 * Relativa a `RECEIPTS_DIR` a propósito: mover el volumen a otro disco no debe
 * invalidar cada renglón de `receipt_photos`.
 */
async function storeImage({ baseDir, nightclubId, file, now }) {
  const checksum = checksumOf(file.buffer);
  const relative = storagePath({ nightclubId, checksum, mimeType: file.mimetype, now });
  const absolute = path.join(baseDir, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, file.buffer);
  return { checksum, relative, absolute, bytes: file.buffer.length };
}

module.exports = {
  ALLOWED_MIME,
  MAX_BYTES,
  MAX_LINES,
  norm,
  toNumber,
  fixDigits,
  parseLine,
  parseReceipt,
  reconcile,
  documentTotal,
  documentTotals,
  comparableTotal,
  matchSupplies,
  sameToken,
  nameCovered,
  bestMatch,
  lineConfidence,
  ocrText,
  readReceipt,
  storagePath,
  checksumOf,
  checkUpload,
  storeImage,
};
