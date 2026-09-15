/**
 * EV2 — el corte de la noche del lado del navegador: la aritmética y la lectura.
 *
 * El servidor entrega los números; esto decide qué significan y cómo se leen. Va
 * aparte del DOM porque es donde se equivoca uno sin que nadie lo note hasta que
 * el gerente toma una decisión con una cifra mal comparada.
 *
 * ---------------------------------------------------------------------------
 * Las tres cosas que este archivo se niega a hacer
 * ---------------------------------------------------------------------------
 *
 * 1. **Comparar noches de distinta moneda.** Un viernes en pesos y un sábado en
 *    dólares no se comparan sumando: la diferencia saldría cuatro veces más
 *    grande de lo que es. Se dice que no se pueden comparar y ya.
 *
 * 2. **Meter las propinas en el total del club.** Son de la persona. El servidor
 *    las manda con un nombre que lo grita (`tips_not_club_revenue`) y aquí se
 *    respeta.
 *
 * 3. **Inventar un porcentaje cuando el denominador es cero.** Un martes sin
 *    reservaciones no tuvo 0% ni 100% de no-shows: no tuvo el dato, y eso se
 *    devuelve como `null` para que la pantalla ponga una raya en vez de un número
 *    que miente.
 */
/* global module */
(function (root, factory) {
  'use strict';
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  root.EV2NightReport = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const num = (n) => Number(n || 0);
  const money = (n) => Math.round(num(n) * 100) / 100;

  /**
   * Un porcentaje, o `null` cuando no hay de qué sacarlo.
   *
   * Cero por ciento y "no hubo" son cosas distintas: una noche sin reservaciones
   * no tuvo 0% de no-shows, no tuvo el dato. Devolver 0 lo convertiría en un
   * resultado bueno.
   */
  function pct(part, whole) {
    const total = num(whole);
    if (!(total > 0)) return null;
    return Math.round((num(part) / total) * 100);
  }

  /**
   * Los cuatro números que el gerente mira primero, en orden.
   *
   * Es deliberadamente corto: un tablero con veinte cifras no se lee a la una de
   * la mañana desde un teléfono. Lo demás está abajo, para quien lo busque.
   */
  function headline(stats) {
    if (!stats) return null;
    const s = stats;
    return {
      revenue: money(s.revenue && s.revenue.total),
      attendance: num(s.attendance && s.attendance.total),
      occupancy: num(s.tables && s.tables.occupancy),
      per_person: money(s.per_person),
      currency: s.currency || 'MXN',
    };
  }

  /**
   * Lo que hay que mirar de esta noche: lo que salió mal o raro, con su motivo.
   *
   * No es una lista de alertas de sistema: son las tres o cuatro cosas por las que
   * un gerente cambiaría algo mañana. Cada una dice el número, para que no haya
   * que ir a buscarlo.
   */
  function flags(stats) {
    if (!stats) return [];
    const out = [];
    const r = stats.reservations || {};
    const noShowPct = pct(r.no_show, r.booked);

    // Una mesa apartada que no llegó no se vendió dos veces. Es la pérdida más
    // silenciosa de la noche.
    if (num(r.no_show) > 0) {
      out.push({
        key: 'no_show', tone: 'warn',
        count: num(r.no_show), pct: noShowPct,
      });
    }
    // Una zona que no se llenó a la mitad es un precio mal puesto o un plano mal
    // repartido, y solo se nota comparándola con las demás.
    for (const zone of stats.zones || []) {
      if (num(zone.tables_total) > 0 && num(zone.occupancy) < 50) {
        out.push({
          key: 'cold_zone', tone: 'info',
          section: zone.section, occupancy: num(zone.occupancy),
        });
      }
    }
    // Producto que se fue sin venderse. Al costo, así que la cifra es real.
    if (money(stats.shrinkage && stats.shrinkage.value) > 0) {
      out.push({
        key: 'shrinkage', tone: 'bad',
        value: money(stats.shrinkage.value),
      });
    }
    // Pedidos cancelados: si son muchos, o falta producto o falta gente.
    if (num(stats.bar && stats.bar.cancelled) > 0) {
      out.push({
        key: 'cancelled_orders', tone: 'warn',
        count: num(stats.bar.cancelled), value: money(stats.bar.cancelled_value),
      });
    }
    // Quien quedó en el rol y no marcó entrada, no llegó.
    const staff = stats.staff || {};
    if (num(staff.assigned) > num(staff.showed_up)) {
      out.push({
        key: 'missing_staff', tone: 'warn',
        count: num(staff.assigned) - num(staff.showed_up), assigned: num(staff.assigned),
      });
    }
    return out;
  }

  /** Las zonas ordenadas por lo que dejaron, con la más fría al final. */
  function zonesByRevenue(stats) {
    return [...((stats && stats.zones) || [])]
      .sort((a, b) => num(b.revenue) - num(a.revenue) || a.section.localeCompare(b.section));
  }

  /** Lo que más se vendió. Vacío si no se vendió nada, no un cero disfrazado. */
  function topCategories(stats, limit = 5) {
    return [...(((stats && stats.bar) || {}).by_category || [])]
      .sort((a, b) => num(b.revenue) - num(a.revenue))
      .slice(0, limit);
  }

  /**
   * Compara dos cortes GUARDADOS.
   *
   * Solo cortes guardados: comparar el corte en vivo de hoy con el cerrado del
   * viernes compara media noche contra una completa, y el resultado siempre dice
   * que hoy va peor.
   *
   * Y solo entre la misma moneda: sumar pesos con dólares da una diferencia cuatro
   * veces más grande de lo que es.
   */
  function compare(a, b) {
    if (!a || !b) return null;
    if (a.currency !== b.currency) {
      return { comparable: false, reason: 'different_currency' };
    }
    const campos = ['revenue_total', 'revenue_bar', 'revenue_door', 'revenue_tables',
      'attendance', 'tables_used', 'orders_count', 'tips_total', 'shrinkage_value',
      'reservations_booked', 'reservations_arrived', 'reservations_no_show'];

    const diff = {};
    for (const campo of campos) {
      const antes = num(b[campo]);
      const ahora = num(a[campo]);
      diff[campo] = {
        from: antes,
        to: ahora,
        delta: Math.round((ahora - antes) * 100) / 100,
        // El porcentaje de cambio necesita una base: de cero a cien no es "infinito
        // por ciento", es "de nada a cien", y eso se dice con `null`.
        pct: antes > 0 ? Math.round(((ahora - antes) / antes) * 100) : null,
      };
    }
    return { comparable: true, currency: a.currency, diff };
  }

  /** Las noches cerradas, de la más reciente hacia atrás, listas para el selector. */
  function closingOptions(closings) {
    return (closings || []).map((c) => ({
      event_id: c.event_id,
      label: `${c.event_name || ''} · ${String(c.event_date).slice(0, 10)}`,
      revenue: money(c.revenue_total),
      currency: c.currency,
    }));
  }

  /**
   * ¿Se puede cerrar esta noche?
   *
   * No antes de que abra —un corte de una noche que no ha pasado son ceros
   * presentados como hechos— y no dos veces. El servidor lo niega igual; esto
   * existe para no ofrecer un botón que va a fallar.
   */
  function canClose({ stats, closed, now = new Date() }) {
    if (!stats) return { ok: false, reason: 'no_stats' };
    if (closed) return { ok: false, reason: 'already_closed' };
    if (new Date(stats.event.doors_open_at) > now) return { ok: false, reason: 'not_started' };
    return { ok: true };
  }

  return {
    pct,
    money,
    headline,
    flags,
    zonesByRevenue,
    topCategories,
    compare,
    closingOptions,
    canClose,
  };
}));
