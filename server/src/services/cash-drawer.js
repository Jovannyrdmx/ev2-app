/**
 * EV2 — abrir el cajón de dinero (D96).
 *
 * El cajón va conectado por cable (RJ11) a la impresora de recibos de su caja, y la
 * impresora lo abre al recibir un pulso ESC/POS. El servidor no ve la red del club,
 * así que el pulso se encola como un trabajo de impresión más (`kind = 'drawer'`) y lo
 * entrega el mismo agente que imprime los recibos.
 *
 * Reglas:
 *   - se abre solo con efectivo (pesos o dólares): con tarjeta no hay nada que guardar;
 *   - se encola DENTRO de la transacción del cobro: si el cobro no se asienta, el cajón
 *     no se abre; y si no se puede encolar, el cobro sigue (con aviso a la pantalla);
 *   - un pulso que ningún agente tomó a tiempo vence y ya no se abre (ver
 *     `printing.claim`), y nunca se desvía a la impresora de otra caja.
 */
'use strict';

const escpos = require('./escpos');
const printing = require('./printing');

const CASH_METHODS = ['cash', 'cash_usd'];

/** ¿Este método de pago mete dinero al cajón? */
const opensDrawer = (method) => CASH_METHODS.includes(method);

/** La impresora de la caja de una barra (la del cajero). */
function tillPrinter(runner, { nightclubId, locationId }) {
  if (!locationId) return Promise.resolve(null);
  return printing.resolvePrinter(runner, { nightclubId, purpose: 'till', locationId });
}

/**
 * La impresora con cajón de la puerta (la de la anfitriona).
 *
 * Hay dos formas de tenerla dada de alta y las dos se respetan: la impresora de
 * recibos de Cover (`purpose = 'till'` en el lugar Cover, D96 zonas) —que es donde ya
 * salen los tickets del cover— y la impresora de puerta (`purpose = 'door'`, una por
 * club). Se usa la que tenga cajón; si ninguna lo tiene, la primera que exista, para
 * que la pantalla diga "esta caja no tiene cajón" y no "no hay impresora".
 */
async function doorPrinter(runner, { nightclubId, locationId = null }) {
  let coverId = locationId;
  if (!coverId) {
    const { rows } = await runner.query(
      `SELECT id FROM supply_locations
        WHERE nightclub_id = $1 AND kind = 'door' AND active
        ORDER BY sort_order, code LIMIT 1`, [nightclubId]);
    coverId = rows[0] ? rows[0].id : null;
  }
  const deCover = coverId
    ? await printing.resolvePrinter(runner, { nightclubId, purpose: 'till', locationId: coverId })
    : null;
  if (deCover && deCover.drawer_pin) return deCover;
  const dePuerta = await printing.resolvePrinter(runner, { nightclubId, purpose: 'door' });
  if (dePuerta && dePuerta.drawer_pin) return dePuerta;
  return deCover || dePuerta;
}

/**
 * Qué le dice la pantalla a quien cobra:
 *   `queued`      — el pulso va en camino;
 *   `no_drawer`   — esa caja no tiene cajón configurado (o no tiene impresora);
 *   `failed`      — no se pudo encolar: hay que abrirlo con la llave.
 */
function status(job, printer) {
  if (!printer || !printer.drawer_pin) return { status: 'no_drawer', job_id: null };
  if (!job) return { status: 'failed', job_id: null };
  return { status: 'queued', job_id: job.id };
}

/**
 * Encola el pulso. Nunca lanza: el cajón no puede tumbar un cobro.
 * `reason` queda en la vista previa del trabajo, que es lo que se lee en el panel.
 */
async function open(client, { nightclubId, printer, reason, refId = null, createdBy = null }) {
  if (!printer || !printer.drawer_pin) return status(null, printer);
  const job = await printing.enqueueSafely(client, {
    nightclubId,
    printer,
    kind: 'drawer',
    refId,
    copies: 1,
    payload: escpos.drawerPulse(Number(printer.drawer_pin)),
    preview: `[Abrir cajón] ${reason}`,
    createdBy,
  });
  return status(job, printer);
}

module.exports = { CASH_METHODS, opensDrawer, tillPrinter, doorPrinter, open, status };
