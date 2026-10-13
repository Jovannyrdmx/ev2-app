/**
 * EV2 — la página del anticipo, del lado del cliente (D113).
 *
 * Se abre sola al reservar y desde "Mis reservaciones". Le dice al cliente, en este
 * orden: cuánto transferir, a qué cuenta (con un botón de copiar, porque una CLABE
 * dictada a mano es una transferencia a otra persona), y cómo mandar el comprobante.
 * Después le dice en qué va: en revisión, rechazado con el motivo, o confirmado con su
 * crédito de consumo para esa noche. El resto se paga al llegar, en la puerta.
 *
 *   EV2DepositScreen.open(ctx, reservationId)
 */
/* global EV2Deposit */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const uuid = () => (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  let ctx = null;
  let info = null;
  let reservationId = null;
  let requestId = null;
  let onChanged = null;

  const t = (k, v) => (v ? ctx.t(k, v) : ctx.t(k));
  const money = (a, c) => ctx.money(a, c || (info && info.reservation && info.reservation.currency));

  function showError(text) {
    const el = $('dpo-error');
    el.textContent = text || '';
    el.hidden = !text;
  }

  async function copiar(texto, boton) {
    try {
      await navigator.clipboard.writeText(texto);
      const antes = boton.textContent;
      boton.textContent = t('dpo.copied');
      setTimeout(() => { boton.textContent = antes; }, 1500);
    } catch {
      // Sin permiso de portapapeles el número queda seleccionable a la vista.
      ctx.toast(t('dpo.copyManual'), 'error');
    }
  }

  function renderCuentas() {
    const box = $('dpo-accounts');
    box.innerHTML = '';
    const opciones = info.options || [];
    $('dpo-no-accounts').hidden = opciones.length > 0;
    const select = $('dpo-option');
    select.innerHTML = '';
    for (const o of opciones) {
      const card = document.createElement('div');
      card.className = 'rounded-xl bg-white/5 p-3 space-y-1 text-left';
      const head = document.createElement('p');
      head.className = 'text-xs uppercase tracking-wider text-white/40';
      head.textContent = `${o.label} · ${t(EV2Deposit.methodKey(o.method))}`;
      card.appendChild(head);
      if (o.destination) {
        const fila = document.createElement('div');
        fila.className = 'flex items-center justify-between gap-2';
        const num = document.createElement('p');
        num.className = 'font-display text-lg tracking-wider select-all break-all';
        num.textContent = o.destination;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'card rounded-lg px-3 py-1 text-xs shrink-0';
        btn.textContent = t('dpo.copy');
        btn.onclick = () => copiar(o.destination, btn);
        fila.append(num, btn);
        card.appendChild(fila);
      }
      if (o.instructions) {
        const ins = document.createElement('p');
        ins.className = 'text-xs text-white/60 whitespace-pre-line';
        ins.textContent = o.instructions;
        card.appendChild(ins);
      }
      box.appendChild(card);

      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.label;
      select.appendChild(opt);
    }
    $('dpo-option-row').hidden = opciones.length < 2;
  }

  function render() {
    const r = info.reservation;
    const etapa = EV2Deposit.stage(info);
    $('dpo-where').textContent = [r.event_name, r.table_code].filter(Boolean).join(' · ');
    $('dpo-when').textContent = r.doors_open_at ? window.EV2Format.dateTime(r.doors_open_at) : '';
    $('dpo-amount').textContent = money(info.deposit_amount_due || info.deposit);
    $('dpo-total').textContent = t('dpo.totalLine', {
      total: money(info.total), rest: money(EV2Deposit.restAtDoor(info)),
    });

    const badge = $('dpo-stage');
    badge.textContent = t(`dpo.stage_${etapa}`);
    badge.className = `text-xs rounded-full px-3 py-1 ${{
      pay: 'bg-amber-400/15 text-amber-200', review: 'bg-cyan-400/15 text-cyan-200',
      confirmed: 'bg-lime-400/15 text-lime-200', closed: 'bg-white/10 text-white/50',
    }[etapa]}`;

    $('dpo-pay').hidden = etapa !== 'pay';
    $('dpo-review').hidden = etapa !== 'review';
    $('dpo-confirmed').hidden = etapa !== 'confirmed';
    $('dpo-closed').hidden = etapa !== 'closed';

    const rechazo = EV2Deposit.wasRejected(info);
    $('dpo-rejected').hidden = !rechazo;
    if (rechazo) $('dpo-rejected').textContent = t('dpo.rejectedWhy', { reason: info.last_proof.rejection_reason || '' });

    if (etapa === 'pay') renderCuentas();
    if (etapa === 'confirmed') {
      const c = info.credit;
      $('dpo-credit').textContent = c && Number(c.available) > 0
        ? t('dpo.creditLine', { amount: money(c.available) }) : t('dpo.creditSoon');
      $('dpo-rest-due').textContent = Number(info.due) > 0
        ? t('dpo.restDue', { amount: money(info.due) }) : t('dpo.allPaid');
    }
  }

  async function cargar() {
    info = await ctx.api.get(`/nightclubs/${ctx.clubId()}/reservations/${reservationId}/payment`);
    render();
  }

  async function enviar() {
    showError(null);
    const file = $('dpo-file').files && $('dpo-file').files[0];
    const optionId = (info.options || []).length ? ($('dpo-option').value || info.options[0].id) : null;
    const bloqueo = EV2Deposit.proofBlocker({ file, optionId, options: info.options });
    if (bloqueo) { showError(t(bloqueo)); return; }

    const form = new FormData();
    form.append('photo', file);
    if (optionId) form.append('option_id', optionId);
    const ref = $('dpo-ref').value.trim();
    if (ref) form.append('reference', ref);
    if (!requestId) requestId = uuid();
    form.append('client_request_id', requestId);

    const boton = $('btn-dpo-send');
    boton.disabled = true;
    boton.textContent = t('dpo.sending');
    try {
      await ctx.api.postForm(`/nightclubs/${ctx.clubId()}/reservations/${reservationId}/deposit-proof`, form);
      requestId = null;
      $('dpo-file').value = '';
      $('dpo-file-name').textContent = '';
      $('dpo-ref').value = '';
      ctx.toast(t('dpo.sent'), 'ok');
      await cargar();
      if (onChanged) onChanged();
    } catch (err) {
      showError(window.EV2Format.errorMessage(err));
    } finally {
      boton.disabled = false;
      boton.textContent = t('dpo.send');
    }
  }

  async function retirar() {
    const p = info && info.last_proof;
    if (!p || p.status !== 'declared') return;
    const ok = window.EV2UI ? await window.EV2UI.confirm(t('dpo.withdrawAsk')) : window.confirm(t('dpo.withdrawAsk'));
    if (!ok) return;
    try {
      await ctx.api.post(`/nightclubs/${ctx.clubId()}/manual-payments/${p.id}/cancel`, {});
      await cargar();
    } catch (err) { showError(window.EV2Format.errorMessage(err)); }
  }

  async function open(screenCtx, id, opts = {}) {
    ctx = screenCtx;
    reservationId = id;
    onChanged = opts.onChanged || null;
    requestId = null;
    showError(null);
    $('dpo-sheet').hidden = false;
    try { await cargar(); } catch (err) { showError(window.EV2Format.errorMessage(err)); }
  }

  function close() { $('dpo-sheet').hidden = true; }

  function wire() {
    if (!$('dpo-sheet')) return;
    $('btn-dpo-close').onclick = close;
    $('dpo-sheet').onclick = (e) => { if (e.target === $('dpo-sheet')) close(); };
    $('btn-dpo-send').onclick = enviar;
    $('btn-dpo-withdraw').onclick = retirar;
    $('dpo-file').onchange = () => {
      const f = $('dpo-file').files && $('dpo-file').files[0];
      $('dpo-file-name').textContent = f ? f.name : '';
      showError(null);
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  window.EV2DepositScreen = { open, close, reload: () => (info ? cargar() : null) };
}());
