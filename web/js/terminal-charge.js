/**
 * EV2 — la espera de la terminal, en pantalla (D47).
 *
 * Lo que pasa después de tocar "Cobrar" con la terminal: el sistema manda el monto, la
 * terminal se enciende, y alguien tiene que mirar algo mientras el cliente saca la
 * tarjeta. Eso es todo lo que hay aquí.
 *
 * ---------------------------------------------------------------------------
 * Por qué se dibuja sola en vez de vivir en el HTML
 * ---------------------------------------------------------------------------
 * Este mismo cuadro hace falta en la barra, en el piso, en la puerta y en el panel del
 * gerente. Pegarlo cuatro veces en cuatro archivos HTML significa que el día que haya
 * que cambiar una palabra hay que acordarse de los cuatro — y el que se olvide se
 * descubre de noche, con un cliente esperando. Se arma desde JavaScript, una vez, y las
 * cuatro pantallas solo la llaman.
 *
 * ---------------------------------------------------------------------------
 * Lo que NO hace
 * ---------------------------------------------------------------------------
 * No decide si se cobró. Eso lo decide el servidor contra Mercado Pago, y aquí solo se
 * enseña lo que conteste. En particular: mientras el estado no sea final, este cuadro NO
 * dice "listo" por su cuenta ni aunque pase el tiempo de espera — una pantalla que
 * adivina que ya cobró es peor que una que sigue esperando.
 */
/* global module */
(function (root, factory) {
  'use strict';
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  root.EV2TerminalCharge = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Los estados que significan que ya terminó, pasó lo que pasara. */
  const FINAL = ['processed', 'failed', 'canceled', 'expired', 'refunded', 'error'];

  const isFinal = (status) => FINAL.includes(String(status));
  const isPaid = (status) => String(status) === 'processed';

  /**
   * Qué decirle a quien está mirando. Devuelve la clave del texto y el tono.
   *
   * `error` tiene su propio texto y no se junta con `failed`: son cosas distintas y
   * confundirlas cuesta dinero. `failed` es "la tarjeta no pasó, cobra de otra forma";
   * `error` es "no sabemos qué pasó, NO vuelvas a cobrar sin revisar" — porque puede
   * haber un cargo del otro lado.
   */
  function headline(status, charge) {
    switch (String(status)) {
      case 'creating': return { key: 'pay.termStarting', tone: 'wait' };
      // `at_terminal`: Mercado Pago dice que la terminal ya enseña el monto. Distinguirlo
      // de "enviando" le dice al mesero que el problema ya no es la red.
      case 'waiting': return {
        key: charge && charge.at_terminal ? 'pay.termAtTerminal' : 'pay.termWaiting', tone: 'wait',
      };
      case 'action_required': return {
        key: charge && charge.status_detail === 'reconciliation_required'
          ? 'pay.termReview' : 'pay.termAction', tone: 'wait',
      };
      case 'processed': return { key: 'pay.termPaid', tone: 'ok' };
      case 'failed': return { key: 'pay.termFailed', tone: 'bad' };
      case 'canceled': return { key: 'pay.termCanceled', tone: 'bad' };
      case 'expired': return { key: 'pay.termExpired', tone: 'bad' };
      case 'refunded': return { key: 'pay.termRefunded', tone: 'bad' };
      default: return { key: 'pay.termUnknown', tone: 'bad' };
    }
  }

  /**
   * El detalle de Mercado Pago, dicho en español cuando es uno de los documentados.
   *
   * Unknown provider codes use a plain-language fallback; technical evidence remains
   * in the server audit, not untranslated in front of a customer.
   */
  const DETAIL_KEYS = {
    accredited: 'pay.detAccredited',
    bad_filled_card_data: 'pay.detBadCard',
    insufficient_amount: 'pay.detInsufficient',
    canceled_by_api: 'pay.detCanceledApi',
    at_terminal: 'pay.detAtTerminal',
    created: 'pay.detCreated',
    refunded: 'pay.detRefunded',
    expired: 'pay.detExpired',
    canceled_on_terminal: 'pay.detCanceledTerminal',
    check_on_terminal: 'pay.detCheckTerminal',
    reconciliation_required: 'pay.detReview',
    create_rejected: 'pay.detCreateRejected',
  };
  const detailKey = (detail) => DETAIL_KEYS[String(detail || '')] || null;

  /** Cuánto le queda a la orden antes de vencer, en segundos. Nunca negativo. */
  function secondsLeft(expiresAt, now = Date.now()) {
    if (!expiresAt) return null;
    const ms = new Date(expiresAt).getTime() - now;
    return ms <= 0 ? 0 : Math.round(ms / 1000);
  }

  /**
   * Cada cuánto volver a preguntar, en milisegundos.
   *
   * Empieza seguido, porque los primeros segundos son cuando la persona está mirando, y
   * se va espaciando: a los dos minutos ya nadie está pendiente y seguir preguntando
   * cada segundo es castigar al servidor por nada. El socket es quien de verdad avisa;
   * esto es el respaldo del respaldo.
   */
  function pollDelay(elapsedMs) {
    if (elapsedMs < 20000) return 2000;
    if (elapsedMs < 60000) return 4000;
    return 8000;
  }

  /** Si conviene ofrecer cancelar: solo mientras de verdad se puede. */
  const canCancel = (status) => !isFinal(status);

  /**
   * La terminal con la que se va a cobrar cuando hay varias.
   *
   * La última que usó ESE aparato, si sigue activa. La tableta de la barra cobra
   * siempre con la de la barra, y preguntárselo cada vez a las dos de la mañana es una
   * pregunta de más por cobro.
   */
  function pickTerminal(terminals, remembered) {
    const activas = (terminals || []).filter((t) => t && t.active !== false);
    if (activas.length === 0) return null;
    const recordada = activas.find((t) => t.id === remembered);
    return recordada || activas[0];
  }

  // ---------------------------------------------------------------- el cuadro

  const REMEMBER_KEY = 'ev2.terminal';

  /**
   * Cuántas consultas seguidas sin respuesta antes de dar salida.
   *
   * Tres, con la espera creciente de `pollDelay`, son más de veinte segundos sin saber
   * nada de la terminal. Una sola puede ser el internet del club parpadeando; tres es
   * que algo se quedó.
   */
  const FALLOS_PARA_SALIR = 3;

  const recordar = (id) => {
    try { localStorage.setItem(REMEMBER_KEY, id); } catch { /* modo privado: da igual */ }
  };
  const recordada = () => {
    try { return localStorage.getItem(REMEMBER_KEY); } catch { return null; }
  };

  /**
   * Arma el cuadro y devuelve con qué abrirlo. Se llama UNA vez por pantalla.
   *
   * `deps` es lo que la pantalla ya tiene: su cliente de API, de qué club es, cómo
   * traducir y qué hacer cuando de verdad se cobró. Nada de eso se reinventa aquí.
   */
  function createSheet(deps) {
    const { api, clubId, t, onPaid, onClose } = deps;
    const doc = deps.document || document;

    const caja = doc.createElement('div');
    caja.id = 'term-sheet';
    caja.setAttribute('role', 'dialog');
    caja.setAttribute('aria-modal', 'true');
    caja.setAttribute('aria-labelledby', 'term-headline');
    caja.tabIndex = -1;
    caja.hidden = true;
    caja.className = 'fixed inset-0 z-[70] flex items-end justify-center bg-black/80';
    caja.innerHTML = `
      <div class="w-full max-w-md rounded-t-2xl p-5 space-y-4 text-center"
           style="background:#12121f;border-top:1px solid rgba(255,255,255,.12);max-height:100dvh;overflow-y:auto">
        <p id="term-amount" class="font-display text-3xl">—</p>
        <p id="term-where" class="text-xs text-white/50">—</p>
        <div id="term-spinner" class="mx-auto w-12 h-12 rounded-full pulsing"
             style="border:3px solid rgba(0,191,255,.25);border-top-color:var(--ev2-cyan)"></div>
        <p id="term-headline" class="font-display text-lg" role="status" aria-live="polite" aria-atomic="true">—</p>
        <p id="term-detail" class="text-xs text-white/50" aria-live="polite"></p>
        <p id="term-left" class="text-[11px] text-white/35"></p>
        <button id="term-cancel" class="w-full py-3 rounded-xl card text-sm text-red-300"></button>
        <button id="term-close" class="w-full py-3 rounded-xl ev2-button font-display" hidden></button>
      </div>`;
    doc.body.appendChild(caja);

    const $ = (id) => doc.getElementById(id);
    // `fallos` cuenta consultas seguidas sin respuesta y `salida` recuerda que ya se
    // ofreció la puerta: sin recordarlo, el siguiente repintado la volvería a esconder.
    const estado = {
      chargeId: null, status: null, started: 0, timer: null, expiresAt: null,
      fallos: 0, salida: false,
    };
    let generation = 0;
    let inFlight = null;
    let previousFocus = null;
    const notified = new Set();

    async function notifyPaid(charge) {
      if (!isPaid(charge.status) || !onPaid || notified.has(charge.id)) return;
      notified.add(charge.id);
      // A refresh callback failing cannot change the already confirmed payment.
      try { await onPaid(charge); } catch { /* the authoritative result stays visible */ }
    }

    function pintar(charge) {
      const head = headline(charge.status, charge);
      estado.status = charge.status;
      estado.expiresAt = charge.expires_at || estado.expiresAt;

      $('term-amount').textContent = deps.money(charge.amount, charge.currency);
      $('term-where').textContent = charge.terminal ? charge.terminal.label : '';
      $('term-headline').textContent = t(head.key);
      $('term-headline').style.color = head.tone === 'ok' ? 'var(--ev2-lime)'
        : head.tone === 'bad' ? '#fca5a5' : '';
      // El detalle que manda Mercado Pago (por qué se rechazó), en lenguaje claro.
      // Y la propina, si el cliente la dejó en la
      // terminal: es dinero de alguien y tiene que verse.
      const dk = detailKey(charge.status_detail);
      const partes = [dk ? t(dk) : t(isPaid(charge.status) ? 'pay.detAccredited'
        : charge.status === 'failed' ? 'pay.detDeclined' : 'pay.detPending')];
      if (isPaid(charge.status) && Number(charge.tip_amount) > 0) {
        partes.push(t('pay.termTip', { tip: deps.money(charge.tip_amount, charge.currency) }));
      }
      $('term-detail').textContent = partes.filter(Boolean).join(' · ');
      const needsReview = charge.status_detail === 'reconciliation_required';
      if (needsReview) estado.salida = true;
      $('term-spinner').hidden = isFinal(charge.status) || needsReview;

      const quedan = secondsLeft(estado.expiresAt);
      $('term-left').textContent = (!isFinal(charge.status) && quedan !== null)
        ? t('pay.termLeft', { n: quedan }) : '';

      const cancelable = canCancel(charge.status) && !needsReview;
      $('term-cancel').hidden = !cancelable;
      $('term-cancel').textContent = t('pay.termCancel');
      // La puerta de salida, una vez abierta, NO se vuelve a cerrar (D65).
      //
      // Aquí decía `$('term-close').hidden = cancelable`, y eso dejaba el cuadro sin
      // salida mientras el cobro no fuera final: sin X, sin cierre por fondo, y con el
      // sondeo reintentando cada ocho segundos para siempre. Si la terminal no
      // contestaba, el cantinero se quedaba con el cuadro girando a las dos de la
      // mañana y la única salida era recargar la página.
      $('term-close').hidden = cancelable && !estado.salida;
      $('term-close').textContent = t(isPaid(charge.status) ? 'pay.termDone'
        : (isFinal(charge.status) ? 'pay.termBack' : 'pay.termLeave'));
    }

    function parar() {
      if (estado.timer) { clearTimeout(estado.timer); estado.timer = null; }
    }

    /** Abre la salida y explica por qué, sin decir que el cobro falló. */
    function abrirSalida(motivo) {
      estado.salida = true;
      $('term-spinner').hidden = true;
      $('term-headline').textContent = t(motivo);
      $('term-headline').style.color = '#fcd34d';
      // El aviso importa tanto como el botón: el cobro PUEDE haber pasado, y volver a
      // cobrar sin revisar es cobrarle dos veces al cliente.
      $('term-detail').textContent = t('pay.termUnknown');
      $('term-close').hidden = false;
      $('term-close').textContent = t('pay.termLeave');
    }

    async function preguntar() {
      if (!estado.chargeId || caja.hidden || inFlight === generation) return;
      const current = generation;
      const chargeId = estado.chargeId;
      inFlight = current;
      try {
        const res = await api.get(`/nightclubs/${clubId()}/terminal-charges/${chargeId}`);
        if (current !== generation || caja.hidden) return;
        if (!res.charge || res.charge.id !== chargeId) throw new Error('Unexpected charge');
        estado.fallos = 0;
        pintar(res.charge);
        if (isFinal(res.charge.status)) {
          parar();
          await notifyPaid(res.charge);
          return;
        }
      } catch {
        if (current !== generation || caja.hidden) return;
        // Un tropiezo suelto no es noticia: el cobro puede estar pasando justo ahora, y
        // enseñar "error" por eso sería mentir. Pero TRES seguidas ya no es un tropiezo
        // —son más de veinte segundos sin saber nada— y ahí hay que dar salida en vez
        // de girar para siempre.
        estado.fallos += 1;
        if (estado.fallos >= FALLOS_PARA_SALIR) abrirSalida('pay.termNoAnswer');
      } finally {
        if (inFlight === current) inFlight = null;
      }
      // An elapsed local deadline is NOT a provider-confirmed expiration. Let the
      // employee leave, keep a slower fallback, and never announce a rejection.
      const quedan = secondsLeft(estado.expiresAt);
      if (quedan !== null && quedan <= 0 && !isFinal(estado.status)) {
        parar();
        abrirSalida('pay.termPending');
        estado.timer = setTimeout(preguntar, 15000);
        return;
      }
      estado.timer = setTimeout(preguntar, pollDelay(Date.now() - estado.started));
    }

    $('term-cancel').onclick = async () => {
      parar();
      const current = ++generation;
      $('term-cancel').disabled = true;
      try {
        const res = await api.post(
          `/nightclubs/${clubId()}/terminal-charges/${estado.chargeId}/cancel`, {});
        if (current !== generation || caja.hidden) return;
        parar();
        pintar(res.charge);
        await notifyPaid(res.charge);
      } catch (err) {
        if (current !== generation || caja.hidden) return;
        $('term-detail').textContent = deps.errorMessage(err);
      } finally {
        if (current === generation && !caja.hidden) {
          $('term-cancel').disabled = false;
          if (!isFinal(estado.status)) estado.timer = setTimeout(preguntar, 1500);
        }
      }
    };

    $('term-close').onclick = async () => {
      // Salirse de un cobro que NO terminó no es lo mismo que cerrar uno pagado. Se
      // pregunta, porque lo que sigue —volver a cobrar— es lo que le cobra dos veces
      // al cliente si la tarjeta sí había pasado.
      if (!isFinal(estado.status) && deps.confirm && !(await deps.confirm(t('pay.termLeaveConfirm')))) return;
      parar();
      generation += 1;
      caja.hidden = true;
      if (previousFocus && previousFocus.isConnected) previousFocus.focus();
      if (onClose) onClose(estado.status);
    };
    caja.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('term-close').hidden) {
        event.preventDefault();
        $('term-close').click();
      }
      if (event.key !== 'Tab') return;
      const buttons = [$('term-cancel'), $('term-close')].filter((b) => !b.hidden && !b.disabled);
      if (!buttons.length) { event.preventDefault(); caja.focus(); return; }
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (!buttons.includes(doc.activeElement) || (event.shiftKey && doc.activeElement === first)
        || (!event.shiftKey && doc.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    });

    return {
      /** Abre el cuadro con un cobro recién creado y se queda mirando. */
      watch(charge) {
        parar();
        generation += 1;
        previousFocus = doc.activeElement;
        estado.chargeId = charge.id;
        estado.started = Date.now();
        estado.expiresAt = charge.expires_at || null;
        estado.fallos = 0;
        estado.salida = false;
        caja.hidden = false;
        $('term-cancel').disabled = false;
        pintar(charge);
        caja.focus();
        if (isFinal(charge.status)) notifyPaid(charge);
        else estado.timer = setTimeout(preguntar, 1500);
      },
      /** El socket avisó. Más rápido que esperar a la siguiente consulta. */
      onEvent(message) {
        if (!estado.chargeId || caja.hidden || (isFinal(estado.status) && estado.status !== 'error')) return;
        const p = (message && message.payload) || {};
        if (p.charge_id === estado.chargeId) { parar(); preguntar(); }
      },
      close() {
        parar(); generation += 1; caja.hidden = true;
        if (previousFocus && previousFocus.isConnected) previousFocus.focus();
      },
      get chargeId() { return estado.chargeId; },
      get open() { return !caja.hidden; },
    };
  }

  /**
   * El aviso de un cobro que terminó, para quien lo empezó (D82).
   *
   * El cuadro de la terminal ya dice el resultado mientras está abierto; esto cubre el
   * caso en que se cerró (o se recargó la página) y la tarjeta pasó o se rechazó
   * después. Solo avisa a quien empezó el cobro, y solo cuando terminó.
   */
  function notice(message, { userId = null, watchingChargeId = null } = {}) {
    const kind = message && (message.event_type || message.type);
    if (kind !== 'terminal_charge_updated') return null;
    const p = (message && message.payload) || {};
    if (!isFinal(p.status) || String(p.status) === 'refunded') return null;
    if (!userId || !p.started_by || p.started_by !== userId) return null;
    if (watchingChargeId && p.charge_id === watchingChargeId) return null;
    return {
      key: isPaid(p.status) ? 'pay.noticePaid' : 'pay.noticeBad',
      tone: isPaid(p.status) ? 'ok' : 'bad',
      vars: {
        what: headline(p.status).key,
        terminal: p.terminal || '',
        amount: p.amount || '',
        currency: p.currency || 'MXN',
        card: p.payment_method_id || '',
        detail: p.status_detail || '',
      },
    };
  }

  return {
    FINAL, REMEMBER_KEY, FALLOS_PARA_SALIR, isFinal, isPaid, headline, secondsLeft, pollDelay, canCancel,
    pickTerminal, recordar, recordada, createSheet, DETAIL_KEYS, detailKey, notice,
  };
}));
