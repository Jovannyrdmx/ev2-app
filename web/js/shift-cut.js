/**
 * EV2 — el corte del turno, en la pantalla de quien cobra (D51).
 *
 * Contesta la pregunta que quien cobra —desde D77, el cajero de cada barra y la
 * puerta— se hace a las tres de la mañana: **¿cuánto de esto es del club?** Y da las dos únicas acciones
 * que hacen falta para responderla sin discutir: entregar una parte ahora, y cerrar
 * el turno entregando el resto.
 *
 * ---------------------------------------------------------------------------
 * Lo que NO hace
 * ---------------------------------------------------------------------------
 * No calcula lo cobrado. Ese número lo da el servidor a partir de lo que esa persona
 * de verdad cobró, y es justo el número que no puede salir de aquí: un corte donde
 * quien entrega también dice cuánto debía entregar no es un corte.
 *
 * Tampoco confirma nada. El empleado declara; contar el dinero y cerrar es del
 * gerente, en su panel. Esa separación es el punto entero de la función.
 */
/* global module */
(function (root, factory) {
  'use strict';
  // Preguntas con el cuadro de la app (js/ui.js), no con el confirm() del navegador.
  const ask = (text, opts) => (typeof window !== 'undefined' && window.EV2UI
    ? window.EV2UI.confirm(text, opts) : Promise.resolve(window.confirm(text)));

  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  root.EV2ShiftCut = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Cada método de pago con su nombre; el club los lee, no los códigos. */
  const METHOD_KEY = {
    cash: 'cut.mCash',
    cash_usd: 'cut.mCashUsd',
    vip_credit: 'cut.mVip',
    card_terminal: 'cut.mCard',
    zelle: 'cut.mZelle',
    cash_app: 'cut.mCashApp',
    bank_transfer: 'cut.mTransfer',
    spei: 'cut.mSpei',
  };
  const methodKey = (method) => METHOD_KEY[String(method)] || 'cut.mOther';

  const money = (n) => (Math.round(Number(n || 0) * 100) / 100).toFixed(2);

  /** Solo el efectivo se entrega: lo demás ya está en la cuenta del club. */
  const isCash = (method) => String(method) === 'cash';

  /** Si este turno recibió dólares (D86): entonces el corte cuenta dólares aparte. */
  const hasUsd = (cut) => Boolean(cut && cut.totals && cut.totals.usd
    && Number(cut.totals.usd.received) > 0);
  const usdText = (n) => `US$${money(n)}`;

  /**
   * Por qué no se puede hacer ese retiro. Devuelve la clave del motivo o null.
   *
   * Retirar de más no es un descuido: o el número está mal tecleado, o ese dinero no
   * es del club. Las dos cosas se paran antes de que alguien suelte los billetes.
   */
  function dropBlocker(amount, cut, { reason = '', pin = '', currency = 'MXN' } = {}) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return 'cut.errAmount';
    if (!cut || !cut.shift) return 'cut.errNoShift';
    if (cut.shift.ended_at) return 'cut.errShiftClosed';
    // Pesos y dólares salen cada uno de lo que hay de esa moneda (D86).
    const hay = currency === 'USD' ? cut.usd_to_hand : cut.cash_to_hand;
    if (n > Number(hay || 0)) return 'cut.errTooMuch';
    // El motivo y el código no son formalidades: son la función entera. Un retiro sin
    // ellos es exactamente el hueco que esto vino a tapar.
    if (String(reason).trim().length < 3) return 'cut.errReason';
    if (!/^\d{6}$/.test(String(pin))) return 'cut.errPin';
    return null;
  }

  /**
   * Por qué no se puede cerrar el corte todavía.
   *
   * `counted` es lo que el gerente contó, y la diferencia se mide contra lo que la
   * persona DEBÍA entregar —no contra lo que declaró—, igual que en el servidor.
   */
  function closeBlocker(declared, cut, {
    counted = null, reason = '', pin = '', acknowledgePending = false, countedUsd = null,
  } = {}) {
    const n = Number(declared);
    if (!Number.isFinite(n) || n < 0) return 'cut.errAmount';
    if (!cut || !cut.shift) return 'cut.errNoShift';
    if (cut.closing) return 'cut.errAlready';
    // La caja con pedidos de su barra sin cobrar (D77) no se cierra salvo que el
    // gerente que teclea su código lo acepte, marcándolo.
    if (pendingCount(cut) > 0 && !acknowledgePending) return 'cut.errPending';
    const contado = counted === null || counted === '' ? n : Number(counted);
    if (!Number.isFinite(contado) || contado < 0) return 'cut.errCounted';
    if (!/^\d{6}$/.test(String(pin))) return 'cut.errPin';
    const diferencia = Math.round((contado - Number(cut.cash_to_hand)) * 100) / 100;
    // Con dólares en el turno, se cuentan: "no los conté" no es "conté cero" (D86).
    let difUsd = 0;
    if (hasUsd(cut)) {
      if (countedUsd === null || countedUsd === '') return 'cut.errUsdCounted';
      const u = Number(countedUsd);
      if (!Number.isFinite(u) || u < 0) return 'cut.errUsdCounted';
      difUsd = usdDifference(u, cut);
    }
    if ((diferencia !== 0 || difUsd !== 0) && String(reason).trim().length < 5) return 'cut.errDiffReason';
    return null;
  }

  /** Cuánto se desvían los dólares contados de los que debía entregar. */
  function usdDifference(counted, cut) {
    if (!cut) return 0;
    return Math.round((Number(counted) - Number(cut.usd_to_hand || 0)) * 100) / 100;
  }

  /** Cuántos pedidos de su barra le quedan sin cobrar a una caja (D77). */
  function pendingCount(cut) {
    return ((cut && cut.pending_orders) || []).length;
  }

  /** Si este corte es de una caja: tiene fondo o tiene barra. */
  function isTill(cut) {
    return Boolean(cut && cut.shift && cut.shift.location_id);
  }

  /** Cuánto se desvía lo contado de lo que esa persona debía entregar. */
  function difference(counted, cut) {
    if (!cut) return 0;
    return Math.round((Number(counted) - Number(cut.cash_to_hand)) * 100) / 100;
  }

    /** Lo que el corte enseña, en el orden en que se lee. */
  function lines(cut, t) {
    if (!cut || !cut.totals) return [];
    const out = [];
    // El fondo con el que abrió la caja (D77) va primero: es dinero del club que
    // también se devuelve, y sin verlo el "por entregar" parece inflado.
    if (Number(cut.opening_float) > 0) {
      out.push({
        key: 'float', label: t('cut.float'), value: cut.opening_float, count: 0, cash: true,
      });
    }
    const out2 = out.concat(cut.totals.by_method.map((l) => ({
      key: l.method,
      label: t(methodKey(l.method)),
      value: l.amount,
      count: l.count,
      cash: isCash(l.method),
    })));
    // El cambio en pesos que se dio por cobros en dólares salió del cajón (D86).
    if (hasUsd(cut) && Number(cut.totals.usd.change_given_mxn) > 0) {
      out2.push({
        key: 'usd_change', label: t('cut.usdChange'), value: money(-Number(cut.totals.usd.change_given_mxn)),
        count: 0, cash: true,
      });
    }
    return out2.concat(tipsLine(cut, t));
  }

  function tipsLine(cut, t) {
    const out = [];
    if (Number(cut.totals.tips.amount) > 0) {
      out.push({
        key: 'tips', label: t('cut.tips'), value: cut.totals.tips.amount,
        count: cut.totals.tips.count, cash: false, aside: true,
      });
    }
    return out;
  }

  /** El estado del corte, dicho en una línea. */
  function statusKey(cut) {
    if (!cut || !cut.shift) return 'cut.noShift';
    // Desde D54 no existe el estado intermedio: el corte se hace en un acto, con el
    // gerente presente, o no se ha hecho.
    return cut.closing ? 'cut.confirmed' : 'cut.open';
  }

  // ---------------------------------------------------------------- el cuadro

  /**
   * Arma la hoja del corte y devuelve con qué abrirla. Se llama UNA vez por pantalla:
   * la barra y el piso usan exactamente la misma, porque es exactamente lo mismo.
   */
  function createSheet(deps) {
    const { api, clubId, t, onChange } = deps;
    const doc = deps.document || document;
    const dinero = deps.money || ((n) => `$${money(n)}`);

    const caja = doc.createElement('div');
    caja.id = 'cut-sheet';
    caja.hidden = true;
    caja.className = 'fixed inset-0 z-[75] flex items-end justify-center bg-black/80';
    caja.innerHTML = `
      <div class="w-full max-w-md rounded-t-2xl p-5 space-y-3 max-h-[90vh] overflow-y-auto"
           style="background:#12121f;border-top:1px solid rgba(255,255,255,.12)">
        <div class="flex items-center justify-between gap-2">
          <p class="font-display text-lg" id="cut-title">—</p>
          <button id="cut-close" class="card rounded-lg px-3 py-2 text-xs">—</button>
        </div>
        <p id="cut-status" class="text-xs text-white/50">—</p>
        <div id="cut-lines" class="space-y-1"></div>
        <div class="border-t border-white/10 pt-3 space-y-1">
          <div class="flex justify-between items-baseline">
            <span class="text-sm text-white/60" id="cut-handed-label">—</span>
            <span id="cut-handed" class="text-sm">—</span>
          </div>
          <div class="flex justify-between items-baseline">
            <span class="font-display" id="cut-tohand-label">—</span>
            <span id="cut-tohand" class="font-display text-2xl" style="color:var(--ev2-gold)">—</span>
          </div>
          <!-- Los dólares, aparte y sin convertir (D86). -->
          <div id="cut-usd-row" class="flex justify-between items-baseline" hidden>
            <span class="font-display" id="cut-usd-label">—</span>
            <span id="cut-usd" class="font-display text-2xl" style="color:var(--ev2-gold)">—</span>
          </div>
        </div>
        <div id="cut-drops" class="space-y-1"></div>
        <!-- Los pedidos de la barra que la caja no ha cobrado (D77). -->
        <div id="cut-pending-box" class="rounded-xl border border-amber-400/40 bg-amber-500/10 p-3 space-y-2" hidden>
          <p id="cut-pending" class="text-sm text-amber-100">—</p>
          <label class="flex items-start gap-2 text-xs text-white/70">
            <input id="cut-ack" type="checkbox" class="mt-0.5">
            <span id="cut-ack-label">—</span>
          </label>
        </div>
        <p id="cut-error" class="text-sm text-red-300" hidden></p>
        <div class="grid grid-cols-2 gap-2 pt-1">
          <input id="cut-amount" type="number" min="0" step="50" inputmode="decimal"
                 class="px-3 py-3 rounded-xl bg-white/5 border border-white/10 outline-none text-center col-span-2">
          <input id="cut-counted" type="number" min="0" step="50" inputmode="decimal"
                 class="px-3 py-3 rounded-xl bg-white/5 border border-white/10 outline-none text-center col-span-2">
          <input id="cut-usd-counted" type="number" min="0" step="1" inputmode="decimal" hidden
                 class="px-3 py-3 rounded-xl bg-white/5 border border-white/10 outline-none text-center col-span-2">
          <select id="cut-currency" hidden
                  class="px-3 py-3 rounded-xl bg-white/5 border border-white/10 outline-none col-span-2"></select>
          <input id="cut-reason" type="text" maxlength="200"
                 class="px-3 py-3 rounded-xl bg-white/5 border border-white/10 outline-none col-span-2">
          <!--
            El código del gerente, enmascarado: lo teclea él enfrente del empleado.
            Se borra en cuanto se usa, salga bien o mal, porque el aparato sigue
            siendo del mesero cuando el gerente quita el dedo.
          -->
          <input id="cut-pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off"
                 class="px-3 py-3 rounded-xl bg-white/5 border border-white/10 outline-none text-center col-span-2 tracking-[0.5em]">
          <p id="cut-pin-hint" class="text-[11px] text-white/40 col-span-2">—</p>
          <button id="cut-drop" class="card rounded-xl py-3 text-sm">—</button>
          <button id="cut-declare" class="ev2-button rounded-xl py-3 font-display text-sm">—</button>
        </div>
      </div>`;
    doc.body.appendChild(caja);

    const $ = (id) => doc.getElementById(id);
    const estado = { cut: null, busy: false };

    const avisar = (msg) => {
      $('cut-error').textContent = msg;
      $('cut-error').hidden = false;
    };

    function pintar(cut) {
      estado.cut = cut;
      $('cut-title').textContent = t('cut.title');
      $('cut-close').textContent = t('cut.close');
      $('cut-status').textContent = t(statusKey(cut));
      $('cut-handed-label').textContent = t('cut.handed');
      $('cut-tohand-label').textContent = t('cut.toHand');
      $('cut-drop').textContent = t('cut.drop');
      $('cut-declare').textContent = t('cut.declare');
      $('cut-amount').placeholder = t('cut.amount');
      $('cut-counted').placeholder = t('cut.counted');
      $('cut-usd-counted').placeholder = t('cut.usdCounted');
      $('cut-reason').placeholder = t('cut.reason');
      $('cut-pin').placeholder = t('cut.pin');
      $('cut-pin-hint').textContent = t('cut.pinHint');

      const box = $('cut-lines');
      box.innerHTML = '';
      for (const l of lines(cut, t)) {
        const fila = doc.createElement('div');
        fila.className = 'flex justify-between items-baseline text-sm';
        fila.innerHTML = '<span></span><span></span>';
        fila.firstChild.textContent = `${l.label}${l.count ? ` · ${l.count}` : ''}`;
        fila.firstChild.className = l.aside ? 'text-white/40' : 'text-white/60';
        fila.lastChild.textContent = Number(l.value) < 0 ? `-${dinero(Math.abs(Number(l.value)))}` : dinero(l.value);
        if (l.aside) fila.lastChild.className = 'text-white/40';
        box.appendChild(fila);
      }

      const pendientes = pendingCount(cut);
      $('cut-pending-box').hidden = !(pendientes > 0 && cut && !cut.closing);
      $('cut-pending').textContent = t('cut.pending', {
        n: pendientes, amount: dinero(cut && cut.pending_total),
      });
      $('cut-ack-label').textContent = t('cut.ackPending');
      if (pendientes === 0) $('cut-ack').checked = false;

      $('cut-handed').textContent = dinero(cut && cut.drops_received);
      $('cut-tohand').textContent = dinero(cut && cut.cash_to_hand);
      const dolares = hasUsd(cut);
      $('cut-usd-row').hidden = !dolares;
      $('cut-usd-label').textContent = t('cut.usdToHand');
      $('cut-usd').textContent = usdText(cut && cut.usd_to_hand);
      $('cut-usd-counted').hidden = !dolares;
      // El retiro escoge moneda solo cuando hay dólares que retirar.
      const antes = $('cut-currency').value || 'MXN';
      $('cut-currency').innerHTML = `<option value="MXN">${t('cut.curMxn')}</option>`
        + `<option value="USD">${t('cut.curUsd')}</option>`;
      $('cut-currency').value = dolares ? antes : 'MXN';
      $('cut-currency').hidden = !dolares;

      const drops = $('cut-drops');
      drops.innerHTML = '';
      for (const d of (cut && cut.drops) || []) {
        const p = doc.createElement('p');
        p.className = 'text-[11px]';
        p.style.color = d.status === 'received' ? 'var(--ev2-lime)'
          : d.status === 'rejected' ? '#fca5a5' : '#fcd34d';
        const cuanto = d.status === 'received' ? d.counted_amount : d.amount;
        p.textContent = t(`cut.drop.${d.status}`, {
          amount: d.currency === 'USD' ? usdText(cuanto) : dinero(cuanto),
        });
        drops.appendChild(p);
      }

      const puede = Boolean(cut && cut.shift && !cut.closing);
      $('cut-drop').disabled = !puede || Boolean(cut.shift.ended_at);
      $('cut-declare').disabled = !puede;
      for (const id of ['cut-amount', 'cut-counted', 'cut-reason', 'cut-pin', 'cut-ack',
        'cut-usd-counted', 'cut-currency']) {
        $(id).disabled = !puede;
      }
    }

    async function refrescar() {
      try {
        const data = await api.get(`/nightclubs/${clubId()}/shifts/me/cut`);
        pintar(data);
        if (onChange) onChange(data);
      } catch (err) {
        avisar(deps.errorMessage ? deps.errorMessage(err) : String(err.message || err));
      }
    }

    async function accion(tipo) {
      if (estado.busy) return;
      $('cut-error').hidden = true;
      const monto = Number($('cut-amount').value);
      const motivo = $('cut-reason').value;
      const pin = $('cut-pin').value;
      const contado = $('cut-counted').value;
      const contadoUsd = $('cut-usd-counted').value;
      const moneda = $('cut-currency').hidden ? 'MXN' : ($('cut-currency').value || 'MXN');

      const bloqueo = tipo === 'drop'
        ? dropBlocker(monto, estado.cut, { reason: motivo, pin, currency: moneda })
        : closeBlocker(monto, estado.cut, {
          counted: contado, reason: motivo, pin, acknowledgePending: $('cut-ack').checked,
          countedUsd: contadoUsd,
        });
      if (bloqueo) {
        let vars;
        if (bloqueo === 'cut.errDiffReason') {
          const difPesos = Math.abs(difference(contado === '' ? monto : contado, estado.cut));
          vars = {
            amount: difPesos > 0 || !hasUsd(estado.cut)
              ? dinero(difPesos)
              : usdText(Math.abs(usdDifference(contadoUsd, estado.cut))),
          };
        } else if (bloqueo === 'cut.errUsdCounted') {
          vars = { amount: usdText(estado.cut.usd_to_hand) };
        }
        avisar(t(bloqueo, vars));
        return;
      }
      if (tipo === 'declare'
        && !(await ask(t('cut.confirmDeclare', { amount: dinero(monto) })))) return;

      estado.busy = true;
      const boton = $(tipo === 'drop' ? 'cut-drop' : 'cut-declare');
      const antes = boton.textContent;
      boton.textContent = t('cut.sending');
      boton.disabled = true;
      try {
        if (tipo === 'drop') {
          const hecho = await api.post(`/nightclubs/${clubId()}/shifts/me/cash-drops`, {
            amount: monto, currency: moneda, reason: motivo.trim(), manager_pin: pin,
          });
          if (deps.toast) {
            // El ticket del retiro (D81): si no salió, se dice junto con el aviso.
            const sinPapel = hecho.ticket === null;
            deps.toast(t(sinPapel ? 'cut.dropSentNoTicket' : 'cut.dropSent', {
              name: (hecho.withdrawal && hecho.withdrawal.authorized_by) || '',
            }), sinPapel ? 'warn' : 'ok');
          }
        } else {
          const hecho = await api.post(`/nightclubs/${clubId()}/shifts/me/closing`, {
            declared_cash: monto,
            counted_cash: contado === '' ? monto : Number(contado),
            ...(motivo.trim() ? { difference_reason: motivo.trim() } : {}),
            ...(pendingCount(estado.cut) > 0 ? { acknowledge_pending: $('cut-ack').checked } : {}),
            ...(hasUsd(estado.cut) ? { counted_usd: Number(contadoUsd) } : {}),
            manager_pin: pin,
          });
          if (deps.toast) {
            deps.toast(t(hecho.ticket ? 'cut.declared' : 'cut.declaredNoTicket'), 'ok');
          }
        }
        $('cut-amount').value = '';
        $('cut-counted').value = '';
        $('cut-usd-counted').value = '';
        $('cut-reason').value = '';
        $('cut-ack').checked = false;
        await refrescar();
      } catch (err) {
        avisar(deps.errorMessage ? deps.errorMessage(err) : String(err.message || err));
      } finally {
        // El código se borra SIEMPRE, salga bien o mal: si se quedara escrito, el
        // empleado podría autorizar el siguiente retiro él solo.
        $('cut-pin').value = '';
        estado.busy = false;
        boton.textContent = antes;
        boton.disabled = false;
      }
    }

    $('cut-drop').onclick = () => accion('drop');
    $('cut-declare').onclick = () => accion('declare');
    $('cut-close').onclick = () => { caja.hidden = true; };

    return {
      async open() {
        caja.hidden = false;
        $('cut-error').hidden = true;
        pintar(estado.cut);
        await refrescar();
        // Lo que falta entregar viene puesto: es el caso normal al cerrar el turno,
        // y teclearlo a las tres de la mañana es como se equivoca.
        if (estado.cut && estado.cut.cash_to_hand) $('cut-amount').value = estado.cut.cash_to_hand;
      },
      close() { caja.hidden = true; },
      refresh: refrescar,
      get cut() { return estado.cut; },
    };
  }

  return {
    METHOD_KEY, methodKey, isCash, money, lines, statusKey, hasUsd, usdDifference,
    dropBlocker, closeBlocker, difference, pendingCount, isTill, createSheet,
  };
}));
