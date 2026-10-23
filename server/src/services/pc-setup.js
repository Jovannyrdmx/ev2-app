/**
 * EV2 — "Registrar esta PC" (D127).
 *
 * El gerente, sentado en la PC de la caja (o de la barra), escoge qué es esa PC y baja
 * `Instalar-EV2.cmd`. Doble clic y se hace todo solo:
 *
 *   1. instala Node.js si falta (con winget);
 *   2. baja el agente, lo deja arrancando solo con Windows;
 *   3. se da de alta con una llave escondida en el archivo: de un solo uso, que vence en
 *      15 minutos, y que nadie teclea;
 *   4. el agente encuentra la impresora USB, la registra con su cajón, imprime la hoja de
 *      prueba y abre el cajón (D99/D125: `printing.applyStation`).
 *
 * Las impresoras de las PCs van por USB. Las de red son solo de la caja del teléfono
 * (D126), y esas se dan de alta en Cajas, no aquí.
 *
 * Lo que hay que registrar es una de estas cosas:
 *   - `till:<id>`        una caja del cajero con PC (en una barra o Cover);
 *   - `bartender:<barra>` la PC del bartender: sus comandas y su caja (D128), con la
 *                         misma impresora USB. La caja del bartender se crea si falta.
 */
'use strict';

const { ApiError } = require('../middleware/errors');
const printing = require('./printing');
const tills = require('./tills');

/** Cuánto vive la llave escondida en el instalador. */
const INSTALLER_TTL_MINUTES = 15;
/** Largo de esa llave: nadie la teclea, así que puede ser imposible de adivinar. */
const INSTALLER_CODE_LENGTH = 32;

const LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

/**
 * La dirección del club que se escribe dentro del instalador: la de la petición solo si
 * está en `ALLOWED_ORIGINS` (el `Host` lo escribe quien llama); si no, la https de esa
 * lista. Igual que hacía `install.ps1` (D57).
 */
function agentBaseUrl(req) {
  const permitidos = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  const propio = `${req.protocol}://${req.get('host') || ''}`;
  if (permitidos.includes(propio)) return propio;
  return permitidos.find((o) => /^https:\/\//i.test(o)) || permitidos[0] || propio;
}

const isSafeBase = (base) => /^https:\/\//i.test(base) || LOCALHOST.test(base);

/** Lo que se puede registrar en este club: las cajas con PC y las barras (bartender). */
async function targets(runner, { nightclubId }) {
  const { rows: cajas } = await runner.query(
    `SELECT t.id::text AS till_id, t.name, l.id::text AS location_id, l.name AS location_name,
            l.kind AS location_kind
       FROM tills t JOIN supply_locations l ON l.id = t.location_id
      WHERE t.nightclub_id = $1 AND t.active AND l.active
        AND t.operator = 'cashier' AND t.device = 'pc'
      ORDER BY l.kind = 'door', l.sort_order, l.name, t.sort_order, t.name`,
    [nightclubId]);
  const { rows: barras } = await runner.query(
    `SELECT l.id::text AS location_id, l.name,
            (SELECT t.id::text FROM tills t
              WHERE t.location_id = l.id AND t.active AND t.operator = 'bartender'
              ORDER BY t.sort_order, t.created_at LIMIT 1) AS till_id
       FROM supply_locations l
      WHERE l.nightclub_id = $1 AND l.active AND l.kind = 'bar'
      ORDER BY l.sort_order, l.name`,
    [nightclubId]);
  return [
    ...cajas.map((c) => ({
      key: `till:${c.till_id}`,
      kind: 'till',
      label: c.location_kind === 'door' ? `Caja: ${c.name} (Cover)` : `Caja: ${c.name}`,
      till_id: c.till_id,
      location_id: c.location_id,
    })),
    ...barras.map((b) => ({
      key: `bartender:${b.location_id}`,
      kind: 'bartender',
      label: `Bartender: ${b.name}`,
      till_id: b.till_id,
      location_id: b.location_id,
    })),
  ];
}

/**
 * La estación que el instalador lleva adentro: qué registrar cuando la PC encuentre su
 * impresora USB. Para el bartender crea su caja si la barra todavía no tiene.
 */
async function stationFor(client, { nightclubId, target, hasDrawer, userId, ip }) {
  const [tipo, id] = String(target || '').split(':');
  const pin = hasDrawer ? 2 : null;
  if (tipo === 'till') {
    const caja = await tills.getTill(client, { nightclubId, tillId: id });
    if (!caja.active) throw ApiError.unprocessable('Esa caja está apagada');
    if (caja.operator !== 'cashier') throw ApiError.badRequest('Esa caja es de bartender: escoge "Bartender" con su barra');
    if (caja.device !== 'pc') {
      throw ApiError.unprocessable('Esa caja se cobra con teléfono: su impresora es de red y se da de alta en Cajas.');
    }
    return {
      locationId: caja.location_id,
      purpose: 'till',
      station: { name: caja.name, purpose: 'till', till_id: caja.id, drawer_pin: pin },
      label: caja.name,
    };
  }
  if (tipo === 'bartender') {
    const { rows } = await client.query(
      `SELECT id, name, kind, active FROM supply_locations
        WHERE id = $1 AND nightclub_id = $2 FOR UPDATE`, [id, nightclubId]);
    const barra = rows[0];
    if (!barra || barra.kind !== 'bar' || !barra.active) throw ApiError.notFound('Esa barra no existe');
    const { rows: suya } = await client.query(
      `SELECT id::text AS id FROM tills
        WHERE location_id = $1 AND active AND operator = 'bartender'
        ORDER BY sort_order, created_at LIMIT 1`, [id]);
    const tillId = suya[0] ? suya[0].id : (await tills.create(client, {
      nightclubId, locationId: id, name: `Bartender · ${barra.name}`.slice(0, 60),
      device: 'pc', operator: 'bartender', userId, ip,
    })).id;
    return {
      locationId: id,
      purpose: 'orders',
      // Una sola impresora USB: comandas, recibos de su caja y su cajón (D128).
      station: {
        name: `Bartender · ${barra.name}`.slice(0, 60), purpose: 'orders', till_id: tillId, drawer_pin: pin,
      },
      label: `Bartender · ${barra.name}`,
    };
  }
  throw ApiError.badRequest('Escoge qué es esta PC');
}

/**
 * Prepara el instalador de una PC: la llave de un solo uso y el archivo `.cmd`.
 * `code` sale de aquí una sola vez, dentro del archivo; la base solo guarda su huella.
 */
async function createInstaller(client, {
  nightclubId, target, hasDrawer = true, userId, baseUrl, ip = null,
}) {
  if (!isSafeBase(baseUrl)) {
    throw new ApiError(400, 'insecure_install_url',
      `El instalador solo se genera sobre https, y este servidor se ve como ${baseUrl}. `
      + 'Revisa ALLOWED_ORIGINS y el certificado.');
  }
  const est = await stationFor(client, { nightclubId, target, hasDrawer, userId, ip });
  const invite = await printing.createInvite(client, {
    nightclubId, createdBy: userId, locationId: est.locationId, purpose: est.purpose,
    station: est.station, codeLength: INSTALLER_CODE_LENGTH, ttlMinutes: INSTALLER_TTL_MINUTES,
  });
  await client.query(
    `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, after, ip)
     VALUES ($1,$2,'pc.installer','print_agent_invite',$3,$4,$5)`,
    [nightclubId, userId || null, invite.id,
      JSON.stringify({ target, station: est.station }), ip || null]);
  return {
    invite: { id: invite.id, expires_at: invite.expires_at, station: invite.station },
    label: est.label,
    filename: 'Instalar-EV2.cmd',
    script: installerCmd({ base: baseUrl, code: invite.code, label: est.label }),
  };
}

/** Solo letras, números y espacios dentro del script: lo que va entre comillas simples. */
const plain = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^A-Za-z0-9 .:/-]/g, '').slice(0, 80);

/**
 * El instalador. Un `.cmd` porque es lo único que Windows corre con doble clic sin
 * pedir permisos de ejecución de scripts; adentro va un PowerShell que lee el resto del
 * propio archivo desde la marca. Sin acentos: la consola de Windows no los pinta (D57).
 */
function installerCmd({ base, code, label }) {
  const marca = 'EV2-POWERSHELL';
  const ps = `
$ErrorActionPreference = 'Stop'
$ApiUrl  = '${plain(base)}'
$Codigo  = '${code.replace(/[^0-9A-Z]/g, '')}'
$Lugar   = '${plain(label)}'
$Destino = 'C:\\EV2\\agent'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host ''
Write-Host '  EV2 - registrar esta PC' -ForegroundColor Cyan
Write-Host "  Servidor: $ApiUrl"
Write-Host "  Esta PC:  $Lugar"
Write-Host ''

function Recargar-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

# 1. Node.js (lo instala solo si falta)
$node = Get-Command node -ErrorAction SilentlyContinue
$viejo = $false
if ($node) { $v = ((& node -v) -replace '^v','') -split '\\.'; $viejo = ([int]$v[0]) -lt 18 }
if (-not $node -or $viejo) {
  Write-Host '  Instalando Node.js (una sola vez, tarda un par de minutos)...'
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    Write-Host '  Esta PC no tiene winget. Instala Node.js LTS desde https://nodejs.org' -ForegroundColor Yellow
    Write-Host '  y vuelve a dar doble clic a este archivo.'
    return
  }
  & winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements | Out-Null
  Recargar-Path
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '  No se pudo instalar Node.js. Instalalo desde https://nodejs.org y vuelve a intentar.' -ForegroundColor Red
    return
  }
}

# 2. El agente
New-Item -ItemType Directory -Force -Path $Destino | Out-Null
try {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'print-agent\\.js' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch { }
foreach ($archivo in @('print-agent.js', 'package.json')) {
  Invoke-WebRequest -Uri "$ApiUrl/api/print-agent/files/$archivo" -OutFile (Join-Path $Destino $archivo) -UseBasicParsing
}
$bat = Join-Path $Destino 'iniciar-agente.bat'
Set-Content -Path $bat -Encoding ASCII -Value @"
@echo off
cd /d $Destino
:inicio
node print-agent.js >> agente.log 2>&1
timeout /t 10 /nobreak >nul
goto inicio
"@
$vbs = Join-Path $Destino 'iniciar-agente.vbs'
Set-Content -Path $vbs -Encoding ASCII -Value @"
CreateObject("WScript.Shell").Run """$bat""", 0, False
"@
try {
  $ws = New-Object -ComObject WScript.Shell
  $atajo = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'EV2 agente de impresion.lnk'))
  $atajo.TargetPath = (Join-Path $env:SystemRoot 'System32\\wscript.exe')
  $atajo.Arguments = '"' + $vbs + '"'
  $atajo.WorkingDirectory = $Destino
  $atajo.Save()
} catch { Write-Host '  No se pudo poner el arranque automatico.' -ForegroundColor Yellow }

# 3. Darse de alta con la llave de este archivo (sirve una vez y vence en ${INSTALLER_TTL_MINUTES} minutos)
$env:EV2_API_URL = $ApiUrl
$env:EV2_PAIR_CODE = $Codigo
Set-Location $Destino
& node print-agent.js --pair-only --repair
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '  No se pudo registrar esta PC. El archivo vence a los ${INSTALLER_TTL_MINUTES} minutos y sirve una vez:' -ForegroundColor Red
  Write-Host '  baja otro desde el panel (Cajas, Registrar esta PC).'
  return
}
Remove-Item Env:EV2_PAIR_CODE -ErrorAction SilentlyContinue

# 4. A correr: busca la impresora USB, la registra, imprime la prueba y abre el cajon
Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\wscript.exe') -ArgumentList ('"' + $vbs + '"')
Write-Host ''
Write-Host '  Listo. Revisa que salga la hoja de prueba y que abra el cajon.' -ForegroundColor Green
Write-Host '  En el panel esta PC sale en verde. Ya puedes cerrar esta ventana.'
`;
  const cmd = [
    '@echo off',
    'rem Instalador de EV2 para esta PC. Generado por el panel; sirve una vez.',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "$f=[IO.File]::ReadAllText('%~f0'); $m='${marca.slice(0, 4)}'+'${marca.slice(4)}'+'#'; iex $f.Substring($f.IndexOf($m)+$m.Length)"`,
    'echo.',
    'pause',
    'exit /b',
    `${marca}#${ps}`,
  ];
  return `${cmd.join('\r\n').replace(/\r?\n/g, '\r\n')}\r\n`;
}

/**
 * Borra las PCs e impresoras del club para registrarlas de nuevo (D127).
 *
 * Todo se apaga: las PCs dejan de poder tomar papel (su llave se cambia) y las
 * impresoras dejan de recibirlo. Luego `printing.cleanupDevices` borra lo que no tiene
 * historia y archiva lo que sí (los tickets impresos no se borran, D31/D56). Los papeles
 * que esperaban se cancelan. Las cajas, sus fondos y cortes no se tocan.
 */
async function wipeDevices(client, { nightclubId }) {
  const { rows: imps } = await client.query(
    `UPDATE printers SET active = false, fallback_id = NULL, updated_at = now()
      WHERE nightclub_id = $1 AND active RETURNING id`, [nightclubId]);
  const { rows: pcs } = await client.query(
    `UPDATE print_agents
        SET active = false, station = NULL,
            token_hash = encode(gen_random_bytes(32), 'hex'), updated_at = now()
      WHERE nightclub_id = $1 AND active RETURNING id`, [nightclubId]);
  await client.query(
    `UPDATE print_agent_invites SET expires_at = now()
      WHERE nightclub_id = $1 AND used_at IS NULL AND expires_at > now()`, [nightclubId]);
  // Lo que quedó apagado con el mismo nombre no debe chocar con las altas nuevas.
  await client.query(
    `UPDATE printers
        SET name = left(name, 40) || ' (baja ' || to_char(now(), 'YYMMDD-HH24MISS') || ')'
      WHERE nightclub_id = $1 AND NOT active AND name NOT LIKE '%(baja %'`, [nightclubId]);
  const limpieza = await printing.cleanupDevices(client, { nightclubId });
  return { printers_off: imps.length, agents_off: pcs.length, ...limpieza };
}

module.exports = {
  INSTALLER_TTL_MINUTES,
  INSTALLER_CODE_LENGTH,
  agentBaseUrl,
  isSafeBase,
  targets,
  createInstaller,
  installerCmd,
  wipeDevices,
};
