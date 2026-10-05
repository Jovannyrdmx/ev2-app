/**
 * Sustituir un insumo que se acabó (D84): la pantalla, para el bartender y el gerente.
 *
 * Se escoge el insumo agotado y con qué se sustituye en ESA barra. Mientras dure,
 * todos los tragos que lo llevan descuentan el sustituto al mismo precio, y la comanda
 * lo dice. Termina sola al acabar la noche o cuando vuelve a haber del original.
 *
 * La lógica que se puede equivocar sin que se note (qué sustitutos se ofrecen) vive
 * en funciones puras, probadas aparte; el resto es pintar.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  root.EV2Substitutions = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Los que pueden sustituir a `supply`: misma unidad, otro insumo, con existencia. */
  function candidatesFor(supply, substitutes) {
    if (!supply) return [];
    return (substitutes || []).filter((s) => s.id !== supply.id && s.unit === supply.unit
      && Number(s.stock) > 0);
  }

  /** Qué falta para poder mandar. Devuelve la clave del texto, o null. */
  function blocker({ barId, supplyId, substituteId }) {
    if (!barId) return 'sub.errBar';
    if (!supplyId) return 'sub.errSupply';
    if (!substituteId) return 'sub.errSubstitute';
    if (supplyId === substituteId) return 'sub.errSame';
    return null;
  }

  const fmtQty = (n, unit) => `${Number(n).toLocaleString('es-MX', { maximumFractionDigits: 2 })} ${unit || ''}`.trim();

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * Pinta el panel dentro de `container`.
   *
   * deps: { api, clubId(), t(), toast(msg, kind), bars() -> [{id,name}], barId() -> id|null,
   *         time(date) -> 'HH:MM' }
   */
  function createPanel(container, deps) {
    const { api, clubId, t } = deps;
    const estado = { bar: null, supplies: [], substitutes: [], live: [], busy: false };

    const barActual = () => (deps.barId && deps.barId()) || estado.bar
      || ((deps.bars && deps.bars().length === 1) ? deps.bars()[0].id : null);

    function pintar() {
      const bars = (deps.bars && deps.bars()) || [];
      const fija = deps.barId && deps.barId();
      const bar = barActual();
      const sup = estado.supplies.find((s) => s.id === estado.supplyId) || null;
      const cands = candidatesFor(sup, estado.substitutes);
      container.innerHTML = `
        <div class="space-y-3">
          ${!fija && bars.length > 1 ? `
            <select data-sub="bar" class="field">
              <option value="">${esc(t('sub.pickBar'))}</option>
              ${bars.map((b) => `<option value="${esc(b.id)}" ${b.id === bar ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
            </select>` : ''}
          <div data-sub="live" class="space-y-2">
            ${estado.live.length ? estado.live.map((x) => `
              <div class="card rounded-lg px-3 py-2 flex items-center justify-between gap-2">
                <div class="min-w-0">
                  <p class="text-sm truncate"><b>${esc(x.supply_name)}</b> → <b class="text-amber-300">${esc(x.substitute_name)}</b></p>
                  <p class="text-[11px] text-white/45 truncate">${esc(t('sub.until', {
                    time: deps.time ? deps.time(x.expires_at) : x.expires_at,
                    who: x.created_by_name || '',
                    left: fmtQty(x.substitute_stock, x.unit),
                  }))}</p>
                </div>
                <button data-end="${esc(x.id)}" class="card rounded-lg px-3 py-2 text-xs shrink-0">${esc(t('sub.end'))}</button>
              </div>`).join('') : `<p class="text-xs text-white/40">${esc(t('sub.none'))}</p>`}
          </div>
          ${bar ? `
          <div class="space-y-2 border-t border-white/5 pt-3">
            <label class="label">${esc(t('sub.runOut'))}</label>
            <select data-sub="supply" class="field">
              <option value="">${esc(t('sub.pickSupply'))}</option>
              ${estado.supplies.map((s) => `<option value="${esc(s.id)}" ${s.id === estado.supplyId ? 'selected' : ''}>${esc(s.name)} · ${esc(fmtQty(s.stock, s.unit))}</option>`).join('')}
            </select>
            <label class="label">${esc(t('sub.useInstead'))}</label>
            <select data-sub="substitute" class="field" ${sup ? '' : 'disabled'}>
              <option value="">${esc(sup && !cands.length ? t('sub.noCandidates') : t('sub.pickSubstitute'))}</option>
              ${cands.map((s) => `<option value="${esc(s.id)}" ${s.id === estado.substituteId ? 'selected' : ''}>${esc(s.name)} · ${esc(fmtQty(s.stock, s.unit))}</option>`).join('')}
            </select>
            <p class="text-[11px] text-white/40">${esc(t('sub.why'))}</p>
            <p data-sub="error" class="text-sm text-red-300" hidden></p>
            <button data-sub="go" class="ev2-button w-full py-3 rounded-xl text-sm" ${estado.busy ? 'disabled' : ''}>${esc(t('sub.go'))}</button>
          </div>` : ''}
        </div>`;

      const q = (k) => container.querySelector(`[data-sub="${k}"]`);
      if (q('bar')) q('bar').onchange = () => { estado.bar = q('bar').value || null; cargar(); };
      if (q('supply')) {
        q('supply').onchange = () => {
          estado.supplyId = q('supply').value || null;
          estado.substituteId = null;
          pintar();
        };
      }
      if (q('substitute')) q('substitute').onchange = () => { estado.substituteId = q('substitute').value || null; };
      if (q('go')) q('go').onclick = activar;
      container.querySelectorAll('[data-end]').forEach((b) => {
        b.onclick = () => terminar(b.getAttribute('data-end'), b);
      });
    }

    function error(msg) {
      const e = container.querySelector('[data-sub="error"]');
      if (e) { e.textContent = msg; e.hidden = !msg; } else if (msg && deps.toast) deps.toast(msg, 'error');
    }

    async function cargar() {
      const bar = barActual();
      if (!bar) { estado.live = []; pintar(); return; }
      try {
        const [vivas, opciones] = await Promise.all([
          api.get(`/nightclubs/${clubId()}/supply-substitutions?location_id=${bar}`),
          api.get(`/nightclubs/${clubId()}/supply-substitutions/options?location_id=${bar}`),
        ]);
        estado.live = vivas.substitutions || [];
        estado.supplies = opciones.supplies || [];
        estado.substitutes = opciones.substitutes || [];
      } catch (err) {
        if (deps.toast) deps.toast(deps.errorMessage ? deps.errorMessage(err) : String(err.message || err), 'error');
      }
      pintar();
    }

    async function activar() {
      const body = {
        location_id: barActual(), supply_id: estado.supplyId, substitute_id: estado.substituteId,
      };
      const falta = blocker({ barId: body.location_id, supplyId: body.supply_id, substituteId: body.substitute_id });
      if (falta) { error(t(falta)); return; }
      estado.busy = true;
      pintar();
      try {
        const res = await api.post(`/nightclubs/${clubId()}/supply-substitutions`, body);
        estado.supplyId = null;
        estado.substituteId = null;
        if (deps.toast) {
          deps.toast(t('sub.started', {
            from: res.substitution.supply_name, to: res.substitution.substitute_name,
          }), 'ok');
        }
        estado.busy = false;
        await cargar();
      } catch (err) {
        estado.busy = false;
        pintar();
        error(deps.errorMessage ? deps.errorMessage(err) : String(err.message || err));
      }
    }

    async function terminar(id, boton) {
      boton.disabled = true;
      try {
        await api.post(`/nightclubs/${clubId()}/supply-substitutions/${id}/end`, {});
        if (deps.toast) deps.toast(t('sub.ended'), 'ok');
        await cargar();
      } catch (err) {
        boton.disabled = false;
        if (deps.toast) deps.toast(deps.errorMessage ? deps.errorMessage(err) : String(err.message || err), 'error');
      }
    }

    return {
      load: cargar,
      /** El evento del socket: si toca esta barra, se recarga. */
      onEvent(message) {
        const kind = message && (message.event_type || message.type);
        if (kind !== 'supply_substitution_changed') return;
        const p = (message && message.payload) || {};
        if (!barActual() || p.location_id === barActual()) cargar();
      },
    };
  }

  return { candidatesFor, blocker, createPanel };
}));
