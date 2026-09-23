/**
 * EV2 — los tres papeles del servicio: comanda, cuenta y recibo (D53).
 *
 * ---------------------------------------------------------------------------
 * Qué es cada uno y para quién
 * ---------------------------------------------------------------------------
 *   * **La comanda** sale en la barra cuando se confirma un pedido. La lee el
 *     bartender con las manos ocupadas, de lado, sin acercarse: por eso lleva la mesa
 *     grande arriba y las cantidades a la izquierda, y por eso NO lleva precios. El
 *     bartender no cobra; ponerle importes es ruido en el único papel que tiene que
 *     leerse de un vistazo.
 *   * **La cuenta** la pide el cliente. Lleva todo lo de la mesa desde que esa gente
 *     se sentó, con precios, lo ya pagado y lo que falta. No es un comprobante de
 *     nada: dice "cuenta", no "pagado", porque todavía no se ha pagado.
 *   * **El recibo** sale cuando el dinero entró de verdad. Lleva el método de pago y
 *     el folio del voucher, y es el respaldo que hace que el corte del turno cuadre
 *     sin discutir.
 *
 * ---------------------------------------------------------------------------
 * La regla que atraviesa todo el archivo
 * ---------------------------------------------------------------------------
 * **Que no salga un papel nunca puede impedir que se sirva un trago o se cobre una
 * cuenta.** Todo lo de aquí se encola con `printing.enqueueSafely`, que se deshace
 * solo si falla; sin impresoras configuradas, el club sigue funcionando exactamente
 * como antes y nadie se entera. La única excepción es la cuenta, que se imprime
 * porque alguien picó un botón: ahí sí hay que decirle por qué no salió.
 */
'use strict';

const escpos = require('./escpos');
const printing = require('./printing');

/** Cuánto hacia atrás mira una cuenta cuando la mesa no tiene a nadie sentado. */
const FALLBACK_HOURS = 12;

const ORDER_STATES_ON_BILL = ['pending', 'confirmed', 'preparing', 'ready', 'delivered', 'pos_error'];

// ---------------------------------------------------------------- formato

/** El importe como lo lee una persona: `$1,234.50`. */
function money(amount, currency = 'MXN') {
  const n = Number(amount || 0);
  const cuerpo = n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // El signo de pesos a secas para MXN —es lo que dice el menú del club— y el código
  // cuando no lo es, porque "$" a secas junto a dólares es exactamente la confusión
  // que termina en una discusión en la puerta.
  return currency === 'MXN' ? `$${cuerpo}` : `${currency} ${cuerpo}`;
}

/** La hora local del club, corta, como la escribiría alguien a mano. */
function localTime(when, timezone) {
  const d = when instanceof Date ? when : new Date(when);
  try {
    return new Intl.DateTimeFormat('es-MX', {
      timeZone: timezone || 'America/Hermosillo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d).replace(',', '');
  } catch {
    // Una zona horaria mal escrita en la ficha del club no puede dejar sin fecha a
    // todos los tickets de la noche.
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Los últimos caracteres de un UUID: es el folio que se canta por radio. */
const folio = (id) => String(id || '').replace(/-/g, '').slice(-6).toUpperCase();

const METHOD_LABEL = {
  cash: 'Efectivo',
  card_terminal: 'Tarjeta (terminal)',
  zelle: 'Zelle',
  cash_app: 'Cash App',
  bank_transfer: 'Transferencia',
  spei: 'SPEI',
};

// ---------------------------------------------------------------- el club

async function clubOf(runner, nightclubId) {
  const { rows } = await runner.query(
    'SELECT name, timezone FROM nightclubs WHERE id = $1', [nightclubId]);
  return rows[0] || { name: 'EV2', timezone: 'America/Hermosillo' };
}

/** El encabezado y el pie que el admin dejó puestos, o el nombre del club. */
function header(t, club, settings) {
  t.center();
  t.bold().tall(settings.header_text || club.name).normal().boldOff();
  t.left().rule();
}

function footer(t, settings) {
  if (!settings.footer_text) return;
  t.blank().center().line(settings.footer_text).left();
}

// ---------------------------------------------------------------- la comanda

/** Lo que la barra necesita saber de un pedido. Sin precios: el bartender no cobra. */
async function orderData(runner, { nightclubId, orderId }) {
  const { rows } = await runner.query(
    `SELECT o.id::text AS id, o.created_at, o.message,
            o.bar_location_id::text AS bar_location_id,
            t.code AS table_code, t.section AS table_section, t.floor AS table_floor,
            dp.name AS delivery_point_name,
            wu.display_name AS taken_by_name,
            su.display_name AS sender_name,
            ru.display_name AS recipient_name,
            COALESCE(items.items, '[]'::json) AS items
       FROM drink_orders o
       LEFT JOIN tables t ON t.id = o.table_id
       LEFT JOIN delivery_points dp ON dp.id = o.delivery_point_id
       LEFT JOIN users wu ON wu.id = o.taken_by
       LEFT JOIN users su ON su.id = o.sender_id
       LEFT JOIN users ru ON ru.id = o.recipient_id
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
                  'name', d.name, 'quantity', oi.quantity, 'notes', oi.notes
                ) ORDER BY d.name) AS items
           FROM drink_order_items oi JOIN drinks d ON d.id = oi.drink_id
          WHERE oi.order_id = o.id) items ON true
      WHERE o.id = $1 AND o.nightclub_id = $2`,
    [orderId, nightclubId]);
  return rows[0] || null;
}

/** Ancho de la columna de cantidades: `99 ` alcanza para cualquier ronda real. */
const QTY_COLUMN = 4;

/**
 * Un renglón de la comanda: la cantidad en columna y el trago a su derecha.
 *
 * Un nombre largo se parte con sangría bajo el nombre, nunca bajo el número: la
 * columna de cantidades tiene que poder leerse de arriba abajo sin que un "Michelada
 * preparada con clamato" meta un 2 a media línea.
 */
function itemLines(quantity, name, width) {
  const sangria = ' '.repeat(QTY_COLUMN);
  const partes = escpos.wrap(name, Math.max(8, width - QTY_COLUMN));
  return partes.map((parte, i) => (i === 0
    ? `${String(quantity).padEnd(QTY_COLUMN - 1)} ${parte}`
    : `${sangria}${parte}`));
}

function renderOrder(t, data, { club, settings }) {
  header(t, club, settings);

  // La mesa, en grande. Es lo único que el bartender busca cuando levanta la vista.
  t.center();
  const donde = data.table_code
    ? `MESA ${data.table_code}`
    : (data.delivery_point_name || 'BARRA').toUpperCase();
  t.bold().big(donde).normal().boldOff();
  if (data.table_section) t.line(data.table_section);
  t.left().rule();

  t.row(`Folio ${folio(data.id)}`, localTime(data.created_at, club.timezone));
  if (data.taken_by_name) t.line(`Tomó: ${data.taken_by_name}`);
  if (data.recipient_name) t.line(`Para: ${data.recipient_name} (de ${data.sender_name})`);
  t.rule();

  t.blank();
  for (const it of data.items) {
    // La cantidad en su propia columna y el trago después: el ojo baja por los
    // números sin leer los nombres. Se arma a mano en vez de con `line()` porque ese
    // normaliza los espacios —para eso está— y aquí el espacio ES la columna.
    for (const l of itemLines(it.quantity, it.name, t.width)) {
      // `raw` y no `line`: `line` acomoda el texto y de paso junta los espacios, que
      // es justo lo que aquí no se quiere.
      t.bold().tall();
      t.raw(l);
      t.normal().boldOff();
    }
    // La nota va sangrada bajo el nombre, por `raw` y por lo mismo: es una columna.
    if (it.notes) for (const n of escpos.wrap(it.notes, t.width - QTY_COLUMN - 2)) t.raw(`${' '.repeat(QTY_COLUMN + 2)}${n}`);
  }
  if (data.message) {
    t.blank().rule();
    t.line(`NOTA: ${data.message}`);
  }

  footer(t, settings);
  t.blank(2).cut();
}

/**
 * Manda la comanda a la barra, si el club la tiene prendida.
 *
 * Corre dentro de la transacción que confirma el pedido: si el pedido no se confirma,
 * la comanda tampoco sale, y no hay forma de que la barra prepare un trago que nadie
 * pidió. Va con `enqueueSafely`, así que ninguna impresora puede impedir un pedido.
 */
async function printOrder(client, { nightclubId, orderId, userId = null }) {
  const settings = await printing.settingsOf(client, nightclubId);
  if (!settings.print_order_tickets) return null;

  const data = await orderData(client, { nightclubId, orderId });
  if (!data || !data.items.length) return null;

  // La barra que prepara ya viene en el pedido; la zona es el respaldo para los
  // pedidos viejos que se guardaron sin ella.
  const printer = await printing.resolvePrinter(client, {
    nightclubId,
    purpose: 'orders',
    locationId: data.bar_location_id,
    section: data.table_section,
  });
  if (!printer) return null;

  const club = await clubOf(client, nightclubId);
  return printing.enqueueSafely(client, {
    nightclubId,
    printer,
    kind: 'order',
    refId: orderId,
    createdBy: userId,
    ...build(printer, (t) => renderOrder(t, data, { club, settings })),
  });
}

// ---------------------------------------------------------------- la cuenta

/**
 * Desde cuándo cuenta esta cuenta.
 *
 * Desde que esa gente se sentó, no desde la medianoche: una mesa que se ocupó a las
 * 11 y otra que se ocupó a las 3 tienen cuentas distintas, y "lo de hoy" juntaría la
 * de los que ya se fueron con la de los que acaban de llegar. Si nadie está sentado
 * —porque el club no usa el plano esa noche— se miran las últimas doce horas, que es
 * más de lo que dura cualquier noche.
 */
async function billWindow(runner, tableId) {
  const { rows } = await runner.query(
    `SELECT min(seated_at) AS since FROM table_occupants
      WHERE table_id = $1 AND left_at IS NULL`, [tableId]);
  return rows[0] && rows[0].since
    ? { since: rows[0].since, seated: true }
    : { since: new Date(Date.now() - FALLBACK_HOURS * 3600000), seated: false };
}

/** Todo lo de la mesa, junto: los renglones, lo pagado y lo que falta. */
async function billData(runner, { nightclubId, tableId }) {
  const { rows: mesas } = await runner.query(
    'SELECT id::text AS id, code, section, floor FROM tables WHERE id = $1 AND nightclub_id = $2',
    [tableId, nightclubId]);
  if (!mesas.length) return null;
  const ventana = await billWindow(runner, tableId);

  const { rows } = await runner.query(
    `SELECT d.name,
            sum(oi.quantity)::int                        AS quantity,
            oi.unit_price::text                          AS unit_price,
            sum(oi.quantity * oi.unit_price)::text       AS amount,
            o.currency,
            bool_and(COALESCE(tx.status, 'not_required') IN ('paid','not_required')) AS paid
       FROM drink_orders o
       JOIN drink_order_items oi ON oi.order_id = o.id
       JOIN drinks d ON d.id = oi.drink_id
       LEFT JOIN transactions tx
              ON tx.reference_type = 'drink_order' AND tx.reference_id = o.id
      WHERE o.nightclub_id = $1 AND o.table_id = $2
        AND o.created_at >= $3 AND o.status = ANY($4::text[])
      GROUP BY d.name, oi.unit_price, o.currency
      ORDER BY d.name`,
    [nightclubId, tableId, ventana.since, ORDER_STATES_ON_BILL]);

  // Lo pagado y lo pendiente se suman por separado y no se restan de un total: un
  // renglón pagado y otro por pagar en la misma mesa es lo normal cuando cada quien
  // paga lo suyo, y esconder eso en una resta es como se cobra dos veces.
  const currency = rows.length ? rows[0].currency : 'MXN';
  let total = 0; let pagado = 0;
  for (const l of rows) {
    total += Number(l.amount);
    if (l.paid) pagado += Number(l.amount);
  }
  return {
    table: mesas[0],
    since: ventana.since,
    seated: ventana.seated,
    lines: rows,
    currency,
    total: total.toFixed(2),
    paid: pagado.toFixed(2),
    due: (total - pagado).toFixed(2),
  };
}

function renderBill(t, data, { club, settings }) {
  header(t, club, settings);
  t.center().bold().tall('CUENTA').normal().boldOff().left();
  t.row(`Mesa ${data.table.code}`, localTime(new Date(), club.timezone));
  if (data.table.section) t.line(data.table.section);
  t.rule();

  for (const l of data.lines) {
    t.row(`${l.quantity} ${l.name}`, money(l.amount, data.currency));
    // El precio unitario solo cuando hay más de uno: en un renglón de uno sería el
    // mismo número dos veces, y un ticket que repite números se lee peor.
    if (l.quantity > 1) t.line(`     ${l.quantity} x ${money(l.unit_price, data.currency)}`);
  }
  if (!data.lines.length) t.line('Sin consumo registrado.');

  t.rule();
  t.bold();
  t.row('TOTAL', money(data.total, data.currency));
  t.boldOff();
  if (Number(data.paid) > 0) {
    t.row('Ya pagado', `-${money(data.paid, data.currency)}`);
    t.bold();
    t.row('POR PAGAR', money(data.due, data.currency));
    t.boldOff();
  }

  t.blank().center();
  t.line('Este documento no es un comprobante de pago.');
  t.left();
  footer(t, settings);
  t.blank(2).cut();
}

/**
 * Imprime la cuenta de una mesa. Esta SÍ avisa cuando no se puede.
 *
 * A diferencia de la comanda y el recibo, esta sale porque alguien picó un botón con
 * el cliente enfrente esperando: quedarse callado lo deja parado mirando la pantalla.
 */
async function printBill(runner, { nightclubId, tableId, userId }) {
  const data = await billData(runner, { nightclubId, tableId });
  if (!data) return { error: 'Esa mesa no existe' };

  const printer = await printing.resolvePrinter(runner, {
    nightclubId, purpose: 'service', section: data.table.section,
  });
  if (!printer) {
    return {
      error: data.table.section
        ? `No hay una impresora de cuentas para ${data.table.section}`
        : 'No hay una impresora de cuentas configurada',
    };
  }

  const club = await clubOf(runner, nightclubId);
  const settings = await printing.settingsOf(runner, nightclubId);
  const job = await printing.enqueue(runner, {
    nightclubId,
    printer,
    kind: 'bill',
    refId: tableId,
    createdBy: userId,
    ...build(printer, (t) => renderBill(t, data, { club, settings })),
  });
  return { job, bill: data };
}

// ---------------------------------------------------------------- el recibo

function renderReceipt(t, data, { club, settings }) {
  header(t, club, settings);
  t.center().bold().tall('RECIBO').normal().boldOff().left();
  t.row(`Folio ${folio(data.transaction_id)}`, localTime(data.at || new Date(), club.timezone));
  t.rule();

  if (data.concept) t.line(data.concept);
  if (data.table_code) t.line(`Mesa ${data.table_code}`);
  t.blank();

  t.row('Forma de pago', METHOD_LABEL[data.method] || data.method);
  if (data.reference) t.row('Voucher', data.reference);
  if (data.collected_by) t.row('Atendió', data.collected_by);

  t.rule();
  t.bold().big(money(data.amount, data.currency)).normal().boldOff();

  t.blank().center().line('PAGADO').left();
  footer(t, settings);
  t.blank(2).cut();
}

/** De qué era el cobro, dicho en una línea que alguien entienda tres días después. */
const CONCEPT = {
  drink_order: 'Consumo en mesa',
  reservation: 'Reservación',
  cover: 'Cover de entrada',
  door_admission: 'Cover de entrada',
  tip: 'Propina',
};

/** Los datos del cobro que acaba de entrar, incluida la mesa si venía de un pedido. */
async function receiptData(runner, { nightclubId, transactionId, collectedBy }) {
  const { rows } = await runner.query(
    `SELECT tx.id::text AS transaction_id, tx.type, tx.amount::text AS amount, tx.currency,
            tx.confirmed_at, tx.reference_type, tx.reference_id::text AS reference_id,
            t.code AS table_code, t.section AS table_section,
            u.display_name AS collected_by
       FROM transactions tx
       LEFT JOIN drink_orders o
              ON tx.reference_type = 'drink_order' AND o.id = tx.reference_id
       LEFT JOIN tables t ON t.id = o.table_id
       LEFT JOIN users u ON u.id = $3
      WHERE tx.id = $1 AND tx.nightclub_id = $2`,
    [transactionId, nightclubId, collectedBy || null]);
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    at: row.confirmed_at,
    concept: CONCEPT[row.type] || CONCEPT[row.reference_type] || null,
  };
}

/**
 * El recibo del dinero que acaba de entrar.
 *
 * Se llama desde `payments.settle()`, que es por donde pasan los tres caminos de
 * cobro: el mesero cobrando en la mesa, el gerente confirmando una transferencia, y
 * la terminal cuando la tarjeta pasa. Engancharlo ahí y no en cada ruta es lo que
 * hace imposible que un camino se quede sin recibo cuando mañana se agregue otro.
 */
async function printReceipt(client, {
  nightclubId, transactionId, method, reference = null, collectedBy = null, copies = 1,
}) {
  const settings = await printing.settingsOf(client, nightclubId);
  if (!settings.print_receipts) return null;

  const data = await receiptData(client, { nightclubId, transactionId, collectedBy });
  if (!data) return null;

  const printer = await printing.resolvePrinter(client, {
    nightclubId, purpose: 'service', section: data.table_section,
  });
  if (!printer) return null;

  const club = await clubOf(client, nightclubId);
  return printing.enqueueSafely(client, {
    nightclubId,
    printer,
    kind: 'receipt',
    refId: transactionId,
    copies,
    createdBy: collectedBy,
    ...build(printer, (t) => renderReceipt(t, { ...data, method, reference }, { club, settings })),
  });
}

// ---------------------------------------------------------------- el corte de turno

/**
 * Lo que va en el ticket del corte (D54).
 *
 * Todo sale del renglón del corte, que quedó congelado al cerrarlo: los totales por
 * método de pago, lo esperado, lo declarado y lo contado. Reimprimir dos días después
 * saca exactamente el mismo papel aunque el empleado haya cobrado mil pesos más desde
 * entonces, porque no se vuelve a calcular nada.
 */
async function cutData(runner, { nightclubId, closingId }) {
  const { rows } = await runner.query(
    `SELECT c.id::text AS id, c.shift_id::text AS shift_id, c.role, c.currency,
            c.started_at, c.ended_at, c.totals,
            c.cash_collected::text  AS cash_collected,
            c.drops_total::text     AS drops_total,
            c.expected_cash::text   AS expected_cash,
            c.declared_cash::text   AS declared_cash,
            c.counted_cash::text    AS counted_cash,
            c.difference::text      AS difference,
            c.difference_reason, c.declared_notes, c.confirmed_at, c.authorized_role,
            u.display_name AS user_name,
            a.display_name AS authorized_by,
            s.section
       FROM shift_closings c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN users a ON a.id = c.authorized_by
       LEFT JOIN staff_shifts s ON s.id = c.shift_id
      WHERE c.id = $1 AND c.nightclub_id = $2`,
    [closingId, nightclubId]);
  const corte = rows[0];
  if (!corte) return null;

  const { rows: retiros } = await runner.query(
    `SELECT d.amount::text AS amount, d.reason, d.created_at, d.authorized_role,
            a.display_name AS authorized_by
       FROM shift_cash_drops d
       LEFT JOIN users a ON a.id = d.authorized_by
      WHERE d.shift_id = $1 AND d.status = 'received'
      ORDER BY d.created_at`,
    [corte.shift_id]);

  return { ...corte, withdrawals: retiros };
}

const ROLE_LABEL = {
  waiter: 'Mesero', bartender: 'Bartender', hostess: 'Anfitriona',
  manager: 'Gerente', admin: 'Administrador',
};

function renderCut(t, data, { club, settings }) {
  header(t, club, settings);
  t.center().bold().tall('CORTE DE TURNO').normal().boldOff().left();
  t.row(`Folio ${folio(data.id)}`, localTime(data.confirmed_at, club.timezone));
  t.rule();

  t.line(`${data.user_name} · ${ROLE_LABEL[data.role] || data.role}`);
  if (data.section) t.line(`Zona: ${data.section}`);
  t.row('Entró', localTime(data.started_at, club.timezone));
  t.row('Salió', localTime(data.ended_at || data.confirmed_at, club.timezone));

  // ---- lo cobrado, por método de pago
  t.blank().rule();
  t.bold().line('COBRADO').boldOff();
  const totales = data.totals || {};
  for (const l of totales.by_method || []) {
    const veces = l.count ? ` (${l.count})` : '';
    t.row(`${METHOD_LABEL[l.method] || l.method}${veces}`, money(l.amount, data.currency));
  }
  if (!(totales.by_method || []).length) t.line('No cobró nada en este turno.');
  t.bold();
  t.row('Total cobrado', money(totales.total_collected || 0, data.currency));
  t.boldOff();

  // La propina va aparte y NO se entrega: no es del club.
  const propinas = totales.tips || {};
  if (Number(propinas.amount) > 0) {
    t.row(`Propinas (${propinas.count || 0}) — no se entregan`,
      money(propinas.amount, data.currency));
  }

  // ---- los retiros parciales, con su motivo y quién los autorizó
  if (data.withdrawals.length) {
    t.blank().rule();
    t.bold().line('RETIROS PARCIALES').boldOff();
    for (const r of data.withdrawals) {
      t.row(localTime(r.created_at, club.timezone).slice(-5), money(r.amount, data.currency));
      // Sangrados con `raw`: el motivo y el nombre cuelgan del importe de arriba, y
      // `line` juntaría los espacios que forman esa sangría.
      for (const l of escpos.wrap(r.reason || 'sin motivo', t.width - 2)) t.raw(`  ${l}`);
      if (r.authorized_by) t.raw(`  Autorizo: ${r.authorized_by}`.replace('Autorizo', 'Autorizó'));
    }
    t.bold();
    t.row('Total retirado', money(data.drops_total, data.currency));
    t.boldOff();
  }

  // ---- el efectivo: lo que tocaba, lo que dijo y lo que se contó
  t.blank().rule();
  t.bold().line('EFECTIVO').boldOff();
  t.row('Efectivo cobrado', money(data.cash_collected, data.currency));
  if (Number(data.drops_total) > 0) {
    t.row('Menos retiros', `-${money(data.drops_total, data.currency)}`);
  }
  t.bold();
  t.row('Debía entregar', money(data.expected_cash, data.currency));
  t.boldOff();
  t.row('Declaró', money(data.declared_cash, data.currency));
  t.row('Contado', money(data.counted_cash, data.currency));

  const dif = Number(data.difference);
  t.rule();
  t.bold().tall();
  // A doble tamaño caben la mitad de las columnas, así que el renglón se arma con esa
  // medida y no con el ancho del papel: si no, el importe se iría al renglón de abajo.
  t.raw(escpos.twoColumns(dif === 0 ? 'CUADRA' : (dif < 0 ? 'FALTA' : 'SOBRA'),
    money(Math.abs(dif), data.currency), Math.floor(t.width / 2)));
  t.normal().boldOff();
  if (dif !== 0 && data.difference_reason) {
    t.line(`Motivo: ${data.difference_reason}`);
  }
  if (data.declared_notes) t.line(`Nota: ${data.declared_notes}`);

  // ---- las firmas, que es para lo que se imprime en papel
  t.blank();
  t.line(`Autorizó: ${data.authorized_by || '—'}`
    + `${data.authorized_role ? ` (${ROLE_LABEL[data.authorized_role] || data.authorized_role})` : ''}`);
  t.blank(2);
  t.line('_______________________');
  t.line(`${data.user_name}`);
  t.blank(2);
  t.line('_______________________');
  t.line(`${data.authorized_by || 'Gerencia'}`);

  footer(t, settings);
  t.blank(2).cut();
}

/**
 * El ticket del corte, después de cerrarlo.
 *
 * Se llama FUERA de la transacción que cierra el turno, y a propósito: el corte ya
 * está hecho y es definitivo, así que si la impresora falla lo que hay que resolver
 * es la impresora, no deshacer el cierre. Por eso tampoco usa `enqueueSafely`: aquí
 * quien llama sí quiere saber si el papel salió, y el corte no corre peligro.
 */
async function printShiftCut(runner, { nightclubId, closingId, userId = null }) {
  const data = await cutData(runner, { nightclubId, closingId });
  if (!data) return null;

  const printer = await printing.resolvePrinter(runner, {
    nightclubId, purpose: 'service', section: data.section,
  });
  if (!printer) return null;

  const club = await clubOf(runner, nightclubId);
  const settings = await printing.settingsOf(runner, nightclubId);
  const job = await printing.enqueue(runner, {
    nightclubId,
    printer,
    kind: 'shift_cut',
    refId: closingId,
    createdBy: userId,
    ...build(printer, (t) => renderCut(t, data, { club, settings })),
  });
  await runner.query(
    'UPDATE shift_closings SET ticket_job_id = $2 WHERE id = $1 AND ticket_job_id IS NULL',
    [closingId, job.id]);
  return job;
}

// ---------------------------------------------------------------- armar

/**
 * Dibuja un ticket con la forma de ESA impresora y devuelve lo que la cola guarda.
 *
 * El mismo papel no se dibuja igual en una de 58 mm que en una de 80, así que el
 * constructor se arma con el ancho, la página de códigos y el cortador de la
 * impresora a la que va, no con valores fijos.
 */
function build(printer, render) {
  const t = escpos.ticket({
    columns: printer.columns,
    codepage: printer.codepage,
    hasCutter: printer.has_cutter,
  });
  render(t);
  const { bytes, text } = t.build();
  return { payload: bytes, preview: text };
}

module.exports = {
  FALLBACK_HOURS, ORDER_STATES_ON_BILL, METHOD_LABEL, CONCEPT,
  money, localTime, folio,
  orderData, renderOrder, printOrder,
  billWindow, billData, renderBill, printBill,
  receiptData, renderReceipt, printReceipt,
  cutData, renderCut, printShiftCut, ROLE_LABEL,
  build,
};
