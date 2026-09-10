/**
 * La puerta: el pase de una reservación y lo que se vende en la entrada.
 *
 * Aquí vive lo que no depende de Express ni de la base — generar y limpiar un
 * código, y decidir si un pase se puede usar — para poder probarlo sin levantar
 * nada.
 */
'use strict';

const crypto = require('crypto');

// Sin 0/O ni 1/I/L. El código se dicta en voz alta en una puerta con música a todo
// volumen, y esas parejas se escuchan igual siempre.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const PREFIX = 'EV2';

/** Un código nuevo: EV2-4K7M-2P4X. Aleatorio, nunca derivado de la reservación. */
function generatePassCode() {
  const bytes = crypto.randomBytes(8);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  return `${PREFIX}-${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/**
 * Limpia lo que la puerta teclea o lo que trae un QR.
 *
 * Se acepta con o sin guiones, en minúsculas y con espacios de más, porque se
 * teclea de prisa y con gente esperando.
 *
 * No se "corrigen" letras parecidas a propósito. La tentación es mapear O a 0,
 * pero el alfabeto no tiene NI O NI CERO —justamente para que esa confusión no
 * exista— así que una O tecleada no significa un cero: significa que se leyó mal
 * una D o una Q. Adivinar cuál convertiría un código inválido en el pase de otra
 * persona, y eso es peor que volver a teclearlo.
 */
function normalizePassCode(input) {
  const limpio = String(input == null ? '' : input)
    .trim().toUpperCase()
    .replace(/[\s-]/g, '');
  if (!limpio.startsWith(PREFIX)) return limpio;
  const cuerpo = limpio.slice(PREFIX.length);
  if (cuerpo.length !== 8) return limpio;
  return `${PREFIX}-${cuerpo.slice(0, 4)}-${cuerpo.slice(4)}`;
}

/**
 * Un QR puede traer el código pelón o una dirección completa
 * (`https://club/pase/EV2-4K7M-2P4X`). La puerta no debería tener que saber la
 * diferencia.
 */
function passFromScan(scanned) {
  const texto = String(scanned == null ? '' : scanned).trim();
  const ultimo = texto.split(/[/?#]/).filter(Boolean).pop() || texto;
  return normalizePassCode(ultimo);
}

const PASS_STATUS = {
  ok: 'ok',
  notFound: 'not_found',
  alreadyIn: 'already_in',
  notTonight: 'not_tonight',
  cancelled: 'cancelled',
  unpaid: 'unpaid',
};

/**
 * Si este pase abre la puerta ahora mismo, y si no, por qué.
 *
 * Se decide aquí, con la fila esperando: la puerta tiene que ver un motivo en
 * palabras —"esta reservación es de mañana", "ya entraron"— y no un error.
 *
 * `window_minutes` es qué tan antes de su hora se deja entrar a alguien. La gente
 * llega temprano, y rebotarla por veinte minutos es una pelea en la entrada.
 */
function checkPass(reservation, { now = new Date(), windowMinutes = 120 } = {}) {
  if (!reservation) return { status: PASS_STATUS.notFound, ok: false };
  if (['cancelled', 'no_show'].includes(reservation.status)) {
    return { status: PASS_STATUS.cancelled, ok: false };
  }
  if (reservation.status === 'seated' || reservation.checked_in_at) {
    return { status: PASS_STATUS.alreadyIn, ok: false, at: reservation.checked_in_at };
  }
  if (reservation.status === 'completed') return { status: PASS_STATUS.alreadyIn, ok: false };
  if (reservation.status === 'pending_payment') return { status: PASS_STATUS.unpaid, ok: false };

  const starts = new Date(reservation.starts_at);
  const ends = new Date(reservation.ends_at);
  const abre = new Date(starts.getTime() - windowMinutes * 60_000);
  if (now < abre || now > ends) {
    return { status: PASS_STATUS.notTonight, ok: false, starts_at: reservation.starts_at };
  }
  return { status: PASS_STATUS.ok, ok: true };
}

/**
 * Cuánta gente cubre una reservación: la que reservó más los extras que compró en
 * la puerta. Es el número que suma al aforo.
 */
function headcount(reservation, extras = 0) {
  return (Number(reservation && reservation.guest_count) || 0) + (Number(extras) || 0);
}

module.exports = {
  ALPHABET,
  PREFIX,
  PASS_STATUS,
  generatePassCode,
  normalizePassCode,
  passFromScan,
  checkPass,
  headcount,
};
