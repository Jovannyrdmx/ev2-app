#!/usr/bin/env node
/**
 * EV2 — el agente de impresión (D52).
 *
 * ---------------------------------------------------------------------------
 * Qué es esto y por qué existe
 * ---------------------------------------------------------------------------
 * El servidor de EV2 vive en un VPS y las impresoras del club viven en la red de la
 * barra, detrás del módem. El servidor **no puede** alcanzarlas: no hay ruta, y
 * abrirla —publicar el puerto 9100 de una impresora en internet— sería dejar que
 * cualquiera imprima lo que se le ocurra en la barra.
 *
 * Este programa es el puente. Corre en una PC del club, se conecta **hacia afuera**
 * al servidor, pregunta si hay papel pendiente, y lo que le den se lo pasa a la
 * impresora por la red local. No abre ningún puerto, no recibe conexiones de nadie,
 * y no necesita IP fija ni que el club toque su módem.
 *
 * ---------------------------------------------------------------------------
 * Instalación, en corto
 * ---------------------------------------------------------------------------
 *   1. Instala Node.js 18 o más nuevo en la PC.
 *   2. Copia esta carpeta a la PC.
 *   3. Crea `config.json` al lado de este archivo (ver `config.example.json`).
 *   4. `node print-agent.js`
 *
 * El README de al lado explica cómo dejarlo arrancando solo con Windows.
 *
 * ---------------------------------------------------------------------------
 * Lo que este programa NO hace, a propósito
 * ---------------------------------------------------------------------------
 * No decide qué se imprime ni arma ningún ticket: recibe bytes ya hechos. Si algún
 * día hiciera falta cambiar cómo se ve una cuenta, se cambia en el servidor y las
 * cuatro PCs del club imprimen distinto sin que nadie vaya a tocarlas.
 *
 * Tampoco guarda nada. Si lo matas a media noche, lo único que pasa es que el
 * trabajo que tenía en la mano vuelve solo a la cola del servidor a los dos minutos.
 */
'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const VERSION = '1.0.0';

// ---------------------------------------------------------------- configuración

const DEFAULTS = {
  apiUrl: '',
  token: '',
  /** Cada cuánto se le pregunta al servidor si hay papel pendiente. */
  pollSeconds: 3,
  /** Cuántos trabajos se traen de una vez. */
  batch: 5,
  /** Cuánto se espera a que una impresora acepte los bytes antes de darla por muerta. */
  printTimeoutMs: 15000,
  /**
   * Preguntarle a la impresora si tiene papel antes de mandarle el ticket.
   *
   * Un puerto 9100 acepta los bytes aunque la impresora esté sin papel: sin esta
   * pregunta, "impreso" solo significaría "entregado al cable". No todas las
   * impresoras contestan; las que no, se dan por buenas y se sigue.
   */
  checkPaper: true,
  paperCheckMs: 500,
};

function loadConfig() {
  const archivo = path.join(__dirname, 'config.json');
  let desdeArchivo = {};
  if (fs.existsSync(archivo)) {
    try {
      desdeArchivo = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    } catch (err) {
      fatal(`config.json no es un JSON válido: ${err.message}`);
    }
  }
  const cfg = {
    ...DEFAULTS,
    ...desdeArchivo,
    // Las variables de entorno ganan: así se puede correr una segunda instancia de
    // prueba sin tocar el archivo de la PC que está trabajando.
    ...(process.env.EV2_API_URL ? { apiUrl: process.env.EV2_API_URL } : {}),
    ...(process.env.EV2_AGENT_TOKEN ? { token: process.env.EV2_AGENT_TOKEN } : {}),
  };
  if (!cfg.apiUrl) fatal('Falta "apiUrl" en config.json (ej. https://tu-dominio.com)');
  if (!cfg.token) fatal('Falta "token" en config.json: es el que te dio el panel al crear el agente');
  cfg.apiUrl = String(cfg.apiUrl).replace(/\/+$/, '');
  return cfg;
}

function fatal(msg) {
  log('ERROR', msg);
  process.exit(1);
}

// ---------------------------------------------------------------- bitácora

function log(nivel, msg) {
  const hora = new Date().toISOString().slice(0, 19).replace('T', ' ');
  console.log(`${hora} [${nivel}] ${msg}`);
}

// ---------------------------------------------------------------- el servidor

async function callApi(cfg, method, ruta, body) {
  const res = await fetch(`${cfg.apiUrl}/api${ruta}`, {
    method,
    headers: {
      'X-Print-Agent-Token': cfg.token,
      'X-Print-Agent-Version': VERSION,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${texto.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------------------------------------------------------------- la impresora

/**
 * Le pregunta a la impresora si tiene papel, con `DLE EOT 4`.
 *
 * Es una consulta "en tiempo real": la impresora contesta un byte aunque esté a
 * medio trabajo. Los bits 5 y 6 encendidos significan que se acabó el rollo. Las
 * impresoras que no implementan la consulta simplemente no contestan, y entonces se
 * devuelve `null`: no saber no es lo mismo que estar sin papel.
 */
function paperStatus(socket, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { socket.off('data', onData); resolve(null); }, ms);
    function onData(buf) {
      clearTimeout(timer);
      socket.off('data', onData);
      resolve((buf[0] & 0x60) === 0x60 ? 'out' : 'ok');
    }
    socket.once('data', onData);
    socket.write(Buffer.from([0x10, 0x04, 4]));
  });
}

/** Manda los bytes a una impresora de red, por el puerto 9100 en crudo. */
function printToNetwork(printer, payload, cfg) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: printer.host, port: printer.port });
    let cerrado = false;
    const fallar = (err) => {
      if (cerrado) return;
      cerrado = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(cfg.printTimeoutMs, () => fallar(new Error('la impresora no respondió a tiempo')));
    socket.on('error', (err) => fallar(new Error(`no se pudo conectar (${err.code || err.message})`)));

    socket.on('connect', async () => {
      try {
        if (cfg.checkPaper) {
          const papel = await paperStatus(socket, cfg.paperCheckMs);
          if (papel === 'out') { fallar(new Error('la impresora se quedó sin papel')); return; }
        }
        socket.end(payload, () => {
          cerrado = true;
          resolve();
        });
      } catch (err) {
        fallar(err);
      }
    });
  });
}

/**
 * Manda los bytes a una impresora conectada por USB a esta PC, a través del spooler.
 *
 * Windows no deja mandar bytes crudos a una impresora sin pasar por el spooler, y el
 * spooler solo acepta un archivo. El camino que funciona sin instalar nada es
 * compartir la impresora y copiarle el archivo en binario a su recurso compartido;
 * por eso el README pide compartirla con un nombre corto y sin espacios.
 */
function printToWindows(printer, payload) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('esta impresora está configurada como USB de Windows, '
        + `y el agente está corriendo en ${process.platform}`));
      return;
    }
    const tmp = path.join(os.tmpdir(), `ev2-print-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
    fs.writeFile(tmp, payload, (errEscritura) => {
      if (errEscritura) { reject(errEscritura); return; }
      const destino = `\\\\localhost\\${printer.windows_name}`;
      execFile('cmd', ['/c', 'copy', '/B', tmp, destino], (err, _stdout, stderr) => {
        fs.unlink(tmp, () => {});
        if (err) {
          reject(new Error(`no se pudo imprimir en "${printer.windows_name}": `
            + `${String(stderr || err.message).trim()}`));
          return;
        }
        resolve();
      });
    });
  });
}

const printOne = (printer, payload, cfg) => (printer.connection === 'windows'
  ? printToWindows(printer, payload)
  : printToNetwork(printer, payload, cfg));

// ---------------------------------------------------------------- el ciclo

async function handleJob(cfg, job) {
  const printer = job.printer;
  const etiqueta = `${job.kind} → ${printer ? printer.name : '¿?'}`;
  if (!printer) {
    await callApi(cfg, 'POST', `/print-agent/jobs/${job.id}/failed`,
      { error: 'el trabajo no trae impresora' });
    return;
  }
  const payload = Buffer.from(job.payload, 'base64');
  try {
    // Las copias se mandan de una en una a propósito: dos tickets pegados en el mismo
    // envío salen en un solo papel largo, sin corte en medio.
    for (let i = 0; i < (job.copies || 1); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await printOne(printer, payload, cfg);
    }
    await callApi(cfg, 'POST', `/print-agent/jobs/${job.id}/done`, {});
    log('OK', `${etiqueta} (${payload.length} bytes${job.copies > 1 ? `, ${job.copies} copias` : ''})`);
  } catch (err) {
    const motivo = String(err.message || err).slice(0, 400);
    log('FALLO', `${etiqueta}: ${motivo}`);
    try {
      const res = await callApi(cfg, 'POST', `/print-agent/jobs/${job.id}/failed`, { error: motivo });
      if (res.rerouted) log('INFO', `${etiqueta}: desviado a la otra impresora de la barra`);
    } catch (err2) {
      // Si tampoco se puede avisar, no pasa nada grave: el servidor devuelve el
      // trabajo a la cola solo a los dos minutos.
      log('AVISO', `no se pudo reportar el fallo: ${err2.message}`);
    }
  }
}

async function tick(cfg, estado) {
  let res;
  try {
    res = await callApi(cfg, 'GET', `/print-agent/jobs?limit=${cfg.batch}`);
  } catch (err) {
    if (err.status === 401) {
      // Un token inválido no se arregla insistiendo, y insistir llena la bitácora
      // del servidor de intentos fallidos toda la noche.
      fatal('El servidor rechazó el token. Revisa "token" en config.json, '
        + 'o crea otro agente desde el panel del gerente.');
    }
    if (estado.conectado) {
      log('AVISO', `sin servidor (${err.message}). Se sigue intentando.`);
      estado.conectado = false;
    }
    return;
  }
  if (!estado.conectado) {
    log('INFO', `conectado como "${res.agent.name}"`);
    estado.conectado = true;
  }
  for (const job of res.jobs) {
    // En serie a propósito: dos trabajos a la vez en la misma impresora salen
    // intercalados y los dos tickets quedan inservibles.
    // eslint-disable-next-line no-await-in-loop
    await handleJob(cfg, job);
  }
}

async function main() {
  const cfg = loadConfig();
  log('INFO', `EV2 print agent ${VERSION} — servidor ${cfg.apiUrl}`);
  const estado = { conectado: false, parando: false };

  const parar = () => {
    if (estado.parando) process.exit(0);
    estado.parando = true;
    log('INFO', 'cerrando…');
  };
  process.on('SIGINT', parar);
  process.on('SIGTERM', parar);

  while (!estado.parando) {
    // eslint-disable-next-line no-await-in-loop
    await tick(cfg, estado).catch((err) => log('ERROR', err.message));
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, cfg.pollSeconds * 1000); });
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => fatal(err.stack || err.message));
}

module.exports = {
  VERSION, DEFAULTS, loadConfig, printToNetwork, printToWindows, handleJob, tick,
};
