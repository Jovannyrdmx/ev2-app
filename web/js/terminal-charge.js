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
      case 'action_required': return { key: 'pay.termAction', tone: 'wait' };
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
   * Si no está en la lista se enseña tal cual: dice más que cualquier texto nuestro, y
   * es lo que el cliente va a preguntar. La lista es corta a propósito: solo los que
   * aparecen en la guía de Point, para no traducir mal un código que no conocemos.
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
    caja.hidden = true;
    caja.className = 'fixed inset-0 z-[70] flex items-end justify-center bg-black/80';
    caja.innerHTML = `
      <div class="w-full max-w-md rounded-t-2xl p-5 space-y-4 text-center"
           style="background:#12121f;border-top:1px solid rgba(255,255,255,.12)">
        <p id="term-amount" class="font-display text-3xl">—</p>
        <p id="term-where" class="text-xs text-white/50">—</p>
        <div id="term-spinner" class="mx-auto w-12 h-12 rounded-full pulsing"
             style="border:3px solid rgba(0,191,255,.25);border-top-color:var(--ev2-cyan)"></div>
        <p id="term-headline" class="font-display text-lg">—</p>
        <p id="term-detail" class="text-xs text-white/50"></p>
        <p id="term-left" class="text-[11px] text-white/35"></p>
        <button id="term-cancel" class="w-full py-3 rounded-xl card text-sm text-red-300"></button>
        <button id="term-close" class="w-full py-3 rounded-xl ev2-button font-display" hidden></button>
      </div>`;
    doc.body.appendChild(caja);

    const $ = (id) => doc.getElementById(id);
    const estado = { chargeId: null, status: null, started: 0, timer: null, expiresAt: null };

    function pintar(charge) {
      const head = headline(charge.status, charge);
      estado.status = charge.status;
      estado.expiresAt = charge.expires_at || estado.expiresAt;

      $('term-amount').textContent = deps.money(charge.amount, charge.currency);
      $('term-where').textContent = charge.terminal ? charge.terminal.label : '';
      $('term-headline').textContent = t(head.key);
      $('term-headline').style.color = head.tone === 'ok' ? 'var(--ev2-lime)'
        : head.tone === 'bad' ? '#fca5a5' : '';
      // El detalle que manda Mercado Pago (por qué se rechazó): en español si es uno de
      // los documentados, tal cual si no. Y la propina, si el cliente la dejó en la
      // terminal: es dinero de alguien y tiene que verse.
      const dk = detailKey(charge.status_detail);
      const partes = [dk ? t(dk) : (charge.status_detail || '')];
      if (isPaid(charge.status) && Number(charge.tip_amount) > 0) {
        partes.push(t('pay.termTip', { tip: deps.money(charge.tip_amount, charge.currency) }));
      }
      $('term-detail').textContent = partes.filter(Boolean).join(' · ');
      $('term-spinner').hidden = isFinal(charge.status);

      const quedan = secondsLeft(estado.expiresAt);
      $('term-left').textContent = (!isFinal(charge.status) && quedan !== null)
        ? t('pay.termLeft', { n: quedan }) : '';

      const cancelable = canCancel(charge.status);
      $('term-cancel').hidden = !cancelable;
      $('term-cancel').textContent = t('pay.termCancel');
      $('term-close').hidden = cancelable;
      $('term-close').textContent = t(isPaid(charge.status) ? 'pay.termDone' : 'pay.termBack');
    }

    function parar() {
      if (estado.timer) { clearTimeout(estado.timer); estado.timer = null; }
    }

    async function preguntar() {
      if (!estado.chargeId) return;
      try {
        const res = await api.get(`/nightclubs/${clubId()}/terminal-charges/${estado.chargeId}`);
        pintar(res.charge);
        if (isFinal(res.charge.status)) {
          parar();
          if (isPaid(res.charge.status) && onPaid) await onPaid(res.charge);
          return;
        }
      } catch {
        // Si la consulta falla se sigue esperando: el cobro puede estar pasando justo
        // ahora, y enseñar "error" por un tropiezo de red sería mentir.
      }
      estado.timer = setTimeout(preguntar, pollDelay(Date.now() - estado.started));
    }

    $('term-cancel').onclick = async () => {
      $('term-cancel').disabled = true;
      try {
        const res = await api.post(
          `/nightclubs/${clubId()}/terminal-charges/${estado.chargeId}/cancel`, {});
        parar();
        pintar(res.charge);
      } catch (err) {
        $('term-detail').textContent = deps.errorMessage(err);
      } finally {
        $('term-cancel').disabled = false;
      }
    };

    $('term-close').onclick = () => {
      parar();
      caja.hidden = true;
      if (onClose) onClose(estado.status);
    };

    return {
      /** Abre el cuadro con un cobro recién creado y se queda mirando. */
      watch(charge) {
        parar();
        estado.chargeId = charge.id;
        estado.started = Date.now();
        estado.expiresAt = charge.expires_at || null;
        caja.hidden = false;
        pintar(charge);
        estado.timer = setTimeout(preguntar, 1500);
      },
      /** El socket avisó. Más rápido que esperar a la siguiente consulta. */
      onEvent(message) {
        if (!estado.chargeId || caja.hidden) return;
        const p = (message && message.payload) || {};
        if (p.charge_id === estado.chargeId) { parar(); preguntar(); }
      },
      close() { parar(); caja.hidden = true; },
      get chargeId() { return estado.chargeId; },
    };
  }

  return {
    FINAL, REMEMBER_KEY, isFinal, isPaid, headline, secondsLeft, pollDelay, canCancel,
    pickTerminal, recordar, recordada, createSheet, DETAIL_KEYS, detailKey,
  };
}));
