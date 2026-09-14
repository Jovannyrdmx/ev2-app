/**
 * EV2 — panel del gerente (paso 5.5).
 *
 * Lo que decide qué números ve y qué puede guardar. Está aparte de la pantalla porque
 * un número mal leído aquí no se nota: la caja de la noche, si un conductor puede
 * trabajar, y cuántos cajones se dieron de alta de verdad al pegar una lista.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2Manager = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- la caja de la noche

  /**
   * Lo que entró esta noche, separado como lo separa el servidor.
   *
   * `total` es del club. Las propinas son del empleado y el viaje es del conductor:
   * pasan por el libro mayor para poder auditar la noche, no porque sean ingreso del
   * club. Sumarlos infla la caja, así que aquí van en renglones distintos.
   */
  function revenueFor(rows, currency) {
    const row = (rows || []).find((r) => r.currency === currency)
      || (rows || [])[0]
      || { currency: currency || 'MXN', total: '0.00', count: 0, to_staff: '0.00', to_drivers: '0.00' };
    return {
      currency: row.currency || currency || 'MXN',
      club: row.total || '0.00',
      count: Number(row.count) || 0,
      staff: row.to_staff || '0.00',
      drivers: row.to_drivers || '0.00',
    };
  }

  /** Las monedas presentes esta noche, para poder elegir cuál se mira. */
  const currenciesIn = (rows) => [...new Set((rows || []).map((r) => r.currency).filter(Boolean))];

  const pct = (part, whole) => {
    const p = Number(part);
    const w = Number(whole);
    if (!Number.isFinite(p) || !Number.isFinite(w) || w <= 0) return 0;
    return Math.round((p / w) * 100);
  };

  /**
   * Lo que el gerente mira de un vistazo. Devuelve claves de idioma, no textos: la
   * pantalla los traduce.
   */
  function summary(dashboard, currency) {
    const d = dashboard || {};
    const tables = d.tables || {};
    const orders = d.orders || {};
    const money = revenueFor(d.revenue_today, currency);
    return {
      occupancy: {
        occupied: Number(tables.occupied) || 0,
        total: Number(tables.total) || 0,
        pct: pct(tables.occupied, tables.total),
      },
      orders: {
        inProgress: Number(orders.in_progress) || 0,
        ready: Number(orders.ready) || 0,
        delivered: Number(orders.delivered_today) || 0,
        // Un pedido que la caja rechazó no se sirve solo: hay que verlo.
        posErrors: Number(orders.pos_errors) || 0,
      },
      staffOnShift: Number((d.staff || {}).on_shift) || 0,
      money,
    };
  }

  // ---------------------------------------------------------------- conductores

  /**
   * En qué estado está un conductor, en una sola palabra.
   *
   * Son tres cosas distintas y se confunden: dado de baja, sin verificar, y disponible.
   * Solo un conductor activo Y verificado recibe solicitudes — es la misma condición
   * que aplica el servidor al listar ofertas.
   */
  function driverState(driver) {
    const d = driver || {};
    if (!d.active) return 'inactive';
    if (!d.trusted) return 'unverified';
    if (d.availability === 'on_trip') return 'onTrip';
    if (d.availability === 'available') return d.at_venue ? 'atVenue' : 'available';
    return 'off';
  }

  /** Si le pueden llegar solicitudes ahora mismo. */
  const canReceiveRides = (driver) => Boolean(driver && driver.active && driver.trusted);

  const vehicleOf = (driver) => {
    const d = driver || {};
    const parts = [d.vehicle_color, d.vehicle_make, d.vehicle_model].filter(Boolean);
    const body = parts.join(' ');
    if (!d.vehicle_plate) return body || null;
    return body ? `${body} · ${d.vehicle_plate}` : d.vehicle_plate;
  };

  /**
   * Comprueba antes de mandar. No sustituye al servidor: evita que el gerente pierda
   * el formulario lleno por un error que se ve desde aquí. Devuelve `{ campo: clave }`.
   */
  function validateDriver(form, now) {
    const errors = {};
    const text = (v) => String(v === null || v === undefined ? '' : v).trim();

    if (!text(form.first_name)) errors.first_name = 'manager.errRequired';
    if (!text(form.last_name)) errors.last_name = 'manager.errRequired';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text(form.email))) errors.email = 'manager.errEmail';

    const phone = text(form.phone);
    if (phone.length < 7 || phone.length > 30) errors.phone = 'manager.errPhone';

    const plate = text(form.vehicle_plate);
    if (plate.length < 3 || plate.length > 20) errors.vehicle_plate = 'manager.errPlate';

    const birth = text(form.birth_date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) {
      errors.birth_date = 'manager.errDate';
    } else {
      const age = yearsSince(birth, now);
      // El servidor también lo comprueba; aquí se dice antes, y con el motivo.
      if (age === null) errors.birth_date = 'manager.errDate';
      else if (age < 18) errors.birth_date = 'manager.errUnderage';
    }
    return errors;
  }

  /** Años cumplidos, sin librerías de fechas y sin desfase por el mes. */
  function yearsSince(isoDate, now) {
    const born = new Date(`${isoDate}T00:00:00Z`);
    if (Number.isNaN(born.getTime())) return null;
    const today = new Date(now || Date.now());
    let age = today.getUTCFullYear() - born.getUTCFullYear();
    const monthDiff = today.getUTCMonth() - born.getUTCMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getUTCDate() < born.getUTCDate())) age -= 1;
    return age;
  }

  // ---------------------------------------------------------------- cajones

  /**
   * Convierte lo que el gerente escribe en cajones. Acepta lista suelta ("A1, A2, A3"),
   * saltos de línea, y rangos ("A1-A20"), porque nadie va a teclear cien cajones de uno
   * en uno.
   *
   * Devuelve `{ spots, invalid }`: lo que no se pudo entender se DEVUELVE, no se tira en
   * silencio — si el gerente pega cien y se dan de alta noventa, tiene que verlo.
   */
  function parseSpots(text, zone) {
    const spots = [];
    const invalid = [];
    const seen = new Set();
    const clean = String(text || '').split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean);
    const area = String(zone || '').trim() || null;

    const push = (code) => {
      const value = code.trim().toUpperCase();
      if (!value || value.length > 20) { invalid.push(code.trim()); return; }
      if (seen.has(value)) return; // repetido en la misma pegada: no es un error
      seen.add(value);
      spots.push(area ? { code: value, zone: area } : { code: value });
    };

    for (const piece of clean) {
      // "A1-A20" o "1-20": mismo prefijo y números crecientes.
      const range = piece.match(/^([A-Za-z]*)\s*(\d+)\s*-\s*([A-Za-z]*)\s*(\d+)$/);
      if (range) {
        const [, prefixA, fromRaw, prefixB, toRaw] = range;
        const from = Number(fromRaw);
        const to = Number(toRaw);
        const samePrefix = prefixA.toUpperCase() === prefixB.toUpperCase() || prefixB === '';
        // Un rango al revés o descomunal es un dedazo, no una intención.
        if (samePrefix && to >= from && to - from <= 300) {
          const width = fromRaw.length === toRaw.length ? fromRaw.length : 0;
          for (let n = from; n <= to; n += 1) {
            push(prefixA + (width ? String(n).padStart(width, '0') : String(n)));
          }
          continue;
        }
        invalid.push(piece);
        continue;
      }
      push(piece);
    }
    return { spots, invalid };
  }

  /** Ocupación del estacionamiento, sin dividir entre cero. */
  function occupancy(state) {
    const s = state || {};
    const total = Number(s.total) || 0;
    const occupied = Number(s.occupied) || 0;
    return { total, occupied, free: Math.max(total - occupied, 0), pct: pct(occupied, total) };
  }

  // ---------------------------------------------------------------- contraseñas temporales

  /**
   * El servidor devuelve la contraseña temporal UNA sola vez, al crear al empleado o al
   * reiniciarla. Si la pantalla la pierde, no hay forma de recuperarla y hay que volver
   * a reiniciarla. Esto la guarda en memoria hasta que el gerente la descarta.
   */
  function createSecretBox() {
    let current = null;
    return {
      hold(who, password) {
        if (!password) return null;
        current = { who, password, at: Date.now() };
        return current;
      },
      peek: () => current,
      clear() { current = null; },
    };
  }

  // ---------------------------------------------------------------- noches del club

  /**
   * Las noches, la más próxima primero, y después el historial hacia atrás.
   *
   * El gerente abre esta pestaña para dos cosas distintas: publicar la noche que viene,
   * y revisar cuánta gente reservó la que pasó. Mezclarlas en orden de fecha deja la
   * más urgente enterrada entre las viejas.
   */
  function sortNights(events, now) {
    const when = now ? new Date(now) : new Date();
    const future = [];
    const past = [];
    for (const e of (events || [])) {
      if (!e || !e.id) continue;
      const at = new Date(e.doors_open_at || e.event_date || 0);
      (at >= when ? future : past).push(e);
    }
    future.sort((a, b) => new Date(a.doors_open_at || a.event_date || 0)
      - new Date(b.doors_open_at || b.event_date || 0));
    past.sort((a, b) => new Date(b.doors_open_at || b.event_date || 0)
      - new Date(a.doors_open_at || a.event_date || 0));
    return future.concat(past);
  }

  const NIGHT_STATUS_KEY = {
    draft: 'night.stDraft',
    published: 'night.stPublished',
    cancelled: 'night.stCancelled',
    finished: 'night.stFinished',
  };

  const nightStatusLabel = (status) => NIGHT_STATUS_KEY[status] || 'night.stDraft';

  /**
   * Qué se puede hacer con una noche.
   *
   * Una noche en borrador no la ve NADIE: mientras siga así, ningún cliente puede
   * reservar. Publicar es el acto que abre el club, y por eso es el botón principal.
   * Una noche con reservaciones vivas se cancela, nunca se borra: el dinero apartado
   * tiene que seguir teniendo a qué apuntar.
   */
  function nightActions(event) {
    const e = event || {};
    const booked = Number(e.reservations_count) || 0;
    return {
      canPublish: e.status === 'draft',
      canUnpublish: e.status === 'published' && booked === 0,
      canCancel: ['draft', 'published'].includes(e.status),
      canDelete: e.status !== 'cancelled' && booked === 0,
      booked,
    };
  }

  /**
   * Comprueba la noche antes de mandarla. Devuelve un objeto de errores por campo,
   * vacío si todo está bien.
   */
  function validateNight(form, now) {
    const errors = {};
    const f = form || {};
    const when = now ? new Date(now) : new Date();

    if (!String(f.name || '').trim()) errors.name = 'night.errName';
    if (!f.event_date) errors.event_date = 'night.errDate';

    const doors = f.doors_open_at ? new Date(f.doors_open_at) : null;
    if (!doors || Number.isNaN(doors.getTime())) errors.doors_open_at = 'night.errDoors';
    else if (doors <= when) errors.doors_open_at = 'night.errPast';

    if (f.closes_at) {
      const closes = new Date(f.closes_at);
      // Cerrar antes de abrir suena imposible, pero pasa: el club cierra a las 4 de la
      // MAÑANA SIGUIENTE, y quien captura pone la misma fecha en las dos casillas.
      if (Number.isNaN(closes.getTime()) || (doors && closes <= doors)) {
        errors.closes_at = 'night.errCloses';
      }
    }

    const price = Number(f.ticket_price);
    if (!Number.isFinite(price) || price < 0) errors.ticket_price = 'night.errPrice';

    // El anticipo de la noche es OPCIONAL: vacio significa "el del club". Solo se
    // valida cuando el gerente escribio algo, y ahi si tiene que ser un porcentaje
    // de verdad -- un 150% capturado de prisa se le cobraria a cada mesa.
    const dep = f.deposit_pct;
    if (dep !== undefined && dep !== null && String(dep).trim() !== '') {
      const pct = Number(dep);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) errors.deposit_pct = 'night.errDeposit';
    }

    return errors;
  }

  /** Lo que se manda al crear una noche. Las fechas viajan en ISO, con zona. */
  function nightPayload(form) {
    const body = {
      name: String(form.name || '').trim().slice(0, 150),
      event_date: form.event_date,
      doors_open_at: new Date(form.doors_open_at).toISOString(),
      ticket_price: Number(Number(form.ticket_price || 0).toFixed(2)),
      currency: form.currency || 'MXN',
      // Se crea en borrador siempre: publicar es un segundo toque, a propósito. Abrir
      // el club por accidente al capturar es peor que un toque de más.
      status: 'draft',
    };
    if (form.closes_at) body.closes_at = new Date(form.closes_at).toISOString();
    if (form.arrival_deadline_minutes) {
      body.arrival_deadline_minutes = Number(form.arrival_deadline_minutes);
    }
    const description = String(form.description || '').trim();
    if (description) body.description = description.slice(0, 2000);
    // El anticipo de la noche solo se manda si el gerente escribio algo. Vacio
    // quiere decir "usa el del club", y mandar un 0 en su lugar convertiria cada
    // noche normal en una noche que se aparta gratis.
    const dep = form.deposit_pct;
    if (dep !== undefined && dep !== null && String(dep).trim() !== '') {
      body.deposit_pct = Number(dep);
    }
    return body;
  }

  // ------------------------------------------------------- moderación de reportes

  /**
   * Los reportes de una persona sobre otra (acoso, menor de edad, perfil falso).
   *
   * Aquí no se decide nada sobre el contenido de un flirt: el gerente NUNCA ve el
   * mensaje, solo quién reportó a quién, por qué y cuándo. Lo que se decide es el
   * orden en que se atienden y qué se le deja hacer al gerente en cada estado.
   */

  const REPORT_REASON_KEY = {
    harassment: 'mod.rsHarassment',
    underage: 'mod.rsUnderage',
    fake_profile: 'mod.rsFake',
    other: 'mod.rsOther',
  };
  const REPORT_STATUS_KEY = {
    open: 'mod.stOpen',
    reviewed: 'mod.stReviewed',
    actioned: 'mod.stActioned',
    dismissed: 'mod.stDismissed',
  };
  const reportReasonKey = (reason) => REPORT_REASON_KEY[reason] || 'mod.rsOther';
  const reportStatusKey = (status) => REPORT_STATUS_KEY[status] || 'mod.stOpen';

  /**
   * Qué tan urgente es. "Menor de edad" sube solo: es lo único de esta lista que puede
   * cerrar el club. Y la segunda queja contra la misma persona importa más que la
   * primera, porque el servidor ya la esconde de la lista a partir de dos.
   */
  function reportSeverity(report) {
    const r = report || {};
    if (r.reason === 'underage') return 'urgent';
    if ((Number(r.reports_against) || 0) >= 2) return 'urgent';
    if (r.reason === 'harassment') return 'high';
    return 'normal';
  }

  const SEVERITY_RANK = { urgent: 0, high: 1, normal: 2 };

  /**
   * El orden de la bandeja: lo abierto primero, dentro de eso lo grave primero, y a
   * igualdad lo más viejo primero.
   *
   * Lo más VIEJO y no lo más nuevo a propósito: una queja de acoso que lleva dos horas
   * sin mirarse es peor que una de hace dos minutos, y ordenar por novedad la hunde.
   */
  function sortReports(reports) {
    return (reports || []).slice().sort((a, b) => {
      const oa = a.status === 'open' ? 0 : 1;
      const ob = b.status === 'open' ? 0 : 1;
      if (oa !== ob) return oa - ob;
      const sa = SEVERITY_RANK[reportSeverity(a)];
      const sb = SEVERITY_RANK[reportSeverity(b)];
      if (sa !== sb) return sa - sb;
      return new Date(a.created_at || 0) - new Date(b.created_at || 0);
    });
  }

  /**
   * Qué botones se le enseñan al gerente. Un reporte ya resuelto no se re-resuelve: el
   * servidor lo aceptaría, pero volver a "revisado" algo que ya bloqueó una cuenta deja
   * al gerente creyendo que la desbloqueó, y no es así.
   */
  function reportActions(report) {
    const status = (report || {}).status;
    if (status === 'open') return ['reviewed', 'actioned', 'dismissed'];
    if (status === 'reviewed') return ['actioned', 'dismissed'];
    return [];
  }

  /**
   * Comprueba la resolución antes de mandarla. Devuelve la clave del error o null.
   *
   * "Bloquear la cuenta" exige una nota escrita, y no por burocracia: bloquea a una
   * persona de verdad, le cierra la sesión y la saca de su mesa. Si dentro de un mes
   * esa persona reclama, la nota es lo único que el club tiene para explicar por qué.
   */
  function validateResolution(status, note) {
    if (['reviewed', 'actioned', 'dismissed'].indexOf(status) === -1) return 'mod.errStatus';
    const text = String(note == null ? '' : note).trim();
    if (status === 'actioned' && text.length < 10) return 'mod.errNote';
    if (text.length > 500) return 'mod.errNoteLong';
    return null;
  }

  /** Lo que se manda al resolver un reporte. */
  function resolutionPayload(status, note) {
    const body = { status };
    const text = String(note == null ? '' : note).trim().slice(0, 500);
    if (text) body.resolution_note = text;
    return body;
  }

  /** El resumen de arriba: cuántos esperan y cuántos se resolvieron. */
  function moderationSummary(reports) {
    const list = reports || [];
    return {
      open: list.filter((r) => r.status === 'open').length,
      urgent: list.filter((r) => r.status === 'open' && reportSeverity(r) === 'urgent').length,
      actioned: list.filter((r) => r.status === 'actioned').length,
      total: list.length,
    };
  }

  /**
   * Un evento del socket que toca la bandeja de moderación. El marco real trae el tipo
   * en `event_type`; `type` siempre vale 'event'.
   */
  const affectsModeration = (message) => (message && (message.event_type || message.type)) === 'user_reported';


  // ---------------------------------------------------------------- recetas y costos

  /**
   * El margen de un producto: lo que queda despues de pagar lo que lleva dentro.
   *
   * Es el numero que el dueno mira para decidir precios, y el que nadie podia ver:
   * el costo del trago vivia en la cabeza de quien arma la receta. Se calcula en
   * centavos enteros porque un margen con dos decimales mal redondeados, multiplicado
   * por mil tragos en una noche, es una decision tomada sobre un numero falso.
   *
   * `cost` es cero cuando todavia no se ha recibido mercancia (no hay costo promedio):
   * en ese caso el margen no se inventa, se reporta `null`.
   */
  function recipeMargin(recipe) {
    const price = Math.round(Number((recipe && recipe.price) || 0) * 100);
    const cost = Math.round(Number((recipe && recipe.cost) || 0) * 100);
    if (!(price > 0)) return { price: 0, cost: cost / 100, profit: null, pct: null };
    if (!(cost > 0)) return { price: price / 100, cost: 0, profit: null, pct: null };
    const profit = price - cost;
    return {
      price: price / 100,
      cost: cost / 100,
      profit: profit / 100,
      pct: Math.round((profit / price) * 1000) / 10,
    };
  }

  /**
   * Las recetas ordenadas como las necesita el gerente: primero lo que NO tiene receta
   * (no tiene control de existencia), y despues lo de menor margen, que es donde se
   * esta perdiendo dinero sin que nadie lo vea.
   */
  function sortRecipes(recipes, { search = '' } = {}) {
    const needle = String(search || '').trim().toLowerCase();
    return (recipes || [])
      .filter((r) => !needle || String(r.name || '').toLowerCase().includes(needle))
      .map((r) => Object.assign({}, r, { margin: recipeMargin(r) }))
      .sort((a, b) => {
        const sinA = (a.items || []).length === 0 ? 0 : 1;
        const sinB = (b.items || []).length === 0 ? 0 : 1;
        if (sinA !== sinB) return sinA - sinB;
        const pa = a.margin.pct === null ? Infinity : a.margin.pct;
        const pb = b.margin.pct === null ? Infinity : b.margin.pct;
        if (pa !== pb) return pa - pb;
        return String(a.name).localeCompare(String(b.name), 'es');
      });
  }

  /**
   * Que falta para poder guardar una receta. Devuelve la razon, no un booleano.
   *
   * Una receta VACIA es valida a proposito: es como se apaga el control de existencia
   * de un producto que el club vende sin descontar nada (un cover, una cortesia).
   */
  function validateRecipe(lines) {
    const items = (lines || []).filter((l) => l && l.supply_id);
    const ids = items.map((l) => l.supply_id);
    if (new Set(ids).size !== ids.length) return 'duplicate_supply';
    if (items.some((l) => !(Number(l.quantity) > 0))) return 'bad_quantity';
    if (items.length > 20) return 'too_many';
    return null;
  }

  /** El cuerpo que espera la API: solo insumo y cantidad, nada de nombres. */
  function recipePayload(lines) {
    return {
      items: (lines || [])
        .filter((l) => l && l.supply_id && Number(l.quantity) > 0)
        .map((l) => ({ supply_id: l.supply_id, quantity: Number(l.quantity) })),
    };
  }

  return {
    revenueFor,
    recipeMargin,
    sortRecipes,
    validateRecipe,
    recipePayload,
    currenciesIn,
    summary,
    pct,
    driverState,
    canReceiveRides,
    vehicleOf,
    validateDriver,
    yearsSince,
    parseSpots,
    occupancy,
    createSecretBox,
    sortNights,
    nightStatusLabel,
    nightActions,
    validateNight,
    nightPayload,
    reportReasonKey,
    reportStatusKey,
    reportSeverity,
    sortReports,
    reportActions,
    validateResolution,
    resolutionPayload,
    moderationSummary,
    affectsModeration,
  };
}));
