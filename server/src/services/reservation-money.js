// El dinero de una reservacion: el anticipo por transferencia con su comprobante, y el
// resto que se cobra en la puerta (D113).
//
// Aqui vive la UNICA cuenta de "cuanto falta" de una reservacion. La pantalla del
// cliente, la puerta y el cobro la piden a esta funcion: si cada una sumara a su
// manera, tarde o temprano una diria "pagado" y otra "falta $200" de la misma mesa.
'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs/promises');
const { ApiError } = require('../middleware/errors');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const money = (n) => round2(n).toFixed(2);

/**
 * Cuanto lleva pagado una reservacion y cuanto le falta.
 *
 * `total` es lo que se cotizo al reservar (`total_estimated`). Lo pagado son los
 * renglones del libro YA pagados de esa reservacion: anticipo y resto. El anticipo
 * de una noche sin anticipo se asienta como 0.01 (para que el renglon exista); ese
 * centavo no es dinero que descuente el resto, y por eso se topa al anticipo real.
 */
async function balanceOf(runner, { nightclubId, reservationId, lock = false }) {
  const { rows } = await runner.query(
    `SELECT r.id, r.status, r.user_id, r.currency, r.event_id,
            r.total_estimated::text AS total, r.deposit_amount::text AS deposit
       FROM reservations r
      WHERE r.id = $1 AND r.nightclub_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [reservationId, nightclubId]);
  const r = rows[0];
  if (!r) return null;

  const txs = await runner.query(
    `SELECT id, type, status, amount::text AS amount, currency, created_at
       FROM transactions
      WHERE reference_type = 'reservation' AND reference_id = $1 AND nightclub_id = $2
        AND type IN ('reservation_deposit', 'reservation_balance')
      ORDER BY created_at`,
    [r.id, nightclubId]);

  let paid = 0;
  for (const t of txs.rows) {
    if (t.status !== 'paid') continue;
    paid += t.type === 'reservation_deposit'
      ? Math.min(Number(t.amount), Number(r.deposit || 0))
      : Number(t.amount);
  }
  paid = round2(paid);
  const total = round2(r.total);
  const due = Math.max(0, round2(total - paid));
  const depositTx = txs.rows.find((t) => t.type === 'reservation_deposit') || null;
  const openBalanceTx = txs.rows.find((t) => t.type === 'reservation_balance'
    && ['pending', 'pending_manual'].includes(t.status)) || null;

  return {
    reservation: r,
    currency: r.currency,
    total: money(total),
    deposit: money(r.deposit),
    paid: money(paid),
    due: money(due),
    deposit_tx: depositTx,
    open_balance_tx: openBalanceTx,
    // El anticipo esta pagado cuando la reservacion ya no esta esperando su pago.
    deposit_paid: !!depositTx && depositTx.status === 'paid',
  };
}

/**
 * El resto se cobra en la puerta solo cuando el anticipo ya esta pagado (si no, la
 * puerta contesta `unpaid`, que es otra conversacion) y la reservacion sigue viva.
 */
function balanceBlocksEntry(balance) {
  if (!balance) return false;
  if (!['confirmed', 'seated'].includes(balance.reservation.status)) return false;
  return Number(balance.due) > 0;
}

/**
 * El renglon del libro donde se cobra el resto. Se reusa el que este abierto (un
 * cobro con terminal que no paso, un doble toque) para no dejar dos resto abiertos de
 * la misma mesa; si el resto cambio desde entonces se cancela y se asienta otro.
 */
async function openBalanceTransaction(client, { nightclubId, balance, userId, clientRequestId = null }) {
  const due = Number(balance.due);
  if (!(due > 0)) throw ApiError.conflict('Esta reservación ya no tiene resto por pagar');
  if (balance.currency !== 'MXN' && balance.currency !== 'USD') {
    throw ApiError.unprocessable('Moneda de la reservación no reconocida');
  }
  const abierto = balance.open_balance_tx;
  if (abierto) {
    if (money(abierto.amount) === money(due)) return abierto;
    const enTerminal = await client.query(
      `SELECT id FROM terminal_charges WHERE transaction_id = $1
         AND status IN ('creating','waiting','action_required','error') LIMIT 1`, [abierto.id]);
    if (enTerminal.rowCount) {
      throw ApiError.conflict('El resto tiene un cobro esperando en la terminal. Resuélvelo antes de cobrar otra vez.',
        { terminal_charge_id: enTerminal.rows[0].id });
    }
    await client.query(
      `UPDATE transactions SET status = 'cancelled', updated_at = now()
        WHERE id = $1 AND status IN ('pending','pending_manual')`, [abierto.id]);
  }
  const { rows } = await client.query(
    `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                               payer_user_id, provider, reference_type, reference_id,
                               client_request_id, metadata)
     VALUES ($1,'reservation_balance','in',$2,$3,'pending',$4,'manual','reservation',$5,$6,$7)
     RETURNING id, type, status, amount::text AS amount, currency, created_at`,
    [nightclubId, money(due), balance.currency, balance.reservation.user_id,
      balance.reservation.id, clientRequestId,
      JSON.stringify({ total: balance.total, paid_before: balance.paid, opened_by: userId })]);
  return rows[0];
}

// ---------------------------------------------------------------- el comprobante

const PROOF_MAX_BYTES = Number(process.env.DEPOSIT_PROOF_MAX_BYTES || 10 * 1024 * 1024);
const PROOF_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf',
};

/**
 * El tipo REAL del archivo, por sus primeros bytes. El que declara el navegador no se
 * cree: es lo que despues se manda como `Content-Type` al gerente, y un HTML con
 * nombre de foto no debe llegarle como pagina.
 */
function sniffMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const b = buffer;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  if (b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1', 'heif'].includes(brand)) return 'image/heif';
  }
  return null;
}

function checkProof(file) {
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw ApiError.unprocessable('No llegó ningún archivo: toma la foto del comprobante o escoge una de tu galería');
  }
  if (file.buffer.length > PROOF_MAX_BYTES) {
    throw ApiError.unprocessable(
      `El comprobante pesa más de ${Math.round(PROOF_MAX_BYTES / (1024 * 1024))} MB`);
  }
  const mime = sniffMime(file.buffer);
  if (!mime) {
    throw ApiError.unprocessable('Ese archivo no es una foto ni un PDF. Manda una captura o foto del comprobante (JPG, PNG o PDF).');
  }
  return mime;
}

const proofsDir = () => path.join(process.env.RECEIPTS_DIR
  || path.join(process.cwd(), 'var', 'receipts'), 'deposit-proofs');

async function storeProof({ nightclubId, file, mime, now = new Date() }) {
  const checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const relative = path.join(nightclubId, now.toISOString().slice(0, 7),
    `${checksum.slice(0, 24)}.${PROOF_EXT[mime]}`);
  const absolute = path.join(proofsDir(), relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, file.buffer);
  return { relative, absolute, checksum, bytes: file.buffer.length };
}

/** La ruta absoluta de un comprobante guardado, comprobando que no se salga del directorio. */
function proofAbsolute(relative) {
  const base = path.resolve(proofsDir());
  const absolute = path.resolve(base, relative);
  if (!absolute.startsWith(base + path.sep)) return null;
  return absolute;
}

module.exports = {
  balanceOf, balanceBlocksEntry, openBalanceTransaction,
  PROOF_MAX_BYTES, sniffMime, checkProof, storeProof, proofAbsolute, proofsDir,
};
