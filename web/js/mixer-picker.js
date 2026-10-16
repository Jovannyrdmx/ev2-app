/**
 * EV2 — el selector de mezcladores del servicio de botella (D117).
 *
 * Lo usan el cliente (index) y el mesero (staff): al pedir una botella con servicio se
 * abre esta hoja, se eligen los mezcladores y se ve en vivo cuántos van incluidos y
 * cuánto se cobra de más. La cuenta la hace `EV2Client.mixerBreakdown`, que es la
 * misma del servidor; aquí solo se pinta. El precio que cuenta es el que pone el
 * servidor al crear el pedido.
 *
 *   EV2MixerPicker.open({
 *     drink, quantity, mixers,          // la botella, cuántas, el catálogo activo
 *     selection,                        // lo ya elegido [{ mixer_id, name, extra_price, quantity }]
 *     money,                            // (monto, moneda) => texto
 *     onSave(selection),                // al tocar "Listo"
 *   });
 */
(function (root) {
  'use strict';

  const F = () => root.EV2Format;
  const t = (key, fallback) => (F() ? F().t(key, fallback) : fallback);
  const tf = (key, vars, fallback) => (F() ? F().tf(key, vars) : fallback);
  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let abierto = null;

  function close() {
    if (abierto) abierto.remove();
    abierto = null;
  }

  function open({ drink, quantity = 1, mixers = [], selection = [], money, onSave }) {
    close();
    const fmt = money || ((a) => `$${Number(a).toFixed(2)}`);
    const cantidades = new Map((selection || []).map((m) => [m.mixer_id, Number(m.quantity) || 0]));

    const hoja = document.createElement('div');
    hoja.id = 'mixer-picker';
    hoja.className = 'fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70';
    hoja.setAttribute('role', 'dialog');
    hoja.setAttribute('aria-modal', 'true');
    abierto = hoja;

    const eleccion = () => mixers.map((m) => ({
      mixer_id: m.id, name: m.name, extra_price: m.extra_price,
      size: m.size === 'large' ? 'large' : 'small', quantity: cantidades.get(m.id) || 0,
    })).filter((m) => m.quantity > 0);
    const grupos = [
      { size: 'small', label: t('mix.small', 'Chicos'), per: Number(drink.included_mixers || 0) },
      { size: 'large', label: t('mix.large', 'Grandes'), per: Number(drink.included_large_mixers || 0) },
    ].map((g) => ({ ...g, items: mixers.filter((m) => (m.size === 'large' ? 'large' : 'small') === g.size) }))
      .filter((g) => g.items.length > 0);

    function fila(m) {
      const q = cantidades.get(m.id) || 0;
      const extra = Number(m.extra_price) > 0
        ? tf('mix.extraEach', { price: fmt(m.extra_price, drink.currency) }, `${fmt(m.extra_price)} c/u extra`)
        : t('mix.freeExtra', 'Sin costo extra');
      return `
              <div class="flex items-center gap-3" data-mixer="${escape(m.id)}">
                <div class="min-w-0 flex-1">
                  <p class="text-sm break-words">${escape(m.name)}</p>
                  <p class="text-[11px] text-white/45">${escape(extra)}</p>
                </div>
                <button type="button" class="card rounded-lg w-10 h-10 text-lg" data-less="1" aria-label="-">−</button>
                <span class="w-6 text-center text-sm" data-role="qty">${q}</span>
                <button type="button" class="ev2-button rounded-lg w-10 h-10 text-lg" data-more="1" aria-label="+">+</button>
              </div>`;
    }

    function pintar() {
      const cuenta = root.EV2Client.mixerBreakdown(drink, quantity, eleccion());
      const elegidosDe = (size) => eleccion().filter((m) => m.size === size)
        .reduce((n, m) => n + m.quantity, 0);
      hoja.innerHTML = `
        <div class="card w-full sm:max-w-md max-h-[85vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl p-4 space-y-3 bg-[#14101c]">
          <div>
            <p class="font-display text-lg leading-tight">${escape(drink.name)}</p>
            <p class="text-xs text-white/60" data-role="mix-included">${escape(tf('mix.includedBoth', {
    small: Number(drink.included_mixers || 0) * quantity,
    large: Number(drink.included_large_mixers || 0) * quantity,
    bottles: quantity,
  }, ''))}</p>
          </div>
          ${mixers.length ? '' : `<p class="text-sm text-white/50">${escape(t('mix.none', 'No hay mezcladores dados de alta.'))}</p>`}
          ${grupos.map((g) => `
          <div class="space-y-2" data-group="${g.size}">
            <p class="text-xs uppercase tracking-wider text-white/50 flex justify-between">
              <span>${escape(g.label)}</span>
              <span data-role="mix-count">${escape(tf('mix.count', { n: elegidosDe(g.size), max: g.per * quantity }, ''))}</span>
            </p>
            ${g.items.map(fila).join('')}
          </div>`).join('')}
          <div class="flex justify-end text-sm border-t border-white/10 pt-3">
            <span data-role="mix-extra" class="${cuenta.extraCents > 0 ? 'text-amber-200' : 'text-white/50'}">
              ${escape(cuenta.extraCents > 0
    ? tf('mix.extraTotal', { amount: fmt(cuenta.extra, drink.currency) }, `+${fmt(cuenta.extra)}`)
    : t('mix.noExtra', 'Sin cargo extra'))}</span>
          </div>
          <div class="flex gap-2 pt-1">
            <button type="button" class="card rounded-xl px-4 py-3 text-sm flex-1" data-act="cancel">${escape(t('mix.cancel', 'Cancelar'))}</button>
            <button type="button" class="ev2-button rounded-xl px-4 py-3 text-sm flex-1 font-semibold" data-act="save">${escape(t('mix.save', 'Listo'))}</button>
          </div>
        </div>`;

      hoja.querySelectorAll('[data-mixer]').forEach((fila) => {
        const id = fila.dataset.mixer;
        fila.querySelector('[data-more]').onclick = () => {
          cantidades.set(id, Math.min(50, (cantidades.get(id) || 0) + 1)); pintar();
        };
        fila.querySelector('[data-less]').onclick = () => {
          cantidades.set(id, Math.max(0, (cantidades.get(id) || 0) - 1)); pintar();
        };
      });
      hoja.querySelector('[data-act="cancel"]').onclick = close;
      hoja.querySelector('[data-act="save"]').onclick = () => {
        const sel = eleccion();
        close();
        if (onSave) onSave(sel);
      };
    }

    hoja.addEventListener('click', (e) => { if (e.target === hoja) close(); });
    document.body.appendChild(hoja);
    pintar();
    return hoja;
  }

  /** Una línea corta con lo elegido, para enseñarla bajo la botella. */
  function summary(selection) {
    return (selection || []).filter((m) => m.quantity > 0)
      .map((m) => `${m.quantity} ${m.name}`).join(', ');
  }

  root.EV2MixerPicker = { open, close, summary };
}(typeof globalThis !== 'undefined' ? globalThis : this));
