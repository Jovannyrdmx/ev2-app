/**
 * Cada evento dice para quién es (D65).
 *
 * ---------------------------------------------------------------------------
 * Por qué esta prueba lee el código fuente en vez de llamar a la API
 * ---------------------------------------------------------------------------
 * Porque el defecto que vigila es un **olvido**, y un olvido no se prueba llamando a
 * lo que sí existe: se prueba mirando todo lo que hay.
 *
 * Los tres `publish` de `table_updated` iban sin campo `audience`, y `matchesAudience`
 * trataba "sin audiencia" como "para todos". Resultado: cada vez que alguien se
 * sentaba, su identificador y su mesa le llegaban en vivo a cualquier cliente con el
 * socket abierto. De unos sesenta `publish`, esos tres eran los únicos así — o sea
 * que nadie decidió publicarlo: se les pasó.
 *
 * Ahora un evento sin audiencia no le llega a nadie, que es el lado seguro. Pero
 * "seguro" no es "correcto": un aviso que no llega también es un defecto, solo que uno
 * que se nota. Esta prueba lo caza antes, en desarrollo, cuando cuesta un minuto.
 *
 * ---------------------------------------------------------------------------
 * Lo que NO hace
 * ---------------------------------------------------------------------------
 * No juzga si la audiencia elegida es la correcta —eso lo decide quien escribe la
 * ruta, y se prueba en la prueba de esa ruta—. Solo exige que alguien la haya pensado.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const events = require('../src/services/events');

const RAIZ = path.join(__dirname, '..', 'src');

/** Todos los .js bajo `server/src`, recursivo. */
function archivos(dir) {
  const salida = [];
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const completo = path.join(dir, entrada.name);
    if (entrada.isDirectory()) salida.push(...archivos(completo));
    else if (entrada.name.endsWith('.js')) salida.push(completo);
  }
  return salida;
}

/**
 * Cada llamada a `publish({...})`, con su bloque de argumentos.
 *
 * Se cuentan las llaves para encontrar dónde cierra el objeto: un `payload` anidado
 * tiene llaves adentro, y cortar en la primera `}` partiría la llamada a la mitad y
 * daría por ausente una audiencia que sí está.
 */
function llamadas(fuente) {
  const salida = [];
  const marca = /(?:events\.)?publish\(\{/g;
  let m = marca.exec(fuente);
  while (m) {
    let i = m.index + m[0].length - 1; // sobre la `{`
    let nivel = 0;
    let fin = -1;
    for (let k = i; k < fuente.length; k += 1) {
      if (fuente[k] === '{') nivel += 1;
      else if (fuente[k] === '}') {
        nivel -= 1;
        if (nivel === 0) { fin = k; break; }
      }
    }
    if (fin !== -1) {
      salida.push({
        texto: fuente.slice(i, fin + 1),
        linea: fuente.slice(0, m.index).split('\n').length,
      });
    }
    m = marca.exec(fuente);
  }
  return salida;
}

describe('Ningún evento se publica sin decir para quién es', () => {
  it('todas las llamadas a publish() llevan audience', () => {
    const sinAudiencia = [];
    let total = 0;

    for (const archivo of archivos(RAIZ)) {
      // El propio servicio define `publish`, no lo llama.
      if (archivo.endsWith(path.join('services', 'events.js'))) continue;
      const fuente = fs.readFileSync(archivo, 'utf8');
      for (const c of llamadas(fuente)) {
        total += 1;
        if (!/\baudience\s*:/.test(c.texto)) {
          sinAudiencia.push(`${path.relative(RAIZ, archivo)}:${c.linea}`);
        }
      }
    }

    // Si esto falla, el mensaje dice exactamente dónde: es lo único que hace falta.
    expect(sinAudiencia).toEqual([]);
    // Y que de verdad encontró llamadas: una expresión regular rota también daría
    // lista vacía, y entonces esta prueba pasaría sin mirar nada.
    expect(total).toBeGreaterThan(40);
  });

  it('un evento sin audiencia no le llega a nadie', () => {
    // El lado seguro del olvido. Antes esto devolvía `true`: para todos.
    const cualquiera = { id: 'u1', role: 'guest' };
    expect(events.matchesAudience(null, cualquiera)).toBe(false);
    expect(events.matchesAudience(undefined, cualquiera)).toBe(false);
    expect(events.matchesAudience({}, cualquiera)).toBe(false);
  });

  it('con audiencia sigue funcionando igual que siempre', () => {
    // El arreglo no puede romper lo que ya andaba: por rol, por persona, y el no.
    const mesero = { id: 'u1', role: 'waiter' };
    const cliente = { id: 'u2', role: 'guest' };
    expect(events.matchesAudience({ roles: ['waiter'] }, mesero)).toBe(true);
    expect(events.matchesAudience({ roles: ['waiter'] }, cliente)).toBe(false);
    expect(events.matchesAudience({ userIds: ['u2'] }, cliente)).toBe(true);
    expect(events.matchesAudience({ userIds: ['u2'] }, mesero)).toBe(false);
    expect(events.matchesAudience({ roles: ['manager'], userIds: ['u2'] }, cliente)).toBe(true);
  });
});
