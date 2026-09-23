/**
 * EV2 — armar el papel que sale de una impresora térmica (D52).
 *
 * ---------------------------------------------------------------------------
 * Qué es ESC/POS y por qué no basta con mandar texto
 * ---------------------------------------------------------------------------
 * Una impresora térmica no recibe un documento: recibe un chorro de bytes donde el
 * texto va mezclado con comandos de una o tres letras —negritas, centrado, doble
 * alto, cortar el papel—. Mandarle una cadena de JavaScript tal cual saca las
 * palabras, pero todo del mismo tamaño, pegado a la izquierda y sin cortar: el
 * ticket queda colgando hasta que alguien lo arranca con la mano.
 *
 * ---------------------------------------------------------------------------
 * Los acentos son el problema de verdad
 * ---------------------------------------------------------------------------
 * Estas impresoras no saben nada de UTF-8. Trabajan con **páginas de códigos**: una
 * tabla de 256 caracteres que se escoge con un comando, y a partir de ahí el byte
 * 0xA4 significa lo que esa tabla diga. Las Xprinter salen de fábrica en CP437, que
 * **no tiene ñ** ni vocales acentuadas: "Coñac añejo" sale como "Co?ac a?ejo", y eso
 * es lo primero que se ve en un ticket de un bar mexicano.
 *
 * Por eso aquí hay una tabla por página de códigos, y una regla para lo que no
 * aparezca en ninguna: **se pliega a su letra sin acento** (á→a, ñ→n). Un ticket que
 * dice "Conac anejo" es feo; uno que dice "Co\xA4ac a\xA5ejo" en la página
 * equivocada es basura ilegible. Entre feo e ilegible, feo.
 *
 * ---------------------------------------------------------------------------
 * Por qué se arma dos veces
 * ---------------------------------------------------------------------------
 * `build()` devuelve los bytes **y** el mismo ticket en texto plano. El texto se
 * guarda junto al trabajo de impresión y es lo que se ve en pantalla al reimprimir y
 * lo que se lee cuando alguien reclama que el papel salió mal. Diagnosticar un
 * ticket descifrando bytes a mano es tiempo que nadie tiene a las tres de la mañana.
 */
'use strict';

// ---------------------------------------------------------------- comandos

const ESC = 0x1b;
const GS = 0x1d;

const CMD = {
  init: Buffer.from([ESC, 0x40]),
  lf: Buffer.from([0x0a]),
  boldOn: Buffer.from([ESC, 0x45, 1]),
  boldOff: Buffer.from([ESC, 0x45, 0]),
  left: Buffer.from([ESC, 0x61, 0]),
  center: Buffer.from([ESC, 0x61, 1]),
  right: Buffer.from([ESC, 0x61, 2]),
  // GS ! n — los cuatro bits altos son el ancho y los cuatro bajos el alto.
  size: (w, h) => Buffer.from([GS, 0x21, ((w - 1) << 4) | (h - 1)]),
  // GS V 66 n — corte parcial dejando `n` puntos de avance, que es lo que deja el
  // papel a la altura del diente. El corte total deja el ticket suelto en el piso.
  cut: Buffer.from([GS, 0x56, 0x42, 0x00]),
  feed: (n) => Buffer.from([ESC, 0x64, n]),
};

/**
 * El número de página de códigos de cada tabla, como lo entiende `ESC t n`.
 *
 * No están todas las que existen: están las que sirven para español y las que estas
 * impresoras traen de fábrica.
 */
const CODEPAGES = {
  CP437: 0,
  CP850: 2,
  CP860: 3,
  CP858: 19,
  CP1252: 16,
};

/**
 * Dónde vive cada carácter del español en cada tabla.
 *
 * Solo van los que no son ASCII: todo lo demás ya coincide. CP437 no tiene vocales
 * acentuadas en mayúscula —no es un olvido, no existen en esa tabla—, así que ahí
 * caen al plegado sin acento, que es lo correcto y lo único posible.
 */
const HIGH_CHARS = {
  CP437: {
    á: 0xa0, é: 0x82, í: 0xa1, ó: 0xa2, ú: 0xa3, ñ: 0xa4, Ñ: 0xa5, ü: 0x81,
    '¿': 0xa8, '¡': 0xad, '°': 0xf8, '«': 0xae, '»': 0xaf,
  },
  CP850: {
    á: 0xa0, é: 0x82, í: 0xa1, ó: 0xa2, ú: 0xa3, ñ: 0xa4, Ñ: 0xa5, ü: 0x81,
    Á: 0xb5, É: 0x90, Í: 0xd6, Ó: 0xe0, Ú: 0xe9, Ü: 0x9a,
    '¿': 0xa8, '¡': 0xad, '°': 0xf8, '«': 0xae, '»': 0xaf,
  },
  CP860: {
    á: 0xa0, é: 0x82, í: 0xa1, ó: 0xa2, ú: 0xa3, ñ: 0xa4, Ñ: 0xa5, ü: 0x81,
    Á: 0x86, É: 0x89, Í: 0x8b, Ó: 0x9f, Ú: 0x96,
    '¿': 0xa8, '¡': 0xad, '°': 0xf8,
  },
  CP1252: {
    á: 0xe1, é: 0xe9, í: 0xed, ó: 0xf3, ú: 0xfa, ñ: 0xf1, Ñ: 0xd1, ü: 0xfc,
    Á: 0xc1, É: 0xc9, Í: 0xcd, Ó: 0xd3, Ú: 0xda, Ü: 0xdc,
    '¿': 0xbf, '¡': 0xa1, '°': 0xb0, '«': 0xab, '»': 0xbb, '€': 0x80,
  },
};
HIGH_CHARS.CP858 = { ...HIGH_CHARS.CP850, '€': 0xd5 };

/** La letra sin acento, para cuando la tabla escogida no tiene la de verdad. */
const FOLD = {
  á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u', ñ: 'n',
  Á: 'A', É: 'E', Í: 'I', Ó: 'O', Ú: 'U', Ü: 'U', Ñ: 'N',
  à: 'a', è: 'e', ì: 'i', ò: 'o', ù: 'u', â: 'a', ê: 'e', î: 'i', ô: 'o', û: 'u',
  ç: 'c', Ç: 'C', '¿': '?', '¡': '!', '°': 'o', '«': '"', '»': '"',
  '€': 'EUR', '–': '-', '—': '-', '“': '"', '”': '"', '‘': "'", '’': "'", '…': '...',
};

/**
 * El texto, ya en bytes de la página de códigos pedida.
 *
 * Todo lo que no esté en la tabla ni en el plegado se cambia por un espacio en vez
 * de por un byte al azar: un emoji en el nombre de un trago no debe sacar un
 * carácter de control que deje la impresora en un modo raro para el resto del papel.
 */
function encode(text, codepage) {
  const tabla = HIGH_CHARS[codepage] || HIGH_CHARS.CP850;
  const out = [];
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code === 0x0a) { out.push(0x0a); continue; }
    if (code >= 0x20 && code <= 0x7e) { out.push(code); continue; }
    if (Object.prototype.hasOwnProperty.call(tabla, ch)) { out.push(tabla[ch]); continue; }
    const plegado = FOLD[ch];
    if (plegado) {
      for (const c of plegado) out.push(c.charCodeAt(0));
      continue;
    }
    out.push(0x20);
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------- acomodar texto

/**
 * Cambia por adelantado lo que al imprimirse ocupa MÁS de un carácter.
 *
 * `€` se pliega a `EUR` y `…` a `...` cuando la tabla no los tiene: tres caracteres
 * donde el código contó uno. Si eso pasara al final, la línea saldría dos columnas
 * más larga que el papel y el importe se iría al renglón de abajo. Se resuelve
 * aquí, antes de medir, y así lo que se cuenta es lo que de verdad sale.
 */
function normalize(text, codepage) {
  const tabla = HIGH_CHARS[codepage] || HIGH_CHARS.CP850;
  let out = '';
  for (const ch of String(text)) {
    const plegado = FOLD[ch];
    if (plegado && plegado.length > 1 && !Object.prototype.hasOwnProperty.call(tabla, ch)) {
      out += plegado;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Corta una palabra que no cabe ni sola en una línea. Sin esto se pierde el resto. */
function hardSplit(word, width) {
  const trozos = [];
  let resto = word;
  while (resto.length > width) {
    trozos.push(resto.slice(0, width));
    resto = resto.slice(width);
  }
  if (resto) trozos.push(resto);
  return trozos;
}

/** Parte un texto en líneas de `width`, respetando las palabras cuando se puede. */
function wrap(text, width) {
  const lineas = [];
  for (const parrafo of String(text).split('\n')) {
    let actual = '';
    for (const palabra of parrafo.split(/\s+/).filter(Boolean)) {
      if (palabra.length > width) {
        if (actual) { lineas.push(actual); actual = ''; }
        const trozos = hardSplit(palabra, width);
        lineas.push(...trozos.slice(0, -1));
        actual = trozos[trozos.length - 1];
      } else if (!actual) {
        actual = palabra;
      } else if (actual.length + 1 + palabra.length <= width) {
        actual += ` ${palabra}`;
      } else {
        lineas.push(actual);
        actual = palabra;
      }
    }
    lineas.push(actual);
  }
  return lineas;
}

/**
 * Izquierda y derecha en la misma línea, con el relleno en medio.
 *
 * Si no caben, la que se recorta es la izquierda: el nombre del trago se puede
 * adivinar, el importe no. Un ticket donde el total sale mocho no sirve para nada.
 */
function twoColumns(left, right, width) {
  const der = String(right);
  if (der.length >= width) return der.slice(-width);
  const espacio = width - der.length - 1;
  // Se recorta con un punto y no con «…»: los puntos suspensivos no existen en
  // CP850 ni en CP437 y se plegarían a tres caracteres, justo los que no caben.
  const izq = String(left).length > espacio
    ? `${String(left).slice(0, Math.max(0, espacio - 1))}.`
    : String(left);
  return izq + ' '.repeat(width - izq.length - der.length) + der;
}

// ---------------------------------------------------------------- el constructor

/**
 * Arma un ticket. Se van apilando instrucciones y `build()` las convierte a la vez
 * en bytes para la impresora y en texto plano para la pantalla y para el archivo.
 *
 *   ticket({ columns: 48 })
 *     .center().big('EV2 CLANDESTINOZ').normal()
 *     .rule().left()
 *     .row('2  Mezcal', '$360.00')
 *     .cut()
 *     .build()
 */
function ticket(opts = {}) {
  const width = Number(opts.columns) || 48;
  const codepage = CODEPAGES[opts.codepage] !== undefined ? opts.codepage : 'CP850';
  const hasCutter = opts.hasCutter !== false;
  const pasos = [];

  const api = {
    /** Una línea de texto, partida sola si no cabe. */
    line(text = '') {
      for (const l of wrap(normalize(text, codepage), width)) pasos.push({ t: 'text', text: l });
      return api;
    },
    /** Texto sin partir ni acomodar: para lo que ya viene medido. */
    raw(text = '') { pasos.push({ t: 'text', text: normalize(text, codepage) }); return api; },
    /** Etiqueta a la izquierda, importe a la derecha. */
    row(left, right) {
      const linea = twoColumns(normalize(left, codepage), normalize(right, codepage), width);
      pasos.push({ t: 'text', text: linea });
      return api;
    },
    blank(n = 1) { for (let i = 0; i < n; i += 1) pasos.push({ t: 'text', text: '' }); return api; },
    rule(ch = '-') { pasos.push({ t: 'text', text: ch.repeat(width) }); return api; },

    left() { pasos.push({ t: 'align', v: 'left' }); return api; },
    center() { pasos.push({ t: 'align', v: 'center' }); return api; },
    right() { pasos.push({ t: 'align', v: 'right' }); return api; },

    bold(text) {
      pasos.push({ t: 'bold', v: true });
      if (text !== undefined) api.line(text).boldOff();
      return api;
    },
    boldOff() { pasos.push({ t: 'bold', v: false }); return api; },

    /** Doble alto y doble ancho: el total, y nada más que el total. */
    big(text) {
      pasos.push({ t: 'size', w: 2, h: 2 });
      if (text !== undefined) { api.line(text); pasos.push({ t: 'size', w: 1, h: 1 }); }
      return api;
    },
    /** Doble alto a ancho normal: cabe el doble de texto y se sigue leyendo de lejos. */
    tall(text) {
      pasos.push({ t: 'size', w: 1, h: 2 });
      if (text !== undefined) { api.line(text); pasos.push({ t: 'size', w: 1, h: 1 }); }
      return api;
    },
    normal() { pasos.push({ t: 'size', w: 1, h: 1 }); return api; },

    cut() { pasos.push({ t: 'cut' }); return api; },

    /** Las columnas de esta impresora, para quien arme un renglón a mano. */
    get width() { return width; },

    build() {
      const bytes = [CMD.init, Buffer.from([ESC, 0x74, CODEPAGES[codepage]])];
      const texto = [];
      // El texto plano no tiene centrado ni negritas, pero sí tiene que quedar en el
      // mismo sitio que en el papel: por eso se centra a mano al renderizarlo.
      let align = 'left';
      let ancho = 1;
      for (const p of pasos) {
        if (p.t === 'text') {
          bytes.push(encode(p.text, codepage), CMD.lf);
          const util = Math.floor(width / ancho);
          if (p.text === '') {
            // Una línea vacía es una línea vacía: centrarla dejaría medio renglón de
            // espacios, y eso ensucia el texto que se guarda y se enseña en pantalla.
            texto.push('');
          } else if (align === 'center') {
            texto.push(' '.repeat(Math.max(0, Math.floor((width - p.text.length * ancho) / 2))) + p.text);
          } else if (align === 'right') {
            texto.push(' '.repeat(Math.max(0, width - p.text.length * ancho)) + p.text);
          } else {
            texto.push(p.text.slice(0, util * ancho));
          }
        } else if (p.t === 'align') {
          align = p.v;
          bytes.push(p.v === 'center' ? CMD.center : p.v === 'right' ? CMD.right : CMD.left);
        } else if (p.t === 'bold') {
          bytes.push(p.v ? CMD.boldOn : CMD.boldOff);
        } else if (p.t === 'size') {
          ancho = p.w;
          bytes.push(CMD.size(p.w, p.h));
        } else if (p.t === 'cut') {
          // El avance antes del corte es lo que saca el texto de abajo de la cuchilla.
          bytes.push(CMD.feed(4));
          if (hasCutter) bytes.push(CMD.cut);
          texto.push('');
        }
      }
      return { bytes: Buffer.concat(bytes), text: texto.join('\n') };
    },
  };
  return api;
}

/**
 * El ticket de prueba: lo que se imprime para saber si una impresora recién dada de
 * alta está bien configurada.
 *
 * Trae a propósito las tres cosas que fallan: los acentos y la ñ (página de códigos
 * equivocada), la regla de ancho completo (columnas mal puestas) y el corte. Si el
 * papel sale con las tres bien, esa impresora ya sirve para lo demás.
 */
function testTicket({ clubName, printerName, purpose, columns, codepage, hasCutter }) {
  const t = ticket({ columns, codepage, hasCutter });
  t.center().bold().tall('PRUEBA DE IMPRESION').normal().boldOff();
  t.line(clubName || 'EV2').blank();
  t.left().rule();
  t.row('Impresora', printerName || '—');
  t.row('Para', purpose === 'orders' ? 'Comandas (barra)' : 'Cuentas y recibos');
  t.row('Ancho', `${columns} columnas`);
  t.row('Codigos', codepage);
  t.rule();
  t.line('Acentos y enes: Coñac añejo, piña, jamón,');
  t.line('¿está bien? ¡Sí! Más allá: ÁÉÍÓÚ ÑÜ');
  t.rule();
  t.row('Si esta linea llega al borde', 'OK');
  t.blank();
  t.center().line(new Date().toISOString().slice(0, 19).replace('T', ' '));
  t.blank(2).cut();
  return t.build();
}

module.exports = {
  CODEPAGES, HIGH_CHARS, FOLD, encode, wrap, twoColumns, ticket, testTicket,
};
