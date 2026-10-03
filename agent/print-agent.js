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
const readline = require('readline');
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
  scanTimeoutMs: 300,
  /** Cuántas direcciones se prueban a la vez. */
  scanConcurrency: 64,
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
  if (cfg.apiUrl) cfg.apiUrl = String(cfg.apiUrl).replace(/\/+$/, '');
  return cfg;
}

/** Guarda la configuración que el agente se armó solo al emparejarse. */
function saveConfig(cfg) {
  const archivo = path.join(__dirname, 'config.json');
  const guardar = { apiUrl: cfg.apiUrl, token: cfg.token };
  for (const k of Object.keys(DEFAULTS)) {
    if (k !== 'apiUrl' && k !== 'token' && cfg[k] !== DEFAULTS[k]) guardar[k] = cfg[k];
  }
  fs.writeFileSync(archivo, `${JSON.stringify(guardar, null, 2)}\n`, { mode: 0o600 });
  return archivo;
}

/**
 * Un error del que no se vuelve.
 *
 * Existe como clase para poder distinguirlo del resto: en el ciclo principal, un
 * fallo de red es normal y se sigue; esto no.
 */
class FatalError extends Error {}

/**
 * Se rinde, y se rinde bien.
 *
 * **Lanza en vez de llamar a `process.exit()`, y eso no es estilo.** Salir en el mismo
 * instante en que hay una petición HTTP a medio cerrar aborta Node en Windows con
 * «Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c». Lo
 * vimos en una PC de barra: el mensaje útil salía y, justo encima, un choque de
 * programa a nivel C. Quien está parado ahí a las once de la noche ya no sabe cuál de
 * las dos líneas leer, y la que importaba era la primera.
 *
 * Lanzar además corta la ejecución donde se llama, que es exactamente lo que daban por
 * hecho los `if (!algo) fatal(...)` de este archivo.
 */
function fatal(msg) {
  throw new FatalError(msg);
}

/**
 * Terminar sin romper nada.
 *
 * Se marca el código de salida y se deja que el proceso termine solo en cuanto se
 * cierre lo que quede abierto. El temporizador es la red de seguridad para un socket
 * con `keep-alive` que se quede colgado, y va sin `ref` para no ser él quien mantenga
 * vivo el programa.
 */
function salir(codigo) {
  process.exitCode = codigo;
  setTimeout(() => process.exit(codigo), 1500).unref();
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
 * El programa que mete los bytes en el spooler de Windows (D61).
 *
 * ---------------------------------------------------------------------------
 * Por qué no se copia a un recurso compartido, como antes
 * ---------------------------------------------------------------------------
 * La primera versión compartía la impresora y le copiaba el archivo a
 * `\\localhost\<nombre compartido>`. Funciona, pero obliga a que **dos** nombres
 * coincidan letra por letra: el que Windows le puso al recurso compartido y el que
 * un gerente tecleó en el panel. El 26 de septiembre de 2026 dejaron de coincidir en
 * la PC de prueba y el agente contestó `No se encuentra el nombre de red
 * especificado` — un mensaje que no dice nada de impresoras y manda a buscar el
 * problema a la red, donde no estaba.
 *
 * Ahora se abre la impresora por **su propio nombre**, el que se ve en Windows. No
 * hay que compartir nada, no hay segundo nombre que mantener sincronizado, y una PC
 * nueva es "instala el driver y teclea el código".
 *
 * ---------------------------------------------------------------------------
 * Por qué hace falta compilar esto y no basta un comando
 * ---------------------------------------------------------------------------
 * Windows no deja escribirle a una impresora como si fuera un archivo: hay que pasar
 * por el spooler. Y el spooler, por omisión, *reinterpreta* lo que le llega según el
 * driver — que es exactamente lo que destruye el ESC/POS, porque nuestros bytes no
 * son un documento, son órdenes para la impresora. La única forma de decirle "esto
 * pasa tal cual" es abrir el trabajo con el tipo de datos `RAW`, y eso solo se pide
 * desde `winspool.drv`. De ahí las seis funciones de abajo: es el mínimo para abrir,
 * escribir y cerrar un trabajo crudo.
 *
 * El nombre de la impresora y la ruta del archivo viajan por el ENTORNO, no pegados
 * dentro de este texto. No es manía: el nombre lo escribe una persona en el panel, y
 * si fuera parte del programa, un nombre con comillas podría ejecutar otra cosa.
 */
const WINDOWS_PRINT_PS = String.raw`
$ErrorActionPreference = 'Stop'
$pedido = $env:EV2_PRINTER_NAME
$ruta   = $env:EV2_PAYLOAD_PATH

try { $todas = @(Get-Printer) } catch {
  Write-Output ('EV2-ERR:no se pudo leer la lista de impresoras de esta PC: ' + $_.Exception.Message)
  exit 3
}
if ($todas.Count -eq 0) {
  Write-Output 'EV2-ERR:esta PC no tiene ninguna impresora instalada'
  exit 2
}

# Se acepta el nombre de la impresora o el del recurso compartido: el panel pudo
# haberse llenado con cualquiera de los dos, y las instalaciones viejas tienen el
# compartido guardado. Lo que NO se hace es adivinar entre varias parecidas.
$elegida = $todas | Where-Object { $_.Name -eq $pedido } | Select-Object -First 1
if (-not $elegida) {
  $elegida = $todas | Where-Object { $_.ShareName -eq $pedido } | Select-Object -First 1
}
if (-not $elegida) {
  $p = $pedido.ToLower()
  $parecidas = @($todas | Where-Object {
    $_.Name.ToLower().Contains($p) -or $p.Contains($_.Name.ToLower())
  })
  if ($parecidas.Count -eq 1) { $elegida = $parecidas[0] }
}
if (-not $elegida) {
  # El error dice qué hay instalado. Antes decia "no se encuentra el nombre de red",
  # que mandaba a revisar el cableado por un nombre mal escrito en el panel.
  $nombres = ($todas | ForEach-Object { $_.Name }) -join ' | '
  Write-Output ('EV2-ERR:ninguna impresora de esta PC se llama asi. Instaladas: ' + $nombres)
  exit 2
}

try { $bytes = [IO.File]::ReadAllBytes($ruta) } catch {
  Write-Output ('EV2-ERR:no se pudo leer el archivo del ticket: ' + $_.Exception.Message)
  exit 3
}

$codigo = @'
using System;
using System.Runtime.InteropServices;

public class Ev2RawPrinter {
  [StructLayout(LayoutKind.Sequential)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }

  [DllImport("winspool.drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.drv", EntryPoint="ClosePrinter", SetLastError=true)]
  static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.drv", EntryPoint="EndDocPrinter", SetLastError=true)]
  static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint="StartPagePrinter", SetLastError=true)]
  static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint="EndPagePrinter", SetLastError=true)]
  static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint="WritePrinter", SetLastError=true)]
  static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

  public static string Send(string printerName, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printerName, out h, IntPtr.Zero))
      return "Windows no dejo abrir la impresora (error " + Marshal.GetLastWin32Error() + ")";
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName  = "EV2 ticket";
      di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, di))
        return "Windows no acepto empezar el trabajo (error " + Marshal.GetLastWin32Error() + ")";
      try {
        if (!StartPagePrinter(h))
          return "Windows no acepto empezar la pagina (error " + Marshal.GetLastWin32Error() + ")";
        IntPtr buf = Marshal.AllocCoTaskMem(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, buf, bytes.Length);
          int escritos;
          if (!WritePrinter(h, buf, bytes.Length, out escritos))
            return "Windows corto la escritura (error " + Marshal.GetLastWin32Error() + ")";
          if (escritos != bytes.Length)
            return "solo entraron " + escritos + " de " + bytes.Length + " bytes";
        } finally { Marshal.FreeCoTaskMem(buf); }
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
    return "OK";
  }
}
'@

try { Add-Type -TypeDefinition $codigo -Language CSharp -ErrorAction Stop } catch {
  Write-Output ('EV2-ERR:esta PC no pudo preparar la llamada al spooler: ' + $_.Exception.Message)
  exit 3
}

$r = [Ev2RawPrinter]::Send($elegida.Name, $bytes)
if ($r -ne 'OK') { Write-Output ('EV2-ERR:' + $r); exit 4 }

# "Sin conexion" es una marca de Windows, no un cable suelto: con ella puesta el
# spooler acepta el trabajo, lo deja en la cola y no sale papel nunca. Es el fallo
# silencioso que costo una noche, asi que se avisa aunque la escritura saliera bien.
$aviso = ''
if ($elegida.WorkOffline) { $aviso = '|OFFLINE' }
Write-Output ('EV2-OK:' + $elegida.Name + $aviso)
exit 0
`;

/**
 * Manda los bytes a una impresora conectada a esta PC, a través del spooler.
 *
 * `printer.windows_name` es lo que el panel tiene guardado. Puede ser el nombre de la
 * impresora o el del recurso compartido de una instalación vieja: el programa de
 * arriba resuelve los dos, y si no encuentra ninguna, el error dice cuáles hay.
 */
function printToWindows(printer, payload, cfg = DEFAULTS) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('esta impresora está configurada como USB de Windows, '
        + `y el agente está corriendo en ${process.platform}`));
      return;
    }
    const pedido = String(printer.windows_name || '').trim();
    if (!pedido) {
      reject(new Error('esta impresora no tiene nombre de Windows guardado en el panel'));
      return;
    }
    const tmp = path.join(os.tmpdir(), `ev2-print-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
    fs.writeFile(tmp, payload, (errEscritura) => {
      if (errEscritura) { reject(errEscritura); return; }
      execFile('powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_PRINT_PS],
        { timeout: cfg.printTimeoutMs, env: { ...process.env, EV2_PRINTER_NAME: pedido, EV2_PAYLOAD_PATH: tmp } },
        (err, stdout, stderr) => {
          fs.unlink(tmp, () => {});
          const salida = String(stdout || '');
          const bien = salida.match(/EV2-OK:(.*)/);
          if (bien) {
            const [nombre, aviso] = bien[1].trim().split('|');
            if (aviso === 'OFFLINE') {
              log('AVISO', `"${nombre}" está marcada como "sin conexión" en Windows: `
                + 'el ticket quedó en la cola y no va a salir hasta que se le quite esa marca');
            }
            resolve();
            return;
          }
          const mal = salida.match(/EV2-ERR:(.*)/);
          const motivo = mal ? mal[1]
            : String(stderr || (err && err.message) || 'PowerShell no contestó nada');
          reject(new Error(`no se pudo imprimir en "${pedido}": ${motivo.trim()}`));
        });
    });
  });
}

const printOne = (printer, payload, cfg) => (printer.connection === 'windows'
  ? printToWindows(printer, payload, cfg)
  : printToNetwork(printer, payload, cfg));

// ---------------------------------------------------------------- emparejarse

/** Una pregunta en la consola. Sin dependencias: `readline` viene con Node. */
function ask(pregunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(pregunta, (r) => { rl.close(); resolve(r.trim()); }));
}

/**
 * Se da de alta con el código que el gerente tiene en la pantalla (D56).
 *
 * Antes había que copiar un token de 48 caracteres desde el panel hasta esta máquina
 * —por WhatsApp, por un papel— y pegarlo a mano en el archivo. Ahora se teclean ocho
 * caracteres que caducan en diez minutos, y **el token largo nunca pasa por las manos
 * de nadie**: llega por la red y lo escribe este programa.
 *
 * La PC se presenta con su propio nombre de máquina, así que tampoco hay que
 * inventarle uno.
 */
async function pair(cfg) {
  // Sin consola de por medio, para una instalación en serie o desatendida. Es el
  // mismo canje: lo único que cambia es de dónde salen las dos respuestas.
  const desdeEntorno = process.env.EV2_PAIR_CODE;
  if (!desdeEntorno) {
    console.log('');
    console.log('  Esta PC todavía no está dada de alta.');
    console.log('  En el panel del gerente: Impresoras → Nueva PC. Ahí sale el código.');
    console.log('');
  }

  const apiUrl = cfg.apiUrl
    || (desdeEntorno ? '' : await ask('  Dirección del servidor (ej. https://tu-dominio.com): '));
  if (!apiUrl) fatal('Sin la dirección del servidor no se puede continuar.');
  const code = desdeEntorno
    || await ask('  Código que aparece en la pantalla (ej. K7M4-2QX9): ');
  if (!code) fatal('Sin el código no se puede dar de alta esta PC.');

  const limpio = String(apiUrl).replace(/\/+$/, '');
  const res = await fetch(`${limpio}/api/print-agent/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, hostname: os.hostname(), version: VERSION }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const cuerpo = await res.json().catch(() => ({}));
    const motivo = (cuerpo.error && cuerpo.error.message) || `HTTP ${res.status}`;
    fatal(`No se pudo dar de alta esta PC: ${motivo}`);
  }
  const { agent, token } = await res.json();

  const completo = { ...cfg, apiUrl: limpio, token };
  const archivo = saveConfig(completo);
  console.log('');
  log('INFO', `esta PC quedó dada de alta como "${agent.name}"`);
  // Decir el área aquí es lo que convierte "quedó dada de alta" en algo verificable
  // parado frente a la máquina: si dice otra barra, se ve ahora y no a las once de la
  // noche cuando el bartender de al lado no recibe sus comandas (D61).
  log('INFO', areaLabel(agent));
  log('INFO', `configuración guardada en ${archivo} — ya no hace falta volver a hacer esto`);
  console.log('');
  return completo;
}

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

/**
 * El área de esta PC, dicha como la diría una persona (D61).
 *
 * Sin barra asignada imprime todo lo del club: es lo correcto para un club de una
 * sola PC, y se dice así de claro, porque en un club de cuatro esa misma frase es la
 * señal de que a esta le falta su barra.
 */
function areaLabel(agent) {
  if (!agent || !agent.location_name) return 'imprime todo lo del club';
  const papel = { orders: 'comandas de barra', service: 'comandas de meseros' }[agent.purpose];
  return papel ? `${agent.location_name} · ${papel}` : `${agent.location_name} · todo`;
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
            // Desde D61 el recurso compartido ya no hace falta para imprimir: se abre
            // la impresora por su propio nombre. Se sigue informando porque las
            // instalaciones viejas tienen el compartido guardado en el panel, y ver
            // los dos nombres es lo que permite entender una de esas.
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
    log('INFO', `conectado como "${res.agent.name}" — ${areaLabel(res.agent)}`);
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
  let cfg = loadConfig();
  // Sin token, lo primero es darse de alta. Un agente sin configurar ya no es un
  // error que hay que ir a resolver a un archivo: es la primera pantalla.
  if (!cfg.token) cfg = await pair(cfg);
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
    await tick(cfg, estado).catch((err) => {
      // La impresora apagada, el internet del club parpadeando, el servidor
      // reiniciándose: eso se anota y se sigue, que para eso está el ciclo. Lo que no
      // se arregla insistiendo —un token que el servidor no reconoce— sube y termina
      // el programa, en vez de llenar la bitácora del servidor toda la noche.
      if (err instanceof FatalError) throw err;
      log('ERROR', err.message);
    });
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, cfg.pollSeconds * 1000); });
  }
  salir(0);
}

if (require.main === module) {
  main().catch((err) => {
    // Un error previsto se dice en una línea; uno que no lo era enseña la pila, porque
    // entonces hace falta para arreglarlo.
    log('ERROR', err instanceof FatalError ? err.message : (err.stack || err.message));
    salir(1);
  });
}

module.exports = {
  VERSION, DEFAULTS, FatalError, WINDOWS_PRINT_PS,
  loadConfig, printToNetwork, printToWindows, handleJob,
  tick, isPrivateIPv4, ownSubnets, probePrinter, windowsPrinters, inBatches, scan, areaLabel,
  saveConfig, pair,
};
