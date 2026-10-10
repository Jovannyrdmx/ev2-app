/**
 * EV2 — ¿esta petición viene de adentro del club?
 *
 * Existe por una sola decisión del dueño (D46): la gerencia entra con PIN **en el
 * club**, y con correo y contraseña desde cualquier otro lado. Un gerente mueve caja,
 * precios, nómina y retiros; seis dígitos alcanzan cuando hay que teclearlos parado en
 * la barra, y no alcanzan desde una computadora en la calle.
 *
 * La red se configura en `CLUB_NETWORKS`, separada por comas. Acepta una IP suelta o
 * un bloque en notación CIDR:
 *
 *     CLUB_NETWORKS=187.234.11.90,192.168.1.0/24
 *
 * **Vacía = la gerencia no puede usar PIN en ningún lado.** Falla hacia el lado
 * seguro a propósito: un servidor recién instalado, o uno donde alguien borró la
 * variable sin querer, no debe quedar aceptando PINes de gerente desde internet.
 *
 * ---------------------------------------------------------------------------
 * Lo que esto NO es
 * ---------------------------------------------------------------------------
 * No es una medida de seguridad fuerte, y no se usa como tal. Una IP se puede falsear
 * si alguien controla la red de por medio, y el internet del club puede cambiar de IP
 * sin avisar. Es una **reducción de superficie**: convierte "cualquiera en el mundo
 * puede probar PINes de gerente" en "hay que estar en la red del club para intentarlo".
 * Lo que de verdad protege el PIN es el freno por club de `services/pins.js`.
 *
 * Por eso tampoco se usa para el personal de piso: ellos entran desde donde estén.
 */
'use strict';

/** `187.234.11.90` → 3152051546. Devuelve null si no es una IPv4. */
function toNumber(ip) {
  const partes = String(ip).trim().split('.');
  if (partes.length !== 4) return null;
  let n = 0;
  for (const parte of partes) {
    if (!/^\d{1,3}$/.test(parte)) return null;
    const byte = Number(parte);
    if (byte > 255) return null;
    n = (n * 256) + byte;
  }
  return n;
}

/**
 * Express puede entregar la IPv4 envuelta en forma IPv6 (`::ffff:187.234.11.90`),
 * según por cuántas capas pasó. Sin desenvolverla, la comparación falla en silencio y
 * el gerente no entiende por qué su PIN no sirve estando en el club.
 */
const unwrap = (ip) => String(ip || '').trim().replace(/^::ffff:/i, '');

/** ¿Cae `ip` dentro de `rango`? El rango es una IP suelta o un bloque `a.b.c.d/nn`. */
function matches(ip, rango) {
  const limpia = unwrap(ip);
  const objetivo = String(rango).trim();
  if (objetivo.length === 0) return false;

  if (!objetivo.includes('/')) {
    // Una IP suelta. Se compara como texto para que una IPv6 también funcione.
    return unwrap(objetivo) === limpia;
  }

  const [base, bitsRaw] = objetivo.split('/');
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const baseNum = toNumber(unwrap(base));
  const ipNum = toNumber(limpia);
  if (baseNum === null || ipNum === null) return false;
  if (bits === 0) return true;
  // `>>> 0` porque en JavaScript los desplazamientos trabajan con enteros con signo, y
  // una máscara de /1 en adelante sale negativa sin esto.
  const mascara = (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (baseNum & mascara) === (ipNum & mascara);
}

/** Los rangos configurados. Vacío cuando no hay ninguno. */
function networks() {
  return String(process.env.CLUB_NETWORKS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** ¿Hay redes configuradas? Si no, la gerencia no entra con PIN en ningún lado. */
const isConfigured = () => networks().length > 0;

/** La respuesta. Sin redes configuradas siempre es `false`, nunca `true`. */
function isInsideClub(ip) {
  const rangos = networks();
  if (rangos.length === 0) return false;
  return rangos.some((rango) => matches(ip, rango));
}

module.exports = {
  toNumber, unwrap, matches, networks, isConfigured, isInsideClub,
};
