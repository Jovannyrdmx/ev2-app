/**
 * Cómo se muere el agente de impresión.
 *
 * Suena a detalle y no lo es. Un agente que se rinde tiene UNA cosa que hacer bien:
 * decir por qué, en una línea que se entienda. Esto salió de una PC de barra de
 * verdad, donde el mensaje correcto apareció y justo encima quedó esto:
 *
 *     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
 *
 * Node abortando a nivel C, porque el programa llamaba a `process.exit()` en el mismo
 * instante en que había una petición HTTP a medio cerrar. Quien estaba parado ahí a
 * las once de la noche tenía dos líneas y ninguna forma de saber cuál leer.
 *
 * Por eso se prueba con el programa DE VERDAD, en su propio proceso, contra un
 * servidor que le contesta lo que le contestó aquella noche. Importan tres cosas: que
 * el mensaje salga, que el programa termine con código de error, y que **no quede
 * nada detrás del mensaje**.
 */
'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const AGENTE = path.resolve(__dirname, '../../agent/print-agent.js');

/** Levanta un servidor que contesta lo que se le diga, y dice por dónde le llamaron. */
function servidorQueContesta(estado, cuerpo = { error: { message: 'Token de agente inválido' } }) {
  const rutas = [];
  const server = http.createServer((req, res) => {
    rutas.push(req.url);
    res.writeHead(estado, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cuerpo));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, rutas, port: server.address().port }));
  });
}

/** Corre el agente hasta que termine solo, y devuelve todo lo que dejó. */
function correrAgente(env, msTope = 20000) {
  const hijo = spawn(process.execPath, [AGENTE], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let salida = '';
  let errores = '';
  hijo.stdout.on('data', (d) => { salida += d; });
  hijo.stderr.on('data', (d) => { errores += d; });
  return new Promise((resolve, reject) => {
    const reloj = setTimeout(() => {
      hijo.kill('SIGKILL');
      reject(new Error('el agente no terminó solo'));
    }, msTope);
    hijo.on('close', (code, signal) => {
      clearTimeout(reloj);
      resolve({ code, signal, salida, errores });
    });
  });
}

describe('Cuando el agente de impresión se rinde', () => {
  it('con un token que el servidor no reconoce: lo dice, termina, y no deja basura', async () => {
    const { server, rutas, port } = await servidorQueContesta(401);
    let r;
    try {
      r = await correrAgente({
        EV2_API_URL: `http://127.0.0.1:${port}`,
        EV2_AGENT_TOKEN: 'ev2ag_este_token_ya_no_sirve',
      });
    } finally {
      await new Promise((res) => server.close(res));
    }

    // 1. Dice lo que pasa, y dónde se arregla.
    expect(r.salida).toContain('El servidor rechazó el token');

    // 2. Termina él solo, con código de error. Sin código de error, un arranque
    //    automático en Windows lo daría por bueno y nadie se enteraría.
    expect(r.code).toBe(1);
    expect(r.signal).toBeNull();

    // 3. Y nada detrás del mensaje. Esta es la línea que documenta el defecto:
    //    antes quedaba un aborto de Node encima de la explicación útil.
    expect(r.errores).not.toMatch(/Assertion failed/i);
    expect(r.errores).not.toMatch(/UV_HANDLE_CLOSING/);
    expect(r.errores.trim()).toBe('');

    // Y no insistió: un token inválido no se arregla sondeando toda la noche.
    expect(rutas.filter((u) => u.startsWith('/api/print-agent/jobs'))).toHaveLength(1);
  }, 30000);

  it('no fuerza la salida encima de lo que esté cerrándose', () => {
    // Una honestidad sobre esta prueba: el aborto de Node es de Windows —el archivo
    // que lo lanza es `src\\win\\async.c`— y estas pruebas corren en Linux, donde el
    // mismo `process.exit()` sale sin quejarse. O sea que las de arriba pasarían
    // igual con el defecto puesto.
    //
    // Así que esto mira la causa en vez del síntoma: que rendirse ya no sea un
    // `process.exit()` en seco. Es una prueba de forma, y lo sabe; es lo más cerca
    // que puede estar del defecto una máquina que no es la que lo sufre.
    const fuente = require('fs')
      .readFileSync(AGENTE, 'utf8')
      .split('\n');
    const dondeFatal = fuente.findIndex((l) => l.startsWith('function fatal('));
    expect(dondeFatal).toBeGreaterThan(-1);
    const cuerpoFatal = fuente.slice(dondeFatal, dondeFatal + 4).join('\n');
    expect(cuerpoFatal).toContain('throw new FatalError');
    expect(cuerpoFatal).not.toContain('process.exit');
  });

  it('un servidor caído NO lo detiene: eso sí se arregla esperando', async () => {
    // El contraste importa tanto como el caso de arriba. El internet del club
    // parpadea, el servidor se reinicia al desplegar — si el agente se rindiera con
    // eso, habría que ir a encenderlo a mano a cada barra.
    const r = await correrAgente({
      EV2_API_URL: 'http://127.0.0.1:1',
      EV2_AGENT_TOKEN: 'ev2ag_token_bueno',
    }, 9000).catch((err) => err);

    expect(r).toBeInstanceOf(Error);
    expect(r.message).toBe('el agente no terminó solo');
  }, 15000);
});
