/**
 * El papel que sale de la impresora (D52).
 *
 * Dos cosas se prueban aquí, y las dos son las que de verdad rompen un ticket
 * térmico:
 *
 *   1. **Los acentos.** Estas impresoras no saben UTF-8. Si el byte no es el de la
 *      página de códigos configurada, "Coñac añejo" sale como basura. Se comprueban
 *      los bytes exactos, no que "no truene".
 *   2. **El ancho.** Una línea de 49 caracteres en un papel de 48 no se recorta: se
 *      dobla, y el importe del total aparece solo en el renglón de abajo. Se cuenta
 *      cada línea.
 */
'use strict';

const escpos = require('../src/services/escpos');

const ESC = 0x1b;
const GS = 0x1d;

describe('Los acentos, que es donde se nota la página de códigos', () => {
  it('pone el byte de CP850, no el de UTF-8', () => {
    // 'ñ' en UTF-8 son dos bytes (0xC3 0xB1); en CP850 es uno solo (0xA4). Mandar
    // los dos de UTF-8 saca dos caracteres raros en el papel.
    expect(escpos.encode('ñ', 'CP850').toString('hex')).toBe('a4');
    expect(escpos.encode('áéíóú', 'CP850').toString('hex')).toBe('a082a1a2a3');
    expect(escpos.encode('¿¡', 'CP850').toString('hex')).toBe('a8ad');
  });

  it('cada tabla pone su propio byte para la misma letra', () => {
    expect(escpos.encode('é', 'CP850').toString('hex')).toBe('82');
    expect(escpos.encode('é', 'CP1252').toString('hex')).toBe('e9');
  });

  it('lo que la tabla no tiene se pliega a la letra sin acento', () => {
    // CP437 no tiene vocales acentuadas en mayúscula. "ANEJO" es feo; un byte al
    // azar en su lugar deja la impresora escribiendo basura el resto del ticket.
    expect(escpos.encode('Á', 'CP437').toString('hex')).toBe('41'); // 'A'
    expect(escpos.encode('Ó', 'CP437').toString('hex')).toBe('4f'); // 'O'
    // Pero en CP850 sí existe, y ahí se usa la de verdad.
    expect(escpos.encode('Á', 'CP850').toString('hex')).toBe('b5');
  });

  it('un emoji no saca un carácter de control', () => {
    // Un byte por debajo de 0x20 en medio del texto es un COMANDO: dejaría la
    // impresora en un modo raro para todo lo que venga después.
    const bytes = escpos.encode('Mezcal 🍹 doble', 'CP850');
    for (const b of bytes) expect(b === 0x0a || b >= 0x20).toBe(true);
  });

  it('el comando de página de códigos va al principio, después del reset', () => {
    const { bytes } = escpos.ticket({ codepage: 'CP850' }).line('hola').build();
    expect([...bytes.slice(0, 5)]).toEqual([ESC, 0x40, ESC, 0x74, 2]);
    const mil = escpos.ticket({ codepage: 'CP1252' }).line('hola').build();
    expect([...mil.bytes.slice(2, 5)]).toEqual([ESC, 0x74, 16]);
  });
});

describe('El ancho del papel', () => {
  it('ninguna línea pasa de las columnas de esa impresora', () => {
    const t = escpos.ticket({ columns: 32 });
    t.line('Michelada preparada con clamato y camaron en vaso escarchado');
    t.row('Nombre larguisimo de un trago carisimo', '$1,200.00');
    t.rule();
    for (const l of t.build().text.split('\n')) expect(l.length).toBeLessThanOrEqual(32);
  });

  it('cuando no cabe, lo que se recorta es el nombre y nunca el importe', () => {
    const linea = escpos.twoColumns('Nombre larguisimo de un trago', '$1,200.00', 24);
    expect(linea).toHaveLength(24);
    expect(linea.endsWith('$1,200.00')).toBe(true);
  });

  it('lo que al imprimirse ocupa más de un carácter se cuenta antes de medir', () => {
    // '€' se pliega a 'EUR' en CP850: tres caracteres donde el código contó uno. Si
    // no se resolviera antes de medir, la línea saldría dos columnas más larga.
    const t = escpos.ticket({ columns: 24, codepage: 'CP850' });
    t.row('Propina €', '€50');
    const linea = t.build().text.split('\n')[0];
    expect(linea).toHaveLength(24);
    expect(linea).toContain('EUR');
  });

  it('una palabra más larga que el papel se parte en vez de perderse', () => {
    const partida = escpos.wrap('Supercalifragilisticoespialidoso', 10);
    expect(partida.join('')).toBe('Supercalifragilisticoespialidoso');
    for (const l of partida) expect(l.length).toBeLessThanOrEqual(10);
  });

  it('la línea en blanco queda en blanco, no llena de espacios', () => {
    const t = escpos.ticket({ columns: 48 });
    t.center().line('titulo').blank().line('pie');
    expect(t.build().text.split('\n')[1]).toBe('');
  });
});

describe('Los comandos del papel', () => {
  it('el corte va al final, con avance antes de la cuchilla', () => {
    const { bytes } = escpos.ticket().line('x').cut().build();
    const hex = bytes.toString('hex');
    expect(hex).toContain('1b6404'); // ESC d 4 — avanza para sacar el texto del filo
    expect(hex.endsWith('1d564200')).toBe(true); // GS V 66 0 — corte parcial
  });

  it('sin cortador no manda el comando de cortar', () => {
    const { bytes } = escpos.ticket({ hasCutter: false }).line('x').cut().build();
    expect(bytes.toString('hex')).not.toContain('1d5642');
  });

  it('el doble alto se apaga solo después del texto', () => {
    const { bytes } = escpos.ticket().big('TOTAL').line('resto').build();
    const hex = bytes.toString('hex');
    // GS ! 0x11 (doble ancho y alto) y luego GS ! 0x00 de vuelta a normal.
    expect(hex).toContain(Buffer.from([GS, 0x21, 0x11]).toString('hex'));
    expect(hex).toContain(Buffer.from([GS, 0x21, 0x00]).toString('hex'));
  });

  it('el texto que se guarda respeta el centrado, para que se lea igual en pantalla', () => {
    const t = escpos.ticket({ columns: 20 });
    t.center().line('EV2').left().line('abajo');
    const [primera, segunda] = t.build().text.split('\n');
    expect(primera).toBe(`${' '.repeat(8)}EV2`);
    expect(segunda).toBe('abajo');
  });
});

describe('El ticket de prueba', () => {
  const prueba = (over = {}) => escpos.testTicket({
    clubName: 'EV2 Clandestinoz',
    printerName: 'Barra baja · meseros',
    purpose: 'service',
    columns: 48,
    codepage: 'CP850',
    hasCutter: true,
    ...over,
  });

  it('trae acentos y ñ a propósito: son lo que se va a ver mal si está mal', () => {
    const { text } = prueba();
    expect(text).toContain('Coñac añejo');
    expect(text).toContain('ÁÉÍÓÚ');
  });

  it('dice para qué es esa impresora, para no confundir las cuatro del club', () => {
    expect(prueba({ purpose: 'orders' }).text).toContain('Comandas');
    expect(prueba({ purpose: 'service' }).text).toContain('Cuentas y recibos');
  });

  it('a 58 mm todo sigue cabiendo', () => {
    const { text } = prueba({ columns: 32 });
    for (const l of text.split('\n')) expect(l.length).toBeLessThanOrEqual(32);
  });

  it('termina cortando el papel', () => {
    expect(prueba().bytes.toString('hex').endsWith('1d564200')).toBe(true);
  });
});
