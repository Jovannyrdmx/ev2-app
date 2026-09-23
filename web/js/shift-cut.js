/**
 * EV2 — el corte del turno, en la pantalla de quien cobra (D51).
 *
 * Contesta la pregunta que un mesero y un bartender se hacen a las tres de la mañana
 * con la bolsa llena: **¿cuánto de esto es del club?** Y da las dos únicas acciones
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
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  root.EV2ShiftCut = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Cada método de pago con su nombre; el club los lee, no los códigos. */
  const METHOD_KEY = {
    cash: 'cut.mCash',
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

  /**
   * Por qué no se puede entregar ese efectivo. Devuelve la clave del motivo o null.
   *
   * Entregar de más no es un descuido: o el número está mal tecleado, o ese dinero no
   * es del club. Las dos cosas se paran antes de que alguien suelte los billetes.
   */
  function dropBlocker(amount, cut) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return 'cut.errAmount';
    if (!cut || !cut.shift) return 'cut.errNoShift';
    if (cut.shift.ended_at) return 'cut.errShiftClosed';
    if (n > Number(cut.cash_to_hand)) return 'cut.errTooMuch';
    return null;
  }

  /** Por qué no se puede declarar el corte todavía. */
  function closeBlocker(amount, cut) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) return 'cut.errAmount';
    if (!cut || !cut.shift) return 'cut.errNoShift';
    if (cut.closing) return 'cut.errAlready';
    return null;
  }

  /** Lo que el corte enseña, en el orden en que se lee. */
  function lines(cut, t) {
    if (!cut || !cut.totals) return [];
    const out = cut.totals.by_method.map((l) => ({
      key: l.method,
      label: t(methodKey(l.method)),
      value: l.amount,
      count: l.count,
      cash: isCash(l.method),
    }));
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
    if (!cut.closing) return 'cut.open';
    return cut.closing.status === 'confirmed' ? 'cut.confirmed' : 'cut.waitingManager';
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
        </div>
        <div id="cut-drops" class="space-y-1"></div>
        <p id="cut-error" class="text-sm text-red-300" hidden></p>
        <div class="grid grid-cols-2 gap-2 pt-1">
          <input id="cut-amount" type="number" min="0" step="50" inputmode="decimal"
                 class="px-3 py-3 rounded-xl bg-white/5 border border-white/10 outline-none text-center col-span-2">
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

      const box = $('cut-lines');
      box.innerHTML = '';
      for (const l of lines(cut, t)) {
        const fila = doc.createElement('div');
        fila.className = 'flex justify-between items-baseline text-sm';
        fila.innerHTML = '<span></span><span></span>';
        fila.firstChild.textContent = `${l.label}${l.count ? ` · ${l.count}` : ''}`;
        fila.firstChild.className = l.aside ? 'text-white/40' : 'text-white/60';
        fila.lastChild.textContent = dinero(l.value);
        if (l.aside) fila.lastChild.className = 'text-white/40';
        box.appendChild(fila);
      }

      $('cut-handed').textContent = dinero(cut && cut.drops_received);
      $('cut-tohand').textContent = dinero(cut && cut.cash_to_hand);

      const drops = $('cut-drops');
      drops.innerHTML = '';
      for (const d of (cut && cut.drops) || []) {
        const p = doc.createElement('p');
        p.className = 'text-[11px]';
        p.style.color = d.status === 'received' ? 'var(--ev2-lime)'
          : d.status === 'rejected' ? '#fca5a5' : '#fcd34d';
        p.textContent = t(`cut.drop.${d.status}`, {
          amount: dinero(d.status === 'received' ? d.counted_amount : d.amount),
        });
        drops.appendChild(p);
      }

      const puede = Boolean(cut && cut.shift && !cut.closing);
      $('cut-drop').disabled = !puede || Boolean(cut.shift.ended_at);
      $('cut-declare').disabled = !puede;
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
      const bloqueo = tipo === 'drop'
        ? dropBlocker(monto, estado.cut) : closeBlocker(monto, estado.cut);
      if (bloqueo) { avisar(t(bloqueo)); return; }
      if (tipo === 'declare'
        && !window.confirm(t('cut.confirmDeclare', { amount: dinero(monto) }))) return;

      estado.busy = true;
      const boton = $(tipo === 'drop' ? 'cut-drop' : 'cut-declare');
      const antes = boton.textContent;
      boton.textContent = t('cut.sending');
      boton.disabled = true;
      try {
        if (tipo === 'drop') {
          await api.post(`/nightclubs/${clubId()}/shifts/me/cash-drops`, { amount: monto });
        } else {
          await api.post(`/nightclubs/${clubId()}/shifts/me/closing`, { declared_cash: monto });
        }
        $('cut-amount').value = '';
        await refrescar();
        if (deps.toast) deps.toast(t(tipo === 'drop' ? 'cut.dropSent' : 'cut.declared'), 'ok');
      } catch (err) {
        avisar(deps.errorMessage ? deps.errorMessage(err) : String(err.message || err));
      } finally {
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
    METHOD_KEY, methodKey, isCash, money, lines, statusKey,
    dropBlocker, closeBlocker, createSheet,
  };
}));
