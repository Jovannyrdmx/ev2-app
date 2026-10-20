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
const staffConsumption = require('./staff-consumption');
const bottleService = require('./bottle-service');

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
  cash_usd: 'Efectivo en dólares',
  vip_credit: 'Crédito VIP',
  card_terminal: 'Tarjeta (terminal)',
  zelle: 'Zelle',
  cash_app: 'Cash App',
  bank_transfer: 'Transferencia',
  spei: 'SPEI',
  mercadopago_point: 'Tarjeta (Mercado Pago)',
};

// ---------------------------------------------------------------- el club

async function clubOf(runner, nightclubId) {
  const { rows } = await runner.query(
    'SELECT name, timezone FROM nightclubs WHERE id = $1', [nightclubId]);
  return rows[0] || { name: 'EV2', timezone: 'America/Hermosillo' };
}

/** El encabezado y el pie que el admin dejó puestos, o el nombre del club. */
/**
 * Los estados de un pedido que ya fue a la barra, y por tanto se pueden reimprimir.
 *
 * `pending` queda fuera a propósito: en este sistema el pedido llega a la barra
 * cuando se paga, así que reimprimir uno pendiente mandaría a preparar un trago que
 * nadie cobró — y en el papel se vería igual que uno legítimo.
 */
const REPRINTABLE = new Set(['confirmed', 'preparing', 'ready', 'delivered']);

/** Cómo se llama quien pidió el papel. Va impreso: una reimpresión tiene dueño. */
async function nameOf(runner, userId) {
  if (!userId) return null;
  const { rows } = await runner.query(
    'SELECT display_name FROM users WHERE id = $1', [userId]);
  return rows[0] ? rows[0].display_name : null;
}

/**
 * Las líneas de un texto que capturó el gerente (encabezado o pie), ya limpias.
 * Cada salto de línea que escribió es un renglón del papel: así el nombre comercial,
 * la dirección y el teléfono salen uno bajo otro, como en cualquier ticket de caja.
 */
const textLines = (text) => String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/**
 * El encabezado: la primera línea (el nombre) en grande y negrita; lo demás que el
 * gerente haya capturado (dirección, teléfono, RFC…) centrado en letra normal. Sin
 * encabezado capturado, el nombre del club. No se inventa ningún dato fiscal: lo que
 * no está capturado no sale.
 */
function header(t, club, settings) {
  const lineas = textLines(settings.header_text);
  t.center();
  t.bold().tall(lineas[0] || club.name).normal().boldOff();
  for (const l of lineas.slice(1)) t.line(l);
  t.left().rule('=');
}

/** El título del papel, centrado y a doble alto: lo primero que se lee después del club. */
function title(t, text) {
  t.center().bold().tall(text).normal().boldOff().left();
}

function footer(t, settings) {
  const lineas = textLines(settings.footer_text);
  if (!lineas.length) return;
  t.blank().center();
  for (const l of lineas) t.line(l);
  t.left();
}

/**
 * La cabecera de la tabla de artículos, alineada con `itemLines`: cantidad en su
 * columna, descripción y el importe a la derecha.
 */
function itemsHeader(t) {
  t.raw(escpos.twoColumns('CANT DESCRIPCION', 'IMPORTE', t.width));
  t.rule();
}

// ---------------------------------------------------------------- la comanda

/** Lo que la barra necesita saber de un pedido. Sin precios: el bartender no cobra. */
async function orderData(runner, { nightclubId, orderId }) {
  const { rows } = await runner.query(
    `SELECT o.id::text AS id, o.created_at, o.message, o.status,
            o.bar_location_id::text AS bar_location_id, o.substitutions,
            t.code AS table_code, t.section AS table_section, t.floor AS table_floor,
            dp.name AS delivery_point_name,
            wu.display_name AS taken_by_name,
            su.display_name AS sender_name, su.role AS sender_role, o.staff_consumption,
            ru.display_name AS recipient_name,
            o.subtotal::text AS subtotal, o.currency,
            -- 'not_required' no es un estado del libro: es la respuesta honesta para un
            -- pedido que no cuesta nada y por tanto no tiene cobro que esperar. Mismo
            -- COALESCE que usa services/orders.js, para que la comanda y la pantalla
            -- nunca cuenten historias distintas del mismo pedido.
            COALESCE(tx.status, 'not_required') AS payment_status,
            COALESCE(items.items, '[]'::json) AS items
       FROM drink_orders o
       LEFT JOIN tables t ON t.id = o.table_id
       LEFT JOIN delivery_points dp ON dp.id = o.delivery_point_id
       LEFT JOIN users wu ON wu.id = o.taken_by
       LEFT JOIN users su ON su.id = o.sender_id
       LEFT JOIN users ru ON ru.id = o.recipient_id
       LEFT JOIN transactions tx
              ON tx.reference_type = 'drink_order' AND tx.reference_id = o.id
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
                  'name', d.name, 'quantity', oi.quantity, 'notes', oi.notes,
                  -- ::text para que el dinero llegue como cadena de dos decimales,
                  -- igual que en todo el resto del sistema: NUMERIC leído como número
                  -- de JavaScript es cómo se pierde un centavo sin que nadie lo vea.
                  'unit_price', oi.unit_price::text,
                  'amount', COALESCE(oi.line_total, oi.unit_price * oi.quantity)::text,
                  'mixers', ${bottleService.ITEM_MIXERS_JSON}
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
/**
 * En qué quedó el cobro de este pedido, en una palabra (D59).
 *
 * `not_required` no distingue por sí solo dos cosas que en la mesa son muy distintas:
 * un trago de cortesía —que no cuesta nada— y una cuenta de casa, que sí tiene importe
 * y simplemente no se cobró aquí. El subtotal es lo que las separa, y decirlo mal en un
 * papel que el cliente tiene en la mano es peor que no decir nada.
 */
function orderPaymentLabel(data) {
  const cobrado = Number(data.subtotal || 0);
  switch (data.payment_status) {
    case 'paid': return 'PAGADO';
    case 'refunded': return 'REEMBOLSADO';
    case 'cancelled': return 'COBRO CANCELADO';
    case 'failed': return 'COBRO RECHAZADO';
    case 'not_required': return cobrado > 0 ? 'SIN COBRO' : 'CORTESÍA';
    // `pending` y `pending_manual`: el pedido llegó a la barra y el cobro no ha
    // cerrado. Se dicen igual porque para quien lee el papel son lo mismo.
    default: return 'POR COBRAR';
  }
}

function itemLines(item, width, currency = 'MXN') {
  const sangria = ' '.repeat(QTY_COLUMN);
  // El importe va a la derecha, en la PRIMERA línea (D59). Se mide primero porque es
  // lo que decide cuánto espacio le queda al nombre: al contrario, un "Michelada
  // preparada con clamato" empujaría el precio fuera del papel sin avisar.
  const precio = item.amount === null || item.amount === undefined
    ? '' : money(item.amount, currency);
  const hueco = precio ? precio.length + 1 : 0;
  const anchoNombre = Math.max(8, width - QTY_COLUMN - hueco);
  const partes = escpos.wrap(item.name, anchoNombre);

  return partes.map((parte, i) => {
    if (i > 0) return `${sangria}${parte}`;
    const izquierda = `${String(item.quantity).padEnd(QTY_COLUMN - 1)} ${parte}`;
    if (!precio) return izquierda;
    // Si el nombre llenó su columna, el relleno sale en 1 y el precio queda pegado:
    // preferible a partirlo o a empujar el renglón, que sí rompería la columna.
    const relleno = Math.max(1, width - izquierda.length - precio.length);
    return `${izquierda}${' '.repeat(relleno)}${precio}`;
  });
}

function renderOrder(t, data, { club, settings, reprint = false }) {
  header(t, club, settings);

  // La marca de reimpresión va ARRIBA de todo, antes de la mesa (D62).
  //
  // No es un adorno: es lo único que impide que el bartender prepare el mismo pedido
  // dos veces. Si el papel se atascó y el mesero lo vuelve a mandar, lo que llega a
  // la barra es indistinguible de un pedido nuevo — mismos tragos, misma mesa— y la
  // barra sirve otra ronda que nadie pidió ni pagó. Por eso va primero y en grande:
  // tiene que leerse antes que el contenido, no después.
  if (reprint) {
    t.center().bold().tall('** REIMPRESION **').normal().boldOff();
    if (data.reprinted_by_name) t.line(`Pidió: ${data.reprinted_by_name}`);
    t.left().rule();
  }

  // La mesa, en grande. Es lo único que el bartender busca cuando levanta la vista.
  t.center();
  const donde = data.table_code
    ? `MESA ${data.table_code}`
    : (data.delivery_point_name || 'BARRA').toUpperCase();
  t.bold().big(donde).normal().boldOff();
  if (data.table_section) t.line(data.table_section);
  t.left().rule();

  t.row(`Folio ${folio(data.id)}`, localTime(data.created_at, club.timezone));
  if (data.staff_consumption) {
    // El consumo del personal va marcado en grande: no se cobra en caja, se descuenta.
    t.bold().line(`PERSONAL: ${data.sender_name || 'Sin nombre'} - ${staffConsumption.roleLabel(data.sender_role)}`).boldOff();
  }
  if (data.taken_by_name) t.line(`Tomó: ${data.taken_by_name}`);
  if (data.recipient_name) t.line(`Para: ${data.recipient_name} (de ${data.sender_name})`);
  t.rule();

  t.blank();
  for (const it of data.items) {
    // La cantidad en su propia columna, el trago después y el importe a la derecha:
    // el ojo baja por los números sin leer los nombres. Se arma a mano en vez de con
    // `line()` porque ese normaliza los espacios —para eso está— y aquí el espacio ES
    // la columna.
    for (const l of itemLines(it, t.width, data.currency)) {
      // `raw` y no `line`: `line` acomoda el texto y de paso junta los espacios, que
      // es justo lo que aquí no se quiere.
      t.bold().tall();
      t.raw(l);
      t.normal().boldOff();
    }
    // La nota va sangrada bajo el nombre, por `raw` y por lo mismo: es una columna.
    if (it.notes) for (const n of escpos.wrap(it.notes, t.width - QTY_COLUMN - 2)) t.raw(`${' '.repeat(QTY_COLUMN + 2)}${n}`);
    // El servicio de la botella (D117): cada mezclador sangrado bajo la botella, con
    // su cantidad, y lo que se cobra aparte con su importe.
    for (const m of (Array.isArray(it.mixers) ? it.mixers : [])) {
      const extra = m.charged > 0 ? ` (+${m.charged} ${money(m.line_total, data.currency)})` : '';
      for (const n of escpos.wrap(`+ ${m.quantity} ${m.name}${extra}`, t.width - QTY_COLUMN - 2)) {
        t.raw(`${' '.repeat(QTY_COLUMN + 2)}${n}`);
      }
    }
  }
  // Lo que se sirve con otro insumo (D84), en grande: es lo que el bartender tiene
  // que ver antes de agarrar la botella de siempre.
  const cambios = Array.isArray(data.substitutions) ? data.substitutions : [];
  if (cambios.length) {
    t.blank().rule();
    t.bold().line('SUSTITUCION').boldOff();
    for (const c of cambios) t.line(`${c.from} -> ${c.to}`);
  }

  // El total y en qué quedó el cobro (D59).
  //
  // Este papel acaba en la mesa del cliente, junto con los tragos. Por eso lleva
  // importe, y por eso lleva estado: un total sin decir que ya está pagado es cómo el
  // siguiente mesero que lo vea intenta cobrarlo otra vez.
  //
  // El total son LOS TRAGOS, no lo que se cobró: la propina y el servicio viven en el
  // cobro y salen en el recibo. Poner aquí una cifra que no cuadre con lo cobrado
  // sería peor que no poner ninguna.
  t.blank().rule();
  t.bold();
  t.row('TOTAL', money(data.subtotal, data.currency));
  t.boldOff();
  t.right().bold().line(orderPaymentLabel(data)).boldOff().left();

  if (data.message) {
    t.rule();
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

/**
 * Vuelve a mandar la comanda de un pedido a su barra (D62).
 *
 * ---------------------------------------------------------------------------
 * En qué se parece a `printOrder`, y en qué NO
 * ---------------------------------------------------------------------------
 * El papel es el mismo, con la marca de reimpresión encima. Todo lo demás cambia,
 * porque el origen es distinto: `printOrder` sale solo, pegado al cobro, y por eso se
 * calla cuando no hay dónde imprimir —un club sin impresoras tiene que poder vender—.
 * Esta la pide una persona que picó un botón con el bartender esperando, así que
 * **falla con voz**: quedarse callado la deja mirando la pantalla sin saber si el
 * papel viene o no, que es exactamente el problema que costó dos noches.
 *
 * Por lo mismo NO mira el interruptor de comandas automáticas. Ese interruptor
 * decide si cada pedido saca su papel solo; no puede decidir sobre un papel que
 * alguien está pidiendo a mano y en este momento.
 *
 * ---------------------------------------------------------------------------
 * Lo que no se reimprime
 * ---------------------------------------------------------------------------
 * Un pedido sin confirmar. En este sistema el pedido llega a la barra cuando se
 * paga; reimprimir uno pendiente mandaría a preparar un trago que nadie ha cobrado,
 * y el bartender no tiene cómo notar la diferencia.
 */
async function reprintOrder(runner, { nightclubId, orderId, userId = null }) {
  const data = await orderData(runner, { nightclubId, orderId });
  if (!data || !data.items.length) return { error: 'Ese pedido no existe' };
  if (!REPRINTABLE.has(data.status)) {
    return {
      error: data.status === 'cancelled'
        ? 'Ese pedido está cancelado: no se manda a la barra'
        : 'Ese pedido todavía no se cobra, así que no ha ido a la barra',
    };
  }

  const printer = await printing.resolvePrinter(runner, {
    nightclubId,
    purpose: 'orders',
    locationId: data.bar_location_id,
    section: data.table_section,
  });
  if (!printer) {
    // El mensaje nombra la zona porque el error casi siempre es de configuración —
    // esa barra no tiene impresora de comandas— y quien lee esto está en el piso, no
    // en el panel: tiene que poder repetirle al gerente qué le falta a qué barra.
    return {
      error: data.table_section
        ? `No hay una impresora de comandas para ${data.table_section}`
        : 'No hay una impresora de comandas configurada',
    };
  }

  const [club, settings, quien] = await Promise.all([
    clubOf(runner, nightclubId),
    printing.settingsOf(runner, nightclubId),
    nameOf(runner, userId),
  ]);
  const job = await printing.enqueue(runner, {
    nightclubId,
    printer,
    kind: 'order',
    refId: orderId,
    createdBy: userId,
    ...build(printer, (t) => renderOrder(t, { ...data, reprinted_by_name: quien },
      { club, settings, reprint: true })),
  });
  return { job, printer: { id: printer.id, name: printer.name } };
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
            sum(COALESCE(oi.line_total, oi.quantity * oi.unit_price))::text AS amount,
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
     UNION ALL
     -- Los mezcladores del servicio de botella que se pasaron del tope (D117): se
     -- cobraron aparte, así que van en la cuenta como su propio renglón.
     SELECT 'Extra ' || m.name, sum(m.charged)::int, m.unit_price::text,
            sum(m.line_total)::text, o.currency,
            bool_and(COALESCE(tx.status, 'not_required') IN ('paid','not_required'))
       FROM drink_orders o
       JOIN drink_order_item_mixers m ON m.order_id = o.id AND m.charged > 0
       LEFT JOIN transactions tx
              ON tx.reference_type = 'drink_order' AND tx.reference_id = o.id
      WHERE o.nightclub_id = $1 AND o.table_id = $2
        AND o.created_at >= $3 AND o.status = ANY($4::text[])
      GROUP BY m.name, m.unit_price, o.currency
      ORDER BY 1`,
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
  title(t, 'CUENTA');
  t.rule();
  t.row(`Mesa ${data.table.code}`, localTime(new Date(), club.timezone));
  if (data.table.section) t.line(data.table.section);
  t.rule();
  if (data.lines.length) itemsHeader(t);

  for (const l of data.lines) {
    // Misma columna de cantidades que el recibo y la comanda.
    for (const r of itemLines(l, t.width, data.currency)) t.raw(r);
    // El precio unitario solo cuando hay más de uno: en un renglón de uno sería el
    // mismo número dos veces, y un ticket que repite números se lee peor.
    if (l.quantity > 1) {
      // Con una promocion (2x1) el total ya no es cantidad x precio: se dice, en vez de
      // imprimir una cuenta que no cuadra.
      if (Math.round(Number(l.amount) * 100) === Math.round(Number(l.unit_price) * 100) * l.quantity) {
        t.raw(`${' '.repeat(QTY_COLUMN)}${l.quantity} x ${money(l.unit_price, data.currency)}`);
      } else t.raw(`${' '.repeat(QTY_COLUMN)}Promocion aplicada`);
    }
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
  title(t, 'RECIBO DE PAGO');
  // La copia que se queda la hostess en la puerta (D115): dice que es suya y
  // cuántos accesos ampara, para cuadrarla contra el ticket que se llevó el cliente.
  if (data.copy_label) t.center().bold().line(data.copy_label).boldOff().left();
  t.rule();

  // ---- quién, dónde y cuándo: lo que se pregunta primero cuando hay un reclamo
  t.row(`Folio ${folio(data.transaction_id)}`, localTime(data.at || new Date(), club.timezone));
  if (data.till_name) t.row('Caja', data.till_name);
  if (data.collected_by) t.row('Atendió', data.collected_by);
  if (data.table_code) {
    t.row(`Mesa ${data.table_code}`, data.waiter_name ? `Mesero: ${data.waiter_name}` : '');
  } else if (data.delivery_point_name) {
    t.row('Entrega', data.delivery_point_name);
  }
  if (data.concept) t.line(data.concept);
  if (data.accesses) t.row('Accesos', String(data.accesses));
  t.rule();

  // ---- lo que se pagó, renglón por renglón (los tragos de ese pedido)
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length) {
    itemsHeader(t);
    for (const it of items) {
      for (const l of itemLines(it, t.width, data.currency)) t.raw(l);
      // El precio unitario cuando hay más de uno, como en la cuenta: con promoción el
      // importe ya no es cantidad × precio, y entonces se dice en vez de no cuadrar.
      if (Number(it.quantity) > 1 && it.unit_price !== undefined && it.unit_price !== null) {
        const cuadra = Math.round(Number(it.amount) * 100)
          === Math.round(Number(it.unit_price) * 100) * Number(it.quantity);
        t.raw(`${' '.repeat(QTY_COLUMN)}${cuadra
          ? `${it.quantity} x ${money(it.unit_price, data.currency)}` : 'Promocion aplicada'}`);
      }
      for (const m of (Array.isArray(it.mixers) ? it.mixers : [])) {
        const extra = m.charged > 0 ? ` (+${m.charged} ${money(m.line_total, data.currency)})` : '';
        for (const n of escpos.wrap(`+ ${m.quantity} ${m.name}${extra}`, t.width - QTY_COLUMN - 2)) {
          t.raw(`${' '.repeat(QTY_COLUMN + 2)}${n}`);
        }
      }
    }
    t.rule();
    t.row('Subtotal', money(data.amount, data.currency));
  }

  // La propina que la terminal cobró encima del consumo (D73): va en el recibo porque
  // salió de la tarjeta del cliente, pero aparte, porque no es del club.
  const propina = Number(data.tip_amount || 0);
  if (propina > 0) {
    if (!items.length) t.row('Importe', money(data.amount, data.currency));
    t.row('Propina', money(propina, data.currency));
  }
  const total = Number(data.amount) + propina;
  t.bold().tall();
  // A doble alto el ancho no cambia: el renglón cabe completo.
  t.raw(escpos.twoColumns('TOTAL', money(total, data.currency), t.width));
  t.normal().boldOff();
  t.rule();

  // ---- las formas de pago (D79): una o dos, cada una con su importe; el efectivo con
  // lo que se recibió y el cambio, que es lo primero que se discute en una barra.
  t.bold().line('FORMA DE PAGO').boldOff();
  const partes = (data.parts && data.parts.length) ? data.parts
    : [{ method: data.method, amount: data.amount, reference: data.reference }];
  const varias = partes.length > 1;
  for (const p of partes) {
    const nombre = METHOD_LABEL[p.method] || p.method;
    if (varias) t.row(nombre, money(p.amount, data.currency));
    else t.row(nombre, money(p.amount || data.amount, data.currency));
    if (p.reference) t.row(p.method === 'mercadopago_point' ? '  Folio' : '  Voucher', p.reference);
    if (p.cash_received) {
      t.row('  Recibido', money(p.cash_received, data.currency));
      t.row('  Cambio', money(p.change_given || 0, data.currency));
    }
    // Dólares (D86): lo que entregó, a qué tipo de cambio, y el cambio en pesos.
    if (p.usd_received) {
      t.row('  Recibido', money(p.usd_received, 'USD'));
      t.row('  Tipo de cambio', Number(p.exchange_rate).toFixed(2));
      t.row('  Cambio', money(p.change_given || 0, data.currency));
    }
  }

  t.blank();
  t.center().bold().tall('PAGADO').normal().boldOff().left();
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
async function receiptData(runner, {
  nightclubId, transactionId, collectedBy, tillLocation = null, tillId = null,
}) {
  const { rows } = await runner.query(
    `SELECT tx.id::text AS transaction_id, tx.type, tx.amount::text AS amount, tx.currency,
            tx.confirmed_at, tx.reference_type, tx.reference_id::text AS reference_id,
            t.code AS table_code, t.section AS table_section,
            dp.name AS delivery_point_name, w.display_name AS waiter_name,
            u.display_name AS collected_by, COALESCE(tt.name, l.name) AS till_name,
            (SELECT sum(c.tip_amount)::text FROM terminal_charges c
              WHERE c.transaction_id = tx.id AND c.status = 'processed') AS tip_amount
       FROM transactions tx
       LEFT JOIN drink_orders o
              ON tx.reference_type = 'drink_order' AND o.id = tx.reference_id
       LEFT JOIN tables t ON t.id = o.table_id
       LEFT JOIN delivery_points dp ON dp.id = o.delivery_point_id
       LEFT JOIN users w ON w.id = o.taken_by
       LEFT JOIN users u ON u.id = $3
       LEFT JOIN supply_locations l ON l.id = $4::uuid
       LEFT JOIN tills tt ON tt.id = $5::uuid
      WHERE tx.id = $1 AND tx.nightclub_id = $2`,
    [transactionId, nightclubId, collectedBy || null, tillLocation || null, tillId || null]);
  const row = rows[0];
  if (!row) return null;
  // Los artículos del pedido que se pagó: los mismos renglones que la comanda, con su
  // importe. Un cobro que no es de un pedido (reservación, cover) no tiene renglones.
  let items = [];
  if (row.reference_type === 'drink_order' && row.reference_id) {
    const pedido = await orderData(runner, { nightclubId, orderId: row.reference_id });
    items = pedido ? pedido.items : [];
  }
  return {
    ...row,
    items,
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
  parts = null, locationId = null, copyLabel = null, accesses = null,
}) {
  const settings = await printing.settingsOf(client, nightclubId);

  // Lo que cobra una caja (D79) sale SIEMPRE, en la impresora de ESA caja, aunque el
  // gerente haya apagado los recibos: el dueño lo pidió así. Lo demás sigue el
  // interruptor y la impresora de servicio de la zona, como siempre.
  const caja = collectedBy ? await client.query(
    `SELECT location_id, till_id FROM staff_shifts
      WHERE user_id = $1 AND ended_at IS NULL AND location_id IS NOT NULL`,
    [collectedBy]) : { rows: [] };
  // `locationId` lo manda quien cobra en un lugar fijo sin turno de caja: la puerta
  // imprime el recibo del cover en la impresora de Cover (D96).
  const tillLocation = locationId || (caja.rows[0] ? caja.rows[0].location_id : null);
  if (!tillLocation && !settings.print_receipts) return null;

  const data = await receiptData(client, {
    nightclubId, transactionId, collectedBy, tillLocation,
    tillId: !locationId && caja.rows[0] ? caja.rows[0].till_id : null,
  });
  if (!data) return null;

  const printer = tillLocation
    ? await tillPrinterOf(client, {
      nightclubId, locationId: tillLocation,
      tillId: !locationId && caja.rows[0] ? caja.rows[0].till_id : null,
    })
    : await printing.resolvePrinter(client, {
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
    ...build(printer, (t) => renderReceipt(t, {
      ...data, method, reference, parts, copy_label: copyLabel, accesses,
    }, { club, settings })),
  });
}

// ---------------------------------------------------------------- el acceso del cliente

/**
 * El ticket que se lleva el cliente al pagar el cover (D115).
 *
 * Sale junto con la copia de la hostess, y a propósito NO lleva dinero: es lo que
 * enseña en la puerta para decir cuántos entran con él. Lo que se cobró está en la
 * copia que se queda la hostess. El folio es el mismo en los dos papeles, así que
 * cualquier reclamo se cruza en un vistazo.
 */
const ADMISSION_KIND_LABEL = { general: 'General', vip_extra: 'Extra VIP' };

async function admissionData(runner, { nightclubId, admissionId }) {
  const { rows } = await runner.query(
    `SELECT a.id::text AS admission_id, a.transaction_id::text AS transaction_id, a.kind,
            a.quantity, a.created_at, e.name AS event_name, t.code AS table_code
       FROM door_admissions a
       LEFT JOIN events_calendar e ON e.id = a.event_id
       LEFT JOIN reservations r ON r.id = a.reservation_id
       LEFT JOIN tables t ON t.id = r.table_id
      WHERE a.id = $1 AND a.nightclub_id = $2`,
    [admissionId, nightclubId]);
  return rows[0] || null;
}

function renderAdmission(t, data, { club, settings }) {
  header(t, club, settings);
  t.center().bold().tall('ACCESO').normal().boldOff().left();
  // El folio del cobro cuando lo hubo, para que coincida con la copia de la hostess;
  // una cortesía no tiene cobro y usa el de la entrada.
  t.row(`Folio ${folio(data.transaction_id || data.admission_id)}`,
    localTime(data.created_at || new Date(), club.timezone));
  t.rule();
  if (data.event_name) t.row('Evento', data.event_name);
  t.row('Tipo', ADMISSION_KIND_LABEL[data.kind] || data.kind);
  if (data.table_code) t.row('Mesa', data.table_code);
  t.blank();
  t.center().bold().big(`ACCESOS: ${data.quantity}`).normal().boldOff().left();
  footer(t, settings);
  t.blank(2).cut();
}

/**
 * La impresora de una caja. En Cover (D119) es la de la caja de Cover; si el club todavía
 * tiene registrada una impresora de "puerta" de antes, esa la sustituye para que los dos
 * tickets del cover no se queden sin salir.
 */
async function tillPrinterOf(runner, { nightclubId, locationId, tillId = null }) {
  const deCaja = await printing.resolvePrinter(runner, { nightclubId, purpose: 'till', locationId, tillId });
  if (deCaja) return deCaja;
  const { rows } = await runner.query('SELECT kind FROM supply_locations WHERE id = $1', [locationId]);
  if (rows[0] && rows[0].kind === 'door') {
    return printing.resolvePrinter(runner, { nightclubId, purpose: 'door' });
  }
  return null;
}

/** Encola el ticket del cliente en la impresora de la puerta. Nunca tumba el cobro. */
async function printAdmission(client, { nightclubId, admissionId, locationId, userId = null }) {
  const data = await admissionData(client, { nightclubId, admissionId });
  if (!data) return null;
  const printer = await tillPrinterOf(client, { nightclubId, locationId });
  if (!printer) return null;
  const settings = await printing.settingsOf(client, nightclubId);
  const club = await clubOf(client, nightclubId);
  return printing.enqueueSafely(client, {
    nightclubId,
    printer,
    kind: 'receipt',
    refId: admissionId,
    createdBy: userId,
    ...build(printer, (t) => renderAdmission(t, data, { club, settings })),
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
            s.section,
            c.location_id::text AS location_id, COALESCE(tt.name, l.name) AS location_name,
            s.till_id::text AS till_id,
            c.opening_float::text AS opening_float,
            c.opening_float_usd::text AS opening_float_usd,
            c.pending_orders, c.pending_total::text AS pending_total,
            c.usd_collected::text AS usd_collected, c.usd_change_given::text AS usd_change_given,
            c.usd_drops_total::text AS usd_drops_total, c.expected_usd::text AS expected_usd,
            c.counted_usd::text AS counted_usd, c.difference_usd::text AS difference_usd,
            c.cash_ins_total::text AS cash_ins_total, c.usd_cash_ins_total::text AS usd_cash_ins_total
       FROM shift_closings c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN users a ON a.id = c.authorized_by
       LEFT JOIN staff_shifts s ON s.id = c.shift_id
       LEFT JOIN supply_locations l ON l.id = c.location_id
       LEFT JOIN tills tt ON tt.id = s.till_id
      WHERE c.id = $1 AND c.nightclub_id = $2`,
    [closingId, nightclubId]);
  const corte = rows[0];
  if (!corte) return null;

  const { rows: retiros } = await runner.query(
    `SELECT d.amount::text AS amount, d.currency, d.reason, d.created_at, d.authorized_role,
            a.display_name AS authorized_by
       FROM shift_cash_drops d
       LEFT JOIN users a ON a.id = d.authorized_by
      WHERE d.shift_id = $1 AND d.status = 'received'
      ORDER BY d.created_at`,
    [corte.shift_id]);

  // Las entradas de efectivo (D122), para el detalle del papel.
  const { rows: entradas } = await runner.query(
    `SELECT i.amount::text AS amount, i.currency, i.reason, i.created_at,
            a.display_name AS authorized_by
       FROM shift_cash_ins i LEFT JOIN users a ON a.id = i.authorized_by
      WHERE i.shift_id = $1 ORDER BY i.created_at`, [corte.shift_id]);

  return { ...corte, withdrawals: retiros, cash_ins: entradas };
}

const ROLE_LABEL = {
  waiter: 'Mesero', bartender: 'Bartender', hostess: 'Anfitriona', cashier: 'Cajero',
  manager: 'Gerente', admin: 'Administrador',
};

function renderCut(t, data, { club, settings }) {
  header(t, club, settings);
  title(t, 'CORTE DE TURNO');
  t.row(`Folio ${folio(data.id)}`, localTime(data.confirmed_at, club.timezone));
  t.rule();

  t.line(`${data.user_name} · ${ROLE_LABEL[data.role] || data.role}`);
  if (data.section) t.line(`Zona: ${data.section}`);
  if (data.location_name) t.line(`Caja: ${data.location_name}`);
  t.row('Entró', localTime(data.started_at, club.timezone));
  t.row('Salió', localTime(data.ended_at || data.confirmed_at, club.timezone));

  // ---- lo cobrado, por método de pago
  t.blank().rule();
  t.bold().line('COBRADO').boldOff();
  const totales = data.totals || {};
  for (const l of totales.by_method || []) {
    const veces = l.count ? ` (${l.count})` : '';
    // Un renglón en dólares (cover con precio en dólares, D118) se escribe en dólares.
    t.row(`${METHOD_LABEL[l.method] || l.method}${veces}`, money(l.amount, l.currency || data.currency));
  }
  if (!(totales.by_method || []).length) t.line('No cobró nada en este turno.');
  t.bold();
  t.row('Total cobrado', money(totales.total_collected || 0, data.currency));
  t.boldOff();
  // La caja de Cover (D118): cuánta gente entró por esa caja.
  if (Number(totales.door_people) > 0) t.row('Personas que entraron', String(totales.door_people));

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
      t.row(localTime(r.created_at, club.timezone).slice(-5), money(r.amount, r.currency || data.currency));
      // Sangrados con `raw`: el motivo y el nombre cuelgan del importe de arriba, y
      // `line` juntaría los espacios que forman esa sangría.
      for (const l of escpos.wrap(r.reason || 'sin motivo', t.width - 2)) t.raw(`  ${l}`);
      if (r.authorized_by) t.raw(`  Autorizo: ${r.authorized_by}`.replace('Autorizo', 'Autorizó'));
    }
    t.bold();
    t.row('Total retirado', money(data.drops_total, data.currency));
    if (Number(data.usd_drops_total) > 0) t.row('Total retirado', money(data.usd_drops_total, 'USD'));
    t.boldOff();
  }

  // ---- las entradas de efectivo (D122), con su motivo y quién las autorizó
  if ((data.cash_ins || []).length) {
    t.blank().rule();
    t.bold().line('ENTRADAS DE EFECTIVO').boldOff();
    for (const r of data.cash_ins) {
      t.row(localTime(r.created_at, club.timezone).slice(-5), money(r.amount, r.currency || data.currency));
      for (const l of escpos.wrap(r.reason || 'sin motivo', t.width - 2)) t.raw(`  ${l}`);
      if (r.authorized_by) t.raw(`  Autorizó: ${r.authorized_by}`);
    }
  }

  // ---- el efectivo: lo que tocaba, lo que dijo y lo que se contó
  t.blank().rule();
  t.bold().line('EFECTIVO').boldOff();
  // El fondo de la caja (D77) también se devuelve: sin este renglón, "debía entregar"
  // no cuadra con lo cobrado y el papel parece equivocado.
  if (Number(data.opening_float) > 0) {
    t.row('Fondo de caja', money(data.opening_float, data.currency));
  }
  t.row('Efectivo cobrado', money(data.cash_collected, data.currency));
  if (Number(data.cash_ins_total) > 0) t.row('Entradas de efectivo', money(data.cash_ins_total, data.currency));
  // El cambio en pesos que se dio por cobros en dólares salió de este cajón (D86).
  if (Number(data.usd_change_given) > 0) {
    t.row('Cambio por dólares', `-${money(data.usd_change_given, data.currency)}`);
  }
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

  // ---- los dólares, aparte y sin convertir (D86)
  if (data.expected_usd !== null && data.expected_usd !== undefined) {
    t.blank().rule();
    t.bold().line('DÓLARES').boldOff();
    // El fondo en dólares (D118) también se devuelve, como dólares.
    if (Number(data.opening_float_usd) > 0) t.row('Fondo en dólares', money(data.opening_float_usd, 'USD'));
    t.row('Dólares recibidos', money(data.usd_collected, 'USD'));
    if (Number(data.usd_cash_ins_total) > 0) t.row('Entradas en dólares', money(data.usd_cash_ins_total, 'USD'));
    if (Number(data.usd_drops_total) > 0) t.row('Menos retiros', `-${money(data.usd_drops_total, 'USD')}`);
    t.bold();
    t.row('Debía entregar', money(data.expected_usd, 'USD'));
    t.boldOff();
    t.row('Contado', money(data.counted_usd, 'USD'));
    const difUsd = Number(data.difference_usd);
    t.rule();
    t.bold().tall();
    t.raw(escpos.twoColumns(difUsd === 0 ? 'CUADRA' : (difUsd < 0 ? 'FALTA' : 'SOBRA'),
      money(Math.abs(difUsd), 'USD'), Math.floor(t.width / 2)));
    t.normal().boldOff();
  }
  if ((dif !== 0 || Number(data.difference_usd || 0) !== 0) && data.difference_reason) {
    t.line(`Motivo: ${data.difference_reason}`);
  }
  if (data.declared_notes) t.line(`Nota: ${data.declared_notes}`);

  // ---- lo que la barra dejó sin cobrar, con permiso de quien firma (D77)
  const pendientes = data.pending_orders || [];
  if (pendientes.length) {
    t.blank().rule();
    t.bold().line('SIN COBRAR (AUTORIZADO)').boldOff();
    for (const p of pendientes) {
      const donde = p.table_code ? `Mesa ${p.table_code}` : (p.delivery_point_name || 'Barra');
      t.row(`${donde}${p.taken_by_name ? ` · ${p.taken_by_name}` : ''}`,
        money(p.remaining || p.subtotal, p.currency || data.currency));
    }
    t.bold();
    t.row('Total sin cobrar', money(data.pending_total, data.currency));
    t.boldOff();
  }

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
 * Dónde sale el papel del dinero de un turno (corte y retiros).
 *
 *   - Una caja de barra: su impresora de caja; si no tiene, la de servicio de esa barra.
 *   - La caja de Cover (D118): su impresora de caja; si no tiene, la de puerta; y si
 *     tampoco, la de servicio por la regla de "si hay una sola, es esa" — que es por
 *     donde salía el corte de la anfitriona antes de que Cover fuera caja.
 *   - Un turno sin caja: la de servicio de su zona, como siempre.
 */
async function cashPaperPrinter(runner, {
  nightclubId, locationId = null, section = null, tillId = null,
}) {
  if (locationId) {
    const deCaja = await printing.resolvePrinter(runner, {
      nightclubId, purpose: 'till', locationId, tillId,
    });
    if (deCaja) return deCaja;
    const { rows } = await runner.query('SELECT kind FROM supply_locations WHERE id = $1', [locationId]);
    if (rows[0] && rows[0].kind === 'door') {
      return (await printing.resolvePrinter(runner, { nightclubId, purpose: 'door' }))
        || printing.resolvePrinter(runner, { nightclubId, purpose: 'service', section });
    }
  }
  return printing.resolvePrinter(runner, {
    nightclubId, purpose: 'service', section, locationId: locationId || null,
  });
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

  // El corte de una caja sale en la impresora de esa caja (D79, D118).
  const printer = await cashPaperPrinter(runner, {
    nightclubId, locationId: data.location_id, section: data.section, tillId: data.till_id || null,
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

// ---------------------------------------------------------------- el retiro de efectivo

/** Lo que va en el ticket de un retiro parcial (D81): sale del renglón ya escrito. */
async function dropData(runner, { nightclubId, dropId }) {
  const { rows } = await runner.query(
    `SELECT d.id::text AS id, d.amount::text AS amount, d.currency, d.reason,
            d.created_at, d.authorized_role,
            u.display_name AS user_name, u.role,
            a.display_name AS authorized_by_name,
            s.section, s.location_id::text AS location_id, s.till_id::text AS till_id,
            COALESCE(tt.name, l.name) AS location_name
       FROM shift_cash_drops d
       JOIN users u ON u.id = d.user_id
       JOIN staff_shifts s ON s.id = d.shift_id
       LEFT JOIN users a ON a.id = d.authorized_by
       LEFT JOIN supply_locations l ON l.id = s.location_id
       LEFT JOIN tills tt ON tt.id = s.till_id
      WHERE d.id = $1 AND d.nightclub_id = $2`,
    [dropId, nightclubId]);
  return rows[0] || null;
}

function renderDrop(t, data, { club, settings }) {
  header(t, club, settings);
  title(t, 'RETIRO DE EFECTIVO');
  t.row(`Folio ${folio(data.id)}`, localTime(data.created_at, club.timezone));
  t.rule();
  t.line(`${data.user_name} · ${ROLE_LABEL[data.role] || data.role}`);
  if (data.location_name) t.line(`Caja: ${data.location_name}`);
  else if (data.section) t.line(`Zona: ${data.section}`);
  t.blank();
  t.line(`Motivo: ${data.reason || '—'}`);
  if (data.authorized_by_name) {
    t.line(`Autorizó: ${data.authorized_by_name} (${ROLE_LABEL[data.authorized_role] || data.authorized_role || ''})`);
  }
  t.rule();
  t.bold().big(money(data.amount, data.currency)).normal().boldOff();
  t.blank(2).line('_______________________').line(data.user_name || '');
  t.blank(2).line('_______________________').line(data.authorized_by_name || '');
  footer(t, settings);
  t.blank(2).cut();
}

/**
 * El ticket del retiro, después de asentarlo (D81).
 *
 * Igual que el corte: fuera de la transacción, porque el retiro ya pasó —el dinero
 * salió y el gerente lo autorizó— y si la impresora falla se arregla la impresora.
 * Sale en la impresora de la caja; si no tiene, en la de servicio de su barra o zona.
 */
async function printCashDrop(runner, { nightclubId, dropId, userId = null }) {
  const data = await dropData(runner, { nightclubId, dropId });
  if (!data) return null;
  const printer = await cashPaperPrinter(runner, {
    nightclubId, locationId: data.location_id, section: data.section, tillId: data.till_id || null,
  });
  if (!printer) return null;
  const club = await clubOf(runner, nightclubId);
  const settings = await printing.settingsOf(runner, nightclubId);
  return printing.enqueue(runner, {
    nightclubId,
    printer,
    kind: 'cash_drop',
    refId: dropId,
    createdBy: userId,
    ...build(printer, (t) => renderDrop(t, data, { club, settings })),
  });
}

// ---------------------------------------------------------------- el corte general (D121)

/** Diferencia de un corte, dicha como se dice en caja. */
function differenceLabel(diff, currency) {
  const d = Number(diff || 0);
  if (d === 0) return 'Cuadra';
  return `${d < 0 ? 'Falta' : 'Sobra'} ${money(Math.abs(d), currency)}`;
}

/**
 * El corte general de la noche: todas las cajas (barras y Cover) en un papel, y los
 * totales del club al pie. Lo pide el gerente. Si alguna caja sigue abierta el papel
 * lo dice arriba en grande —PRELIMINAR— porque sus números todavía se mueven y lo que
 * "debe tener" no es una diferencia: es lo que falta contar.
 */
function renderNightCut(t, data, { club, settings }) {
  const { tills, totals } = data;
  const currency = (tills.find((x) => x.currency) || {}).currency || 'MXN';
  header(t, club, settings);
  title(t, 'CORTE GENERAL');
  t.center().line('Cajas de la noche').left();
  if (totals.open_tills > 0) {
    t.center().bold().line(`** PRELIMINAR: ${totals.open_tills} caja(s) abierta(s) **`).boldOff().left();
  }
  t.rule();
  t.row('Impreso', localTime(data.at || new Date(), club.timezone));
  if (data.requested_by) t.row('Pidió', data.requested_by);
  t.row('Cajas', String(totals.tills));

  for (const x of tills) {
    t.rule();
    t.bold().line(`${x.location_name}${x.closed ? '' : ' (ABIERTA)'}`).boldOff();
    t.line(`${x.user_name} · ${localTime(x.started_at, club.timezone).slice(-5)}`
      + ` a ${x.ended_at ? localTime(x.ended_at, club.timezone).slice(-5) : 'ahora'}`);
    if (Number(x.opening_float) > 0) t.row('  Fondo', money(x.opening_float, currency));
    if (Number(x.opening_float_usd) > 0) t.row('  Fondo en dólares', money(x.opening_float_usd, 'USD'));
    t.row('  Cobrado', money(x.collected, currency));
    t.row('  Efectivo', money(x.cash_collected, currency));
    if (Number(x.usd_received) > 0) t.row('  Dólares recibidos', money(x.usd_received, 'USD'));
    if (Number(x.cash_ins_total) > 0) t.row('  Entradas', money(x.cash_ins_total, currency));
    if (Number(x.usd_cash_ins_total) > 0) t.row('  Entradas en dólares', money(x.usd_cash_ins_total, 'USD'));
    if (Number(x.drops_received) > 0) t.row('  Retiros', `-${money(x.drops_received, currency)}`);
    if (Number(x.door_people) > 0) t.row('  Personas que entraron', String(x.door_people));
    if (x.pending_orders > 0) {
      t.row(`  Sin cobrar (${x.pending_orders})`, money(x.pending_total, currency));
    }
    if (x.closed) {
      t.bold().row('  Corte', differenceLabel(x.difference, currency)).boldOff();
      if (x.difference_usd !== null && x.difference_usd !== undefined) {
        t.row('  Corte dólares', differenceLabel(x.difference_usd, 'USD'));
      }
    } else {
      t.bold().row('  Debe tener', money(x.cash_to_hand, currency)).boldOff();
      if (Number(x.usd_to_hand) > 0) t.row('  Debe tener dólares', money(x.usd_to_hand, 'USD'));
    }
  }
  if (!tills.length) { t.rule(); t.line('No hay cajas abiertas ni cerradas esta noche.'); }

  // ---- los totales del club
  t.rule('=');
  t.bold().line('COBRADO POR FORMA DE PAGO').boldOff();
  for (const l of totals.by_method) {
    t.row(`${METHOD_LABEL[l.method] || l.method}${l.count ? ` (${l.count})` : ''}`,
      money(l.amount, l.currency || currency));
  }
  if (!totals.by_method.length) t.line('Sin cobros.');
  t.rule();
  t.bold().tall();
  t.raw(escpos.twoColumns('TOTAL', money(totals.total_collected, currency), t.width));
  t.normal().boldOff();
  if (Number(totals.tips) > 0) t.row('Propinas (no se entregan)', money(totals.tips, currency));
  if (Number(totals.opening_floats) > 0) t.row('Fondos de caja', money(totals.opening_floats, currency));
  if (Number(totals.opening_floats_usd) > 0) t.row('Fondos en dólares', money(totals.opening_floats_usd, 'USD'));
  if (Number(totals.usd_received) > 0) t.row('Dólares recibidos', money(totals.usd_received, 'USD'));
  if (Number(totals.cash_ins_total) > 0) t.row('Entradas de efectivo', money(totals.cash_ins_total, currency));
  if (Number(totals.usd_cash_ins_total) > 0) t.row('Entradas en dólares', money(totals.usd_cash_ins_total, 'USD'));
  if (Number(totals.drops_received) > 0) t.row('Retiros', `-${money(totals.drops_received, currency)}`);
  if (Number(totals.usd_drops_received) > 0) t.row('Retiros en dólares', `-${money(totals.usd_drops_received, 'USD')}`);
  if (totals.door_people > 0) t.row('Personas que entraron', String(totals.door_people));
  t.bold().row('Diferencia de cortes', differenceLabel(totals.difference, currency)).boldOff();
  if (Number(totals.difference_usd) !== 0) t.row('Diferencia en dólares', differenceLabel(totals.difference_usd, 'USD'));

  t.blank(2);
  t.line('_______________________');
  t.line(data.requested_by || 'Gerencia');
  footer(t, settings);
  t.blank(2).cut();
}

/**
 * Imprime el corte general en la impresora que escogió el gerente. La impresora la
 * escoge él porque el corte general no es de ninguna caja: sale donde él esté parado.
 */
async function printNightCut(runner, { nightclubId, printer, tills, totals, userId = null }) {
  const club = await clubOf(runner, nightclubId);
  const settings = await printing.settingsOf(runner, nightclubId);
  const requestedBy = await nameOf(runner, userId);
  return printing.enqueue(runner, {
    nightclubId,
    printer,
    kind: 'night_cut',
    refId: null,
    createdBy: userId,
    ...build(printer, (t) => renderNightCut(t, {
      tills, totals, requested_by: requestedBy, at: new Date(),
    }, { club, settings })),
  });
}

// ---------------------------------------------------------------- entrada de efectivo (D122)

async function cashInData(runner, { nightclubId, cashInId }) {
  const { rows } = await runner.query(
    `SELECT i.id::text AS id, i.amount::text AS amount, i.currency, i.reason, i.created_at,
            i.authorized_role, u.display_name AS user_name, u.role,
            a.display_name AS authorized_by_name,
            s.section, s.location_id::text AS location_id, s.till_id::text AS till_id,
            COALESCE(tt.name, l.name) AS location_name
       FROM shift_cash_ins i
       JOIN users u ON u.id = i.user_id
       JOIN staff_shifts s ON s.id = i.shift_id
       LEFT JOIN users a ON a.id = i.authorized_by
       LEFT JOIN supply_locations l ON l.id = s.location_id
       LEFT JOIN tills tt ON tt.id = s.till_id
      WHERE i.id = $1 AND i.nightclub_id = $2`,
    [cashInId, nightclubId]);
  return rows[0] || null;
}

function renderCashIn(t, data, { club, settings }) {
  header(t, club, settings);
  title(t, 'ENTRADA DE EFECTIVO');
  t.rule();
  t.row(`Folio ${folio(data.id)}`, localTime(data.created_at, club.timezone));
  if (data.location_name) t.row('Caja', data.location_name);
  t.row('Recibió', `${data.user_name} · ${ROLE_LABEL[data.role] || data.role}`);
  t.line(`Motivo: ${data.reason || '—'}`);
  if (data.authorized_by_name) {
    t.line(`Autorizó: ${data.authorized_by_name} (${ROLE_LABEL[data.authorized_role] || data.authorized_role || ''})`);
  }
  t.rule();
  t.bold().tall();
  t.raw(escpos.twoColumns('ENTRA', money(data.amount, data.currency), t.width));
  t.normal().boldOff();
  t.blank(2).line('_______________________').line(data.user_name || '');
  t.blank(2).line('_______________________').line(data.authorized_by_name || '');
  footer(t, settings);
  t.blank(2).cut();
}

/** El ticket de la entrada, después de asentarla: va a la impresora de esa caja. */
async function printCashIn(runner, { nightclubId, cashInId, userId = null }) {
  const data = await cashInData(runner, { nightclubId, cashInId });
  if (!data) return null;
  const printer = await cashPaperPrinter(runner, {
    nightclubId, locationId: data.location_id, section: data.section, tillId: data.till_id || null,
  });
  if (!printer) return null;
  const club = await clubOf(runner, nightclubId);
  const settings = await printing.settingsOf(runner, nightclubId);
  return printing.enqueue(runner, {
    nightclubId,
    printer,
    kind: 'cash_in',
    refId: cashInId,
    createdBy: userId,
    ...build(printer, (t) => renderCashIn(t, data, { club, settings })),
  });
}

// ---------------------------------------------------------------- corte X (D122)

/**
 * El corte X: cómo va una caja SIN cerrarla. Lo pide un gerente (en su sesión, o con
 * su PIN en la pantalla de la caja) y sale en la impresora de esa caja. Lleva lo que
 * la caja debe tener en este momento; por eso nunca lo saca el cajero solo (D105).
 */
function renderXReport(t, data, { club, settings }) {
  const r = data.summary;
  const cur = r.totals.currency || 'MXN';
  header(t, club, settings);
  title(t, 'CORTE X');
  t.center().line('Parcial - la caja sigue abierta').left();
  t.rule();
  t.row('Impreso', localTime(data.at || new Date(), club.timezone));
  if (data.location_name) t.row('Caja', data.location_name);
  t.row('Cajero', `${data.user_name}${data.role ? ` · ${ROLE_LABEL[data.role] || data.role}` : ''}`);
  t.row('Abrió', localTime(r.shift.started_at, club.timezone));
  if (data.authorized_by) t.row('Pidió', data.authorized_by);

  t.blank().rule();
  t.bold().line('COBRADO').boldOff();
  for (const l of r.totals.by_method || []) {
    t.row(`${METHOD_LABEL[l.method] || l.method}${l.count ? ` (${l.count})` : ''}`, money(l.amount, l.currency || cur));
  }
  if (!(r.totals.by_method || []).length) t.line('Sin cobros todavía.');
  t.bold().row('Total cobrado', money(r.totals.total_collected, cur)).boldOff();
  if (Number(r.totals.door_people) > 0) t.row('Personas que entraron', String(r.totals.door_people));
  if (Number(r.totals.tips.amount) > 0) {
    t.row(`Propinas (${r.totals.tips.count || 0}) - no se entregan`, money(r.totals.tips.amount, cur));
  }

  t.blank().rule();
  t.bold().line('EFECTIVO EN CAJA').boldOff();
  if (Number(r.opening_float) > 0) t.row('Fondo de caja', money(r.opening_float, cur));
  t.row('Efectivo cobrado', money(r.totals.cash_collected, cur));
  if (Number(r.cash_ins_total) > 0) t.row('Entradas de efectivo', money(r.cash_ins_total, cur));
  if (Number(r.totals.usd.change_given_mxn) > 0) t.row('Cambio por dólares', `-${money(r.totals.usd.change_given_mxn, cur)}`);
  if (Number(r.drops_received) > 0) t.row('Menos retiros', `-${money(r.drops_received, cur)}`);
  t.rule();
  t.bold().tall();
  t.raw(escpos.twoColumns('DEBE TENER', money(r.cash_to_hand, cur), t.width));
  t.normal().boldOff();

  if (r.has_usd) {
    t.blank().rule();
    t.bold().line('DÓLARES').boldOff();
    if (Number(r.opening_float_usd) > 0) t.row('Fondo en dólares', money(r.opening_float_usd, 'USD'));
    t.row('Dólares recibidos', money(r.totals.usd.received, 'USD'));
    if (Number(r.usd_cash_ins_total) > 0) t.row('Entradas en dólares', money(r.usd_cash_ins_total, 'USD'));
    if (Number(r.usd_drops_received) > 0) t.row('Menos retiros', `-${money(r.usd_drops_received, 'USD')}`);
    t.bold().row('Debe tener', money(r.usd_to_hand, 'USD')).boldOff();
  }

  if ((r.pending_orders || []).length) {
    t.blank().rule();
    t.row(`Sin cobrar (${r.pending_orders.length})`, money(r.pending_total, cur));
  }
  t.blank().center().line('No es un corte de cierre.').left();
  footer(t, settings);
  t.blank(2).cut();
}

async function printXReport(runner, {
  nightclubId, summary, locationId, locationName, userName, role, authorizedBy, userId = null,
  tillId = null,
}) {
  const printer = await cashPaperPrinter(runner, {
    nightclubId, locationId, section: summary.shift.section,
    tillId: tillId || (summary.shift && summary.shift.till_id) || null,
  });
  if (!printer) return null;
  const club = await clubOf(runner, nightclubId);
  const settings = await printing.settingsOf(runner, nightclubId);
  return printing.enqueue(runner, {
    nightclubId,
    printer,
    kind: 'x_report',
    refId: summary.shift.id,
    createdBy: userId,
    ...build(printer, (t) => renderXReport(t, {
      summary, location_name: locationName, user_name: userName, role,
      authorized_by: authorizedBy, at: new Date(),
    }, { club, settings })),
  });
}

// ---------------------------------------------------------------- copia de un recibo (D122)

/**
 * La copia de un recibo que pide el cajero: el MISMO papel, byte por byte, con un
 * aviso arriba de que es copia, quién la pidió y a qué hora. Igual que la comanda
 * reimpresa (D62): una copia que se ve idéntica al original es cómo un recibo se usa
 * dos veces.
 */
function copyBanner(printer, { requestedBy, at, timezone }) {
  const t = escpos.ticket({
    columns: printer.columns, codepage: printer.codepage, hasCutter: printer.has_cutter,
  });
  t.center().bold().tall('** COPIA - REIMPRESION **').normal().boldOff();
  t.line(`Reimprimió: ${requestedBy || '—'}  ${localTime(at || new Date(), timezone)}`);
  t.left().rule();
  return t.build();
}

async function reprintReceiptCopy(runner, { nightclubId, job, userId }) {
  const printer = await printing.getPrinter(runner, { nightclubId, printerId: job.printer_id });
  if (!printer || !printer.active) return null;
  const club = await clubOf(runner, nightclubId);
  const quien = await nameOf(runner, userId);
  const banner = copyBanner(printer, { requestedBy: quien, timezone: club.timezone });
  return printing.enqueue(runner, {
    nightclubId,
    printer,
    kind: 'receipt',
    // La copia apunta al mismo cobro que el original.
    refId: job.transaction_id || job.ref_id,
    createdBy: userId,
    payload: Buffer.concat([banner.bytes, job.payload]),
    preview: `${banner.text}\n${job.preview}`,
  });
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
  orderData, renderOrder, printOrder, reprintOrder, REPRINTABLE, orderPaymentLabel, itemLines,
  billWindow, billData, renderBill, printBill,
  receiptData, renderReceipt, printReceipt,
  admissionData, renderAdmission, printAdmission, ADMISSION_KIND_LABEL,
  cutData, renderCut, printShiftCut, ROLE_LABEL,
  dropData, renderDrop, printCashDrop,
  renderNightCut, printNightCut, differenceLabel, header, footer, textLines,
  cashInData, renderCashIn, printCashIn, renderXReport, printXReport,
  copyBanner, reprintReceiptCopy,
  build,
};
