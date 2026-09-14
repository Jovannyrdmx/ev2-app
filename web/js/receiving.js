/**
 * EV2 — entrada de mercancía en lote y pedidos de barra: la parte que se puede
 * probar sin navegador.
 *
 * `EV2Warehouse` sabe de UN movimiento. Esto sabe de una CAPTURA: quince renglones
 * que entran juntos, con su total, sus errores por renglón y su conversión de cajas
 * a mililitros. Es aritmética de inventario, así que va aparte y se prueba de
 * verdad, sin DOM y sin red.
 *
 * El servidor valida todo otra vez. Esto existe para que el almacenista vea el
 * error en el renglón nueve ANTES de mandar los quince, no para ser la única
 * defensa.
 *
 * ---------------------------------------------------------------------------
 * Por qué el borrador vive aquí y no en el DOM
 * ---------------------------------------------------------------------------
 * Una entrega son quince renglones capturados en dos minutos, con el camión
 * esperando. Si el borrador vive en los `<input>` de la pantalla, cualquier
 * repintado lo borra, y volver a capturarlo es exactamente el momento en que
 * alguien decide "ya, ponle que llegó todo". Aquí el borrador es un arreglo de
 * objetos y la pantalla es un reflejo suyo.
 */
/* global module */
(function (root, factory) {
  'use strict';
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  root.EV2Receiving = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Igual que el servidor: más de esto no es una entrega, es un error de captura. */
  const MAX_LINES = 100;

  const round3 = (n) => Math.round(Number(n) * 1000) / 1000;
  const money = (n) => Math.round(Number(n) * 100) / 100;

  /** Un renglón vacío, listo para capturar. */
  function emptyLine() {
    return { supply_id: null, mode: 'packages', amount: '', package_cost: '' };
  }

  /**
   * Cuánto es ese renglón, en la unidad base y en dinero.
   *
   * `mode` decide si el número capturado son presentaciones o unidad base. El costo
   * SIEMPRE es de la presentación completa, porque es lo que dice la factura: nadie
   * cotiza por mililitro. La división entre `package_size` pasa una sola vez, aquí.
   */
  function lineTotals(line, supply) {
    if (!supply) return { quantity: null, packages: null, total: null };
    const size = Number(supply.package_size);
    // `Number('')` es 0, no NaN. Sin este guardia, un renglón donde nadie escribió
    // la cantidad se leería como "entraron cero", que es un dato, y no como "falta
    // capturarlo", que es lo que de verdad pasa -- y el aviso diría "la cantidad
    // tiene que ser mayor que cero" en vez de "falta la cantidad".
    const escrito = line.amount;
    const vacio = escrito === '' || escrito === null || escrito === undefined;
    const amount = vacio ? NaN : Number(escrito);
    if (!Number.isFinite(amount) || !(size > 0)) {
      return { quantity: null, packages: null, total: null };
    }
    const packages = line.mode === 'packages' ? amount : amount / size;
    const quantity = line.mode === 'packages' ? round3(amount * size) : round3(amount);

    const cost = line.package_cost;
    const hasCost = cost !== '' && cost !== null && cost !== undefined && Number.isFinite(Number(cost));
    return {
      quantity,
      packages: Math.round(packages * 100) / 100,
      total: hasCost ? money(packages * Number(cost)) : null,
    };
  }

  /**
   * Lo que falta o está mal en el borrador, por renglón.
   *
   * Devuelve claves, no frases: la pantalla las traduce. Y devuelve TODAS, no la
   * primera, porque quien captura quince renglones necesita corregirlos de una
   * pasada.
   *
   * Un renglón completamente vacío NO es un error: es la línea en blanco del final,
   * y marcarla en rojo mientras la persona escribe es hostil. Se ignora al mandar.
   */
  function validateDraft(lines, supplies, { requireCost = false } = {}) {
    const problems = [];
    const usados = new Map();
    const porId = supplies instanceof Map
      ? supplies : new Map((supplies || []).map((s) => [s.id, s]));

    lines.forEach((line, index) => {
      const row = index + 1;
      if (isEmptyLine(line)) return;

      if (!line.supply_id) {
        problems.push({ row, field: 'supply', code: 'required' });
        return;
      }
      const supply = porId.get(line.supply_id);
      if (!supply) {
        problems.push({ row, field: 'supply', code: 'unknown' });
        return;
      }
      if (supply.active === false) {
        problems.push({ row, field: 'supply', code: 'inactive', name: supply.name });
        return;
      }
      if (usados.has(line.supply_id)) {
        problems.push({
          row, field: 'supply', code: 'duplicate', name: supply.name,
          first_row: usados.get(line.supply_id),
        });
        return;
      }
      usados.set(line.supply_id, row);

      const { quantity, total } = lineTotals(line, supply);
      if (quantity === null) problems.push({ row, field: 'amount', code: 'required' });
      else if (quantity <= 0) problems.push({ row, field: 'amount', code: 'positive' });

      if (line.package_cost !== '' && Number(line.package_cost) < 0) {
        problems.push({ row, field: 'package_cost', code: 'negative' });
      }
      if (requireCost && total === null) {
        problems.push({ row, field: 'package_cost', code: 'required' });
      }
    });

    if (lines.filter((l) => !isEmptyLine(l)).length === 0) {
      problems.push({ row: 0, field: 'lines', code: 'empty' });
    }
    if (lines.filter((l) => !isEmptyLine(l)).length > MAX_LINES) {
      problems.push({ row: 0, field: 'lines', code: 'too_many' });
    }
    return problems;
  }

  /** Un renglón en el que nadie ha escrito nada. */
  function isEmptyLine(line) {
    return !line
      || (!line.supply_id
        && (line.amount === '' || line.amount === null || line.amount === undefined)
        && (line.package_cost === '' || line.package_cost === null
          || line.package_cost === undefined));
  }

  /**
   * El resumen del borrador: cuántos renglones, cuánto dinero, y si el total cuadra.
   *
   * `total_is_complete` es lo que decide si la pantalla puede enseñar el total como
   * el de la factura. Con un renglón sin costo, el número sigue siendo cierto pero
   * ya no es comparable con el papel, y presentarlo como si lo fuera es peor que no
   * enseñarlo.
   */
  function draftSummary(lines, supplies) {
    const porId = supplies instanceof Map
      ? supplies : new Map((supplies || []).map((s) => [s.id, s]));
    let total = 0;
    let conCosto = 0;
    let usables = 0;

    for (const line of lines) {
      if (isEmptyLine(line)) continue;
      usables += 1;
      const { total: importe } = lineTotals(line, porId.get(line.supply_id));
      if (importe !== null) { total += importe; conCosto += 1; }
    }
    return {
      lines: usables,
      total: money(total),
      lines_with_cost: conCosto,
      total_is_complete: usables > 0 && conCosto === usables,
    };
  }

  /** El cuerpo que espera `POST /supply-receipts`. Los renglones vacíos no viajan. */
  function receiptRequest({ locationId, supplierId, lines, reason }) {
    return {
      location_id: locationId,
      ...(supplierId ? { supplier_id: supplierId } : {}),
      ...(reason && String(reason).trim() ? { reason: String(reason).trim() } : {}),
      lines: lines.filter((l) => !isEmptyLine(l)).map((line) => {
        const cuerpo = { supply_id: line.supply_id };
        cuerpo[line.mode === 'packages' ? 'packages' : 'quantity'] = Number(line.amount);
        if (line.package_cost !== '' && line.package_cost !== null
          && line.package_cost !== undefined) {
          cuerpo.package_cost = Number(line.package_cost);
        }
        return cuerpo;
      }),
    };
  }

  /**
   * Precarga los renglones de un proveedor: lo que surte, con lo que cobró la última
   * vez ya escrito.
   *
   * Es la diferencia entre capturar una entrega en dos minutos y buscar quince
   * insumos entre doscientos con el camión esperando. La cantidad se deja VACÍA a
   * propósito: el costo de la última vez es un dato del proveedor, pero la cantidad
   * es de esta entrega y sugerirla invita a aceptarla sin mirar.
   */
  function draftFromSupplier(supplies) {
    const lines = (supplies || []).map((s) => ({
      supply_id: s.supply_id || s.id,
      mode: 'packages',
      amount: '',
      package_cost: s.last_cost !== null && s.last_cost !== undefined ? String(s.last_cost) : '',
    }));
    lines.push(emptyLine());
    return lines;
  }

  // ======================================================================== pedidos

  /** Los estados de un pedido, y cómo se pintan. */
  const REQUEST_STATUS = {
    open: { key: 'open', pending: true, tone: 'warn' },
    partial: { key: 'partial', pending: true, tone: 'warn' },
    fulfilled: { key: 'fulfilled', pending: false, tone: 'ok' },
    cancelled: { key: 'cancelled', pending: false, tone: 'muted' },
  };

  const statusOf = (status) => REQUEST_STATUS[status] || { key: status, pending: false, tone: 'muted' };

  /**
   * Un pedido armado desde la lista de sugeridos.
   *
   * Solo entra lo que el almacén de verdad puede surtir. Lo que no hay allá no es un
   * pedido: es una compra, y mezclarlas hace que el almacenista persiga fantasmas
   * toda la noche. La pantalla enseña los otros aparte, como lista de compra.
   */
  function requestFromSuggested(suggested, { includeUnavailable = false } = {}) {
    return (suggested || [])
      .filter((s) => includeUnavailable || Number(s.warehouse_stock) > 0)
      .map((s) => ({
        supply_id: s.supply_id,
        mode: 'packages',
        amount: String(s.suggested_packages),
        package_cost: '',
      }));
  }

  /** El cuerpo de `POST /bar-requests`. */
  function requestBody({ locationId, lines, note }) {
    return {
      location_id: locationId,
      ...(note && String(note).trim() ? { note: String(note).trim() } : {}),
      lines: lines.filter((l) => !isEmptyLine(l)).map((line) => {
        const cuerpo = { supply_id: line.supply_id };
        cuerpo[line.mode === 'packages' ? 'packages' : 'quantity'] = Number(line.amount);
        return cuerpo;
      }),
    };
  }

  /**
   * Lo que el almacén va a mandar de un pedido: por omisión, todo lo que falte.
   *
   * Se arma desde `pending` y no desde `quantity`, que es la diferencia entre surtir
   * el resto de un pedido a medias y volver a mandar todo desde cero.
   */
  function fulfillDraft(request) {
    return (request.lines || [])
      .map((line) => ({
        supply_id: line.supply_id,
        name: line.name,
        unit: line.unit,
        package_size: Number(line.package_size),
        package_label: line.package_label,
        requested: Number(line.quantity),
        already: Number(line.fulfilled),
        pending: round3(Number(line.quantity) - Number(line.fulfilled)),
        mode: 'packages',
        amount: '',
      }))
      .filter((line) => line.pending > 0)
      .map((line) => ({
        ...line,
        // Sugerido en presentaciones, redondeado hacia arriba: nadie manda media
        // botella del almacén a la barra.
        amount: String(Math.ceil(line.pending / line.package_size)),
      }));
  }

  /**
   * ¿Qué va a quedar de este pedido si mando esto? Se contesta antes de mandarlo.
   *
   * Que el estado se pueda anticipar importa: el almacenista tiene que saber que va
   * a dejar el pedido a medias ANTES de mandarlo, para poder decírselo a la barra en
   * vez de que el cantinero lo descubra esperando.
   */
  function fulfillPreview(request, draft, stockBySupply = {}) {
    const porInsumo = new Map((request.lines || []).map((l) => [l.supply_id, l]));
    const lines = [];
    let completo = true;

    for (const line of request.lines || []) {
      const captura = (draft || []).find((d) => d.supply_id === line.supply_id);
      const size = Number(line.package_size);
      const manda = captura && captura.amount !== ''
        ? round3(captura.mode === 'packages' ? Number(captura.amount) * size : Number(captura.amount))
        : 0;
      const disponible = Number(stockBySupply[line.supply_id] ?? Infinity);
      const real = Math.min(manda, disponible);
      const despues = round3(Number(line.fulfilled) + real);
      const falta = round3(Number(line.quantity) - despues);
      if (falta > 0) completo = false;
      lines.push({
        supply_id: line.supply_id,
        name: line.name,
        requested: Number(line.quantity),
        sending: real,
        // Lo que se capturó de más respecto a lo que hay en el almacén. Es el aviso
        // que evita prometer producto que no está.
        short_of_draft: round3(manda - real),
        pending_after: falta,
      });
    }
    return {
      lines,
      status_after: completo ? 'fulfilled' : 'partial',
      short: lines.filter((l) => l.pending_after > 0),
      unknown: porInsumo.size === 0,
    };
  }

  /** Los renglones que viajan a `/fulfill`. */
  function fulfillBody({ fromLocationId, draft }) {
    const lines = (draft || [])
      .filter((l) => l.amount !== '' && Number(l.amount) > 0)
      .map((l) => {
        const cuerpo = { supply_id: l.supply_id };
        cuerpo[l.mode === 'packages' ? 'packages' : 'quantity'] = Number(l.amount);
        return cuerpo;
      });
    return { from_location_id: fromLocationId, ...(lines.length > 0 ? { lines } : {}) };
  }

  return {
    MAX_LINES,
    REQUEST_STATUS,
    round3,
    emptyLine,
    isEmptyLine,
    lineTotals,
    validateDraft,
    draftSummary,
    receiptRequest,
    draftFromSupplier,
    statusOf,
    requestFromSuggested,
    requestBody,
    fulfillDraft,
    fulfillPreview,
    fulfillBody,
  };
}));
