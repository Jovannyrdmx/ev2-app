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
  /** Cuánto se espera a cada dirección al buscar impresoras en la red. */
  scanTimeoutMs: 400,
  /** Cuántas direcciones se prueban a la vez. */
  scanConcurrency: 32,
  /**
   * Subredes /24 extra para buscar, como `["192.168.20"]`.
   *
   * Hace falta cuando las impresoras viven en otra VLAN que la PC — pasa, y sin esto
   * la búsqueda no las vería nunca. Solo se aceptan rangos privados: la regla de
   * abajo no se salta por configuración.
   */
  scanSubnets: [],
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

// ---------------------------------------------------------------- buscar impresoras

/**
 * ¿Esta dirección es de una red privada?
 *
 * Es el límite que hace que este programa no sea un escáner de puertos con permiso
 * de fábrica. El servidor pide "busca impresoras" y el agente obedece; si además
 * aceptara buscar en cualquier rango, un servidor comprometido —o un token robado—
 * tendría dentro del club una herramienta para barrer internet desde la IP del bar.
 *
 * Los rangos son los de la RFC 1918 más el enlace local. Nada más.
 */
function isPrivateIPv4(address) {
  const partes = String(address).split('.').map(Number);
  if (partes.length !== 4 || partes.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = partes;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** Las subredes /24 propias de esta PC, sin repetir y solo privadas. */
function ownSubnets(cfg = {}) {
  const vistas = new Set();
  // Las que el club haya puesto a mano, si son privadas. Lo que no lo sea se cae
  // aquí en silencio: la configuración no es una forma de saltarse la regla.
  for (const base of cfg.scanSubnets || []) {
    const limpio = String(base).trim().replace(/\.$/, '');
    if (/^\d+\.\d+\.\d+$/.test(limpio) && isPrivateIPv4(`${limpio}.1`)) vistas.add(limpio);
  }
  for (const lista of Object.values(os.networkInterfaces() || {})) {
    for (const nic of lista || []) {
      if (nic.family !== 'IPv4' || nic.internal) continue;
      if (!isPrivateIPv4(nic.address)) continue;
      // Solo /24: barrer una /16 son 65 mil direcciones y media hora. Las redes de
      // un bar son /24 en la práctica, y si no lo fuera, la impresora se da de alta
      // a mano como siempre.
      if (nic.netmask && nic.netmask !== '255.255.255.0') continue;
      vistas.add(nic.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...vistas];
}

/**
 * Le pregunta a una dirección si hay una impresora ahí.
 *
 * Abre el 9100 y manda `GS I 67`, que en ESC/POS significa "dime qué modelo eres".
 * **No imprime nada**: es una consulta, no un trabajo. Las impresoras que no la
 * implementan no contestan, y entonces se reporta sin modelo — estar ahí ya es el
 * dato que importa.
 */
function probePrinter(host, port, cfg) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let resuelto = false;
    const terminar = (valor) => {
      if (resuelto) return;
      resuelto = true;
      socket.destroy();
      resolve(valor);
    };
    socket.setTimeout(cfg.scanTimeoutMs, () => terminar(null));
    socket.on('error', () => terminar(null));
    socket.on('connect', () => {
      socket.write(Buffer.from([0x1d, 0x49, 67]));
      const esperar = setTimeout(() => terminar({ kind: 'network', host, port, model: null }),
        cfg.scanTimeoutMs);
      socket.once('data', (buf) => {
        clearTimeout(esperar);
        const modelo = buf.toString('latin1').replace(/[^\x20-\x7e]/g, '').trim();
        terminar({ kind: 'network', host, port, model: modelo || null });
      });
    });
  });
}

/** Las impresoras instaladas en esta PC de Windows, con su nombre compartido. */
function windowsPrinters() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve([]); return; }
    const ps = 'Get-Printer | Select-Object Name,ShareName,Shared,PortName | ConvertTo-Json -Compress';
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 15000 }, (err, stdout) => {
        if (err || !stdout) { resolve([]); return; }
        try {
          const crudo = JSON.parse(stdout);
          const lista = Array.isArray(crudo) ? crudo : [crudo];
          resolve(lista.map((p) => ({
            kind: 'windows',
            name: p.Name || null,
            // Sin recurso compartido no se le pueden mandar bytes crudos: el panel lo
            // enseña igual, pero diciendo que hay que compartirla primero.
            share: p.Shared && p.ShareName ? p.ShareName : null,
            host: p.PortName || null,
          })));
        } catch {
          resolve([]);
        }
      });
  });
}

/** Corre `tarea` sobre `items` de `n` en `n`. Sin esto, 254 sockets a la vez. */
async function inBatches(items, n, tarea) {
  const out = [];
  for (let i = 0; i < items.length; i += n) {
    // eslint-disable-next-line no-await-in-loop
    const lote = await Promise.all(items.slice(i, i + n).map(tarea));
    out.push(...lote);
  }
  return out;
}

/**
 * Busca impresoras y reporta lo que encontró.
 *
 * Dos sitios: la red local —el puerto 9100 de cada dirección de la subred propia— y
 * las impresoras instaladas en esta PC. Lo segundo es lo que resuelve las de USB,
 * que no tienen dirección que teclear.
 */
async function scan(cfg) {
  const subredes = ownSubnets(cfg);
  const objetivos = [];
  for (const base of subredes) {
    for (let i = 1; i <= 254; i += 1) objetivos.push(`${base}.${i}`);
  }
  log('INFO', `buscando impresoras en ${subredes.length || 'ninguna'} red(es) privada(s)`
    + `${subredes.length ? ` (${subredes.join(', ')})` : ''}`);

  const enRed = (await inBatches(objetivos, cfg.scanConcurrency,
    (host) => probePrinter(host, 9100, cfg))).filter(Boolean);
  const enWindows = await windowsPrinters();
  const found = [...enRed, ...enWindows];
  log('INFO', `encontradas ${enRed.length} en la red y ${enWindows.length} en esta PC`);
  return found;
}

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

  // La búsqueda va al final: primero sale el papel que alguien está esperando.
  if (res.scan) {
    try {
      const found = await scan(cfg);
      await callApi(cfg, 'POST', '/print-agent/scan', { found });
    } catch (err) {
      log('FALLO', `no se pudo buscar impresoras: ${err.message}`);
      await callApi(cfg, 'POST', '/print-agent/scan',
        { error: String(err.message).slice(0, 400) }).catch(() => {});
    }
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
  isPrivateIPv4, ownSubnets, probePrinter, windowsPrinters, inBatches, scan,
};
