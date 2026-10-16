/**
 * EV2 — el selector de mezcladores del servicio de botella (D117).
 *
 * Lo usan el cliente (index) y el mesero (staff). Al pedir una botella con servicio se
 * abre en dos pasos, que es como lo pidió el dueño:
 *
 *   Paso 1: elige tus chicos (los lugares de chico de la botella, p. ej. 3).
 *   Paso 2: elige UN GRANDE O UN CHICO (el lugar flexible, p. ej. 1).
 *
 * Si la botella no tiene lugar flexible, solo hay paso 1. Pasarse de lo incluido se
 * puede, y se ve en vivo cuánto se cobra de más. La cuenta la hace
 * `EV2Client.mixerBreakdown`, que es la misma del servidor; aquí solo se pinta. El
 * precio que cuenta es el que pone el servidor al crear el pedido.
 *
 *   EV2MixerPicker.open({
 *     drink, quantity, mixers,          // la botella, cuántas, el catálogo activo
 *     selection,                        // lo ya elegido [{ mixer_id, name, extra_price, size, quantity }]
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
  const sizeOf = (m) => (m.size === 'large' ? 'large' : 'small');

  let abierto = null;

  function close() {
    if (abierto) abierto.remove();
    abierto = null;
  }

  function open({ drink, quantity = 1, mixers = [], selection = [], money, onSave }) {
    close();
    const fmt = money || ((a) => `$${Number(a).toFixed(2)}`);
    const q = Math.max(1, Number(quantity) || 1);
    const lugaresChicos = Number(drink.included_mixers || 0) * q;
    const lugaresFlex = Number(drink.included_large_mixers || 0) * q;
    const chicos = mixers.filter((m) => sizeOf(m) === 'small');
    const grandes = mixers.filter((m) => sizeOf(m) === 'large');
    const conPaso2 = lugaresFlex > 0 || (lugaresChicos === 0 && grandes.length > 0);

    // Lo elegido en cada paso. Al volver a abrir, los chicos llenan primero el paso 1
    // y lo demás (grandes y chicos de más) queda en el paso 2.
    const paso1 = new Map();
    const paso2 = new Map();
    let cupo = lugaresChicos;
    for (const s of selection || []) {
      const n = Number(s.quantity) || 0;
      if (n <= 0) continue;
      if (sizeOf(s) === 'small' && conPaso2) {
        const a = Math.min(cupo, n);
        cupo -= a;
        if (a) paso1.set(s.mixer_id, (paso1.get(s.mixer_id) || 0) + a);
        if (n - a) paso2.set(s.mixer_id, (paso2.get(s.mixer_id) || 0) + (n - a));
      } else if (sizeOf(s) === 'small') {
        paso1.set(s.mixer_id, (paso1.get(s.mixer_id) || 0) + n);
      } else {
        paso2.set(s.mixer_id, (paso2.get(s.mixer_id) || 0) + n);
      }
    }
    let paso = chicos.length === 0 && conPaso2 ? 2 : 1;

    const hoja = document.createElement('div');
    hoja.id = 'mixer-picker';
    hoja.className = 'fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70';
    hoja.setAttribute('role', 'dialog');
    hoja.setAttribute('aria-modal', 'true');
    abierto = hoja;

    /** Los dos pasos juntos, sumados por mezclador: es lo que viaja al pedido. */
    const eleccion = () => mixers.map((m) => ({
      mixer_id: m.id, name: m.name, extra_price: m.extra_price, size: sizeOf(m),
      quantity: (paso1.get(m.id) || 0) + (paso2.get(m.id) || 0),
    })).filter((m) => m.quantity > 0);
    const total = (mapa) => [...mapa.values()].reduce((n, v) => n + v, 0);

    function fila(m, mapa) {
      const n = mapa.get(m.id) || 0;
      const extra = Number(m.extra_price) > 0
        ? tf('mix.extraEach', { price: fmt(m.extra_price, drink.currency) }, `${fmt(m.extra_price)} c/u extra`)
        : t('mix.freeExtra', 'Sin costo extra');
      const etiqueta = sizeOf(m) === 'large' ? t('mix.largeOne', 'Grande') : t('mix.smallOne', 'Chico');
      return `
        <div class="flex items-center gap-3" data-mixer="${escape(m.id)}">
          <div class="min-w-0 flex-1">
            <p class="text-sm break-words">${escape(m.name)}
              ${paso === 2 ? `<span class="ml-1 text-[10px] uppercase text-white/45">${escape(etiqueta)}</span>` : ''}</p>
            <p class="text-[11px] text-white/45">${escape(extra)}</p>
          </div>
          <button type="button" class="card rounded-lg w-10 h-10 text-lg" data-less="1" aria-label="-">−</button>
          <span class="w-6 text-center text-sm" data-role="qty">${n}</span>
          <button type="button" class="ev2-button rounded-lg w-10 h-10 text-lg" data-more="1" aria-label="+">+</button>
        </div>`;
    }

    function pintar() {
      const cuenta = root.EV2Client.mixerBreakdown(drink, q, eleccion());
      const mapa = paso === 1 ? paso1 : paso2;
      const lista = paso === 1 ? chicos : [...grandes, ...chicos];
      const meta = paso === 1 ? lugaresChicos : lugaresFlex;
      const titulo = paso === 1
        ? tf('mix.step1', { n: lugaresChicos }, `Elige ${lugaresChicos} chico(s)`)
        : tf('mix.step2', { n: lugaresFlex }, `Elige ${lugaresFlex} grande o chico`);
      const pasos = conPaso2 && chicos.length > 0
        ? `<p class="text-[11px] uppercase tracking-wider text-white/45">${escape(tf('mix.stepOf', { step: paso, total: 2 }, `Paso ${paso} de 2`))}</p>` : '';
      const ultimo = paso === 2 || !conPaso2;

      hoja.innerHTML = `
        <div class="card w-full sm:max-w-md max-h-[85vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl p-4 space-y-3 bg-[#14101c]">
          <div class="space-y-0.5">
            <p class="font-display text-lg leading-tight">${escape(drink.name)}${q > 1 ? ` × ${q}` : ''}</p>
            ${pasos}
            <p class="text-sm font-semibold" data-role="mix-step">${escape(titulo)}</p>
          </div>
          ${lista.length ? '' : `<p class="text-sm text-white/50">${escape(t('mix.none', 'No hay mezcladores dados de alta.'))}</p>`}
          <div class="space-y-2">${lista.map((m) => fila(m, mapa)).join('')}</div>
          <div class="flex justify-between text-sm border-t border-white/10 pt-3">
            <span data-role="mix-count">${escape(tf('mix.count', { n: total(mapa), max: meta }, ''))}</span>
            <span data-role="mix-extra" class="${cuenta.extraCents > 0 ? 'text-amber-200' : 'text-white/50'}">
              ${escape(cuenta.extraCents > 0
    ? tf('mix.extraTotal', { amount: fmt(cuenta.extra, drink.currency) }, `+${fmt(cuenta.extra)}`)
    : t('mix.noExtra', 'Sin cargo extra'))}</span>
          </div>
          <div class="flex gap-2 pt-1">
            <button type="button" class="card rounded-xl px-4 py-3 text-sm flex-1" data-act="back">
              ${escape(paso === 2 && chicos.length > 0 ? t('mix.back', 'Atrás') : t('mix.cancel', 'Cancelar'))}</button>
            <button type="button" class="ev2-button rounded-xl px-4 py-3 text-sm flex-1 font-semibold" data-act="next">
              ${escape(ultimo ? t('mix.save', 'Listo') : t('mix.next', 'Siguiente'))}</button>
          </div>
        </div>`;

      hoja.querySelectorAll('[data-mixer]').forEach((el) => {
        const id = el.dataset.mixer;
        el.querySelector('[data-more]').onclick = () => {
          mapa.set(id, Math.min(50, (mapa.get(id) || 0) + 1)); pintar();
        };
        el.querySelector('[data-less]').onclick = () => {
          mapa.set(id, Math.max(0, (mapa.get(id) || 0) - 1)); pintar();
        };
      });
      hoja.querySelector('[data-act="back"]').onclick = () => {
        if (paso === 2 && chicos.length > 0) { paso = 1; pintar(); } else close();
      };
      hoja.querySelector('[data-act="next"]').onclick = () => {
        if (!ultimo) { paso = 2; pintar(); return; }
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
