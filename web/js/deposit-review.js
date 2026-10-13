/**
 * EV2 — la cola de comprobantes de anticipo por revisar (D113).
 *
 * La misma pieza en dos pantallas: el panel del gerente y la puerta de la anfitriona.
 * Cada renglón dice quién, qué mesa, cuánto y cuándo lo mandó; "Ver comprobante" abre
 * la foto (o el PDF) traída con el token, y desde ahí se aprueba o se rechaza con
 * motivo. Aprobar confirma la reservación y le da al cliente su crédito de consumo.
 *
 *   const cola = EV2DepositReview.create({ api, clubId, t, money, dateTime, toast,
 *                                          errorMessage, container, onChange });
 *   cola.load();          // vuelve a pedir la lista
 *   cola.open(paymentId)  // abre un comprobante directo (la puerta, al escanear)
 */
/* global EV2Deposit */
(function () {
  'use strict';

  const ask = (text, opts) => (window.EV2UI ? window.EV2UI.confirm(text, opts)
    : Promise.resolve(window.confirm(text)));
  const askText = (text, opts) => (window.EV2UI ? window.EV2UI.prompt(text, opts)
    : Promise.resolve(window.prompt(text)));

  function create(deps) {
    const { api, clubId, t, money, dateTime, toast, errorMessage, container } = deps;
    const onChange = deps.onChange || (() => {});
    let lista = [];
    let objectUrl = null;

    // El visor: uno por pantalla, se arma la primera vez que hace falta.
    let visor = null;
    function armarVisor() {
      if (visor) return visor;
      visor = document.createElement('div');
      visor.className = 'fixed inset-0 z-[80] flex items-center justify-center bg-black/90 p-4';
      visor.hidden = true;
      visor.setAttribute('role', 'dialog');
      visor.setAttribute('aria-modal', 'true');
      visor.innerHTML = `
        <div class="w-full max-w-lg rounded-2xl p-4 space-y-3" style="background:#12121f;border:1px solid rgba(255,255,255,.12);max-height:100dvh;overflow-y:auto">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="dr-v-who font-display text-lg truncate">—</p>
              <p class="dr-v-what text-xs text-white/50">—</p>
            </div>
            <button type="button" class="dr-v-close text-white/50 px-2" aria-label="Cerrar"><i class="fa-solid fa-xmark text-xl"></i></button>
          </div>
          <div class="dr-v-media rounded-xl bg-black/40 min-h-[200px] flex items-center justify-center text-sm text-white/40"></div>
          <p class="dr-v-error text-sm text-red-300" hidden></p>
          <div class="grid grid-cols-2 gap-2">
            <button type="button" class="dr-v-reject py-3 rounded-xl card text-sm text-red-300"></button>
            <button type="button" class="dr-v-approve ev2-button py-3 rounded-xl font-display"></button>
          </div>
          <p class="dr-v-note text-[11px] text-white/40 leading-snug"></p>
        </div>`;
      document.body.appendChild(visor);
      visor.querySelector('.dr-v-close').onclick = cerrarVisor;
      visor.onclick = (e) => { if (e.target === visor) cerrarVisor(); };
      return visor;
    }

    function cerrarVisor() {
      if (visor) visor.hidden = true;
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    }

    async function abrir(linea) {
      const v = armarVisor();
      const q = (sel) => v.querySelector(sel);
      q('.dr-v-who').textContent = [linea.who, linea.table ? t('dpo.table', { table: linea.table }) : null]
        .filter(Boolean).join(' · ');
      q('.dr-v-what').textContent = [
        money(linea.amount, linea.currency),
        t(EV2Deposit.methodKey(linea.method)),
        linea.reference ? t('dpo.folio', { ref: linea.reference }) : null,
        linea.sentAt ? dateTime(linea.sentAt) : null,
      ].filter(Boolean).join(' · ');
      q('.dr-v-reject').textContent = t('dpo.reject');
      q('.dr-v-approve').textContent = t('dpo.approve');
      q('.dr-v-note').textContent = t('dpo.reviewNote');
      q('.dr-v-error').hidden = true;
      const media = q('.dr-v-media');
      media.textContent = t('dpo.loadingProof');
      v.hidden = false;

      const busy = (on) => { q('.dr-v-reject').disabled = on; q('.dr-v-approve').disabled = on; };
      const fallo = (err) => { q('.dr-v-error').textContent = errorMessage(err); q('.dr-v-error').hidden = false; };

      q('.dr-v-approve').onclick = async () => {
        if (!(await ask(t('dpo.approveAsk', { amount: money(linea.amount, linea.currency), who: linea.who })))) return;
        busy(true);
        try {
          await api.post(`/nightclubs/${clubId()}/manual-payments/${linea.paymentId}/confirm`, {});
          toast(t('dpo.approved'), 'ok');
          cerrarVisor();
          await load();
          onChange({ approved: linea.paymentId });
        } catch (err) { fallo(err); } finally { busy(false); }
      };
      q('.dr-v-reject').onclick = async () => {
        const motivo = await askText(t('dpo.rejectAsk'), { ok: t('dpo.reject') });
        if (motivo === null) return;
        const bloqueo = EV2Deposit.rejectBlocker(motivo);
        if (bloqueo) { fallo(new Error(t(bloqueo))); return; }
        busy(true);
        try {
          await api.post(`/nightclubs/${clubId()}/manual-payments/${linea.paymentId}/reject`,
            { reason: motivo.trim() });
          toast(t('dpo.rejected'), 'ok');
          cerrarVisor();
          await load();
          onChange({ rejected: linea.paymentId });
        } catch (err) { fallo(err); } finally { busy(false); }
      };

      if (!linea.hasProof) { media.textContent = t('dpo.noProof'); return; }
      try {
        const blob = await api.getBlob(`/nightclubs/${clubId()}/manual-payments/${linea.paymentId}/proof`);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(blob);
        media.textContent = '';
        if (linea.isPdf || (blob && blob.type === 'application/pdf')) {
          const a = document.createElement('a');
          a.href = objectUrl; a.target = '_blank'; a.rel = 'noopener';
          a.className = 'ev2-button rounded-xl px-4 py-3 text-sm';
          a.textContent = t('dpo.openPdf');
          media.appendChild(a);
        } else {
          const img = document.createElement('img');
          img.src = objectUrl;
          img.alt = t('dpo.proofAlt');
          img.className = 'max-h-[60dvh] w-auto rounded-lg';
          media.appendChild(img);
        }
      } catch (err) { media.textContent = ''; fallo(err); }
    }

    function render() {
      if (!container) return;
      container.innerHTML = '';
      if (lista.length === 0) {
        const vacio = document.createElement('p');
        vacio.className = 'text-sm text-white/40';
        vacio.textContent = t('dpo.queueEmpty');
        container.appendChild(vacio);
        return;
      }
      for (const item of lista) {
        const l = EV2Deposit.reviewLine(item);
        const fila = document.createElement('div');
        fila.className = 'flex items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2';
        const info = document.createElement('div');
        info.className = 'min-w-0';
        const a = document.createElement('p');
        a.className = 'text-sm truncate';
        a.textContent = [l.who, l.table ? t('dpo.table', { table: l.table }) : null].filter(Boolean).join(' · ');
        const b = document.createElement('p');
        b.className = 'text-[11px] text-white/50 truncate';
        b.textContent = [money(l.amount, l.currency), l.event, l.sentAt ? dateTime(l.sentAt) : null]
          .filter(Boolean).join(' · ');
        info.append(a, b);
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.className = 'ev2-button rounded-lg px-3 py-2 text-xs shrink-0';
        boton.textContent = t('dpo.see');
        boton.onclick = () => abrir(l);
        fila.append(info, boton);
        container.appendChild(fila);
      }
    }

    async function load() {
      const data = await api.get(`/nightclubs/${clubId()}/deposit-reviews?limit=50`);
      lista = data.reviews || [];
      render();
      return lista;
    }

    /** Abre un comprobante por su id (la puerta, cuando el escaneo dice que hay uno). */
    async function open(paymentId) {
      let item = lista.find((x) => x.payment && x.payment.id === paymentId);
      if (!item) { await load(); item = lista.find((x) => x.payment && x.payment.id === paymentId); }
      if (item) await abrir(EV2Deposit.reviewLine(item));
      return Boolean(item);
    }

    return { load, open, render, count: () => lista.length };
  }

  window.EV2DepositReview = { create };
}());
