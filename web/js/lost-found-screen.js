/**
 * EV2 — objetos perdidos, del lado del cliente (D67).
 *
 * ---------------------------------------------------------------------------
 * Lo que esta pantalla NO enseña
 * ---------------------------------------------------------------------------
 * Las señas de los objetos ajenos. El catálogo que se pinta aquí trae categoría, zona
 * y día, y eso es todo lo que el servidor manda — no es que la pantalla las esconda,
 * es que nunca llegan. Con eso alguien puede decir "sí, creo que es mío" y levantar su
 * reporte; sin las señas no puede describir lo que no vio.
 *
 * Sus PROPIOS reportes sí traen sus señas, y el código de entrega cuando el personal
 * ya emparejó. Ese código es lo que se enseña en la barra para recoger el objeto.
 */
/* global EV2Screen, EV2Format */
(function () {
  'use strict';

  if (!window.EV2Screen) return;

  let ctx = null;
  const $ = (id) => document.getElementById(id);

  const state = { kind: 'lost', categories: [], found: [], mine: [], abierto: false };

  const t = (k, v) => (ctx ? ctx.t(k, v) : k);

  /**
   * El nombre de la categoría, traducido.
   *
   * Las claves las manda el servidor (`phone`, `wallet`, …) y los textos viven en el
   * catálogo de idiomas: así el cliente en inglés lee "Phone" sin que el servidor
   * sepa de idiomas.
   */
  const nombreCategoria = (clave) => t(`lf.cat.${clave}`);

  // ---------------------------------------------------------------- cargar

  async function loadFound() {
    const d = await ctx.api.get(`/nightclubs/${ctx.clubId()}/lost-items/found`);
    state.found = d.items || [];
    state.categories = d.categories || [];
    renderCategories();
    renderFound();
  }

  async function loadMine() {
    const d = await ctx.api.get(`/nightclubs/${ctx.clubId()}/lost-items/mine`);
    state.mine = d.items || [];
    renderMine();
  }

  /**
   * Las dos listas de una vez.
   *
   * El error se DICE. Una lista vacía por un fallo de red se ve igual que "no hay nada
   * guardado", y la diferencia entre las dos es que alguien venga al club por nada.
   */
  const loadAll = () => Promise.all([loadFound(), loadMine()])
    .catch((err) => { if (ctx) ctx.showError(err); });

  // ---------------------------------------------------------------- pintar

  function renderCategories() {
    const sel = $('lf-category');
    if (!sel || sel.options.length === state.categories.length) return;
    sel.innerHTML = '';
    for (const clave of state.categories) {
      const opt = document.createElement('option');
      opt.value = clave;
      opt.textContent = nombreCategoria(clave);
      sel.appendChild(opt);
    }
  }

  function renderFound() {
    const caja = $('lf-found');
    if (!caja) return;
    $('lf-found-empty').hidden = state.found.length > 0;
    caja.innerHTML = '';
    for (const item of state.found) {
      const fila = document.createElement('div');
      fila.className = 'card rounded-lg px-3 py-2 flex items-center justify-between gap-3';
      const izq = document.createElement('div');
      izq.className = 'min-w-0';
      const que = document.createElement('p');
      que.className = 'text-sm';
      que.textContent = nombreCategoria(item.category);
      const donde = document.createElement('p');
      donde.className = 'text-[11px] text-white/50 truncate';
      donde.textContent = [item.place, EV2Format.date(item.happened_at)].filter(Boolean).join(' · ');
      izq.append(que, donde);

      // "En resguardo" es distinto de "alguien dijo que lo dejó": lo primero significa
      // que el club lo tiene en la mano, y es lo que decide si vale la pena venir.
      const estado = document.createElement('span');
      estado.className = 'text-[11px] shrink-0';
      estado.style.color = item.in_custody ? 'var(--ev2-lime)' : '#fcd34d';
      estado.textContent = t(item.in_custody ? 'lf.inCustody' : 'lf.reportedOnly');

      fila.append(izq, estado);
      caja.appendChild(fila);
    }
  }

  function renderMine() {
    const caja = $('lf-mine');
    if (!caja) return;
    $('lf-mine-empty').hidden = state.mine.length > 0;
    caja.innerHTML = '';
    for (const item of state.mine) {
      const card = document.createElement('div');
      card.className = 'card rounded-lg px-3 py-2 space-y-1';

      const arriba = document.createElement('div');
      arriba.className = 'flex items-center justify-between gap-2';
      const que = document.createElement('p');
      que.className = 'text-sm';
      que.textContent = `${nombreCategoria(item.category)} · ${t(`lf.kind.${item.kind}`)}`;
      const estado = document.createElement('span');
      estado.className = 'text-[11px] shrink-0';
      estado.textContent = t(`lf.status.${item.status}`);
      estado.style.color = item.status === 'matched' ? 'var(--ev2-lime)'
        : item.status === 'returned' ? 'rgba(255,255,255,.4)' : '';
      arriba.append(que, estado);
      card.appendChild(arriba);

      // El código de entrega, en grande, cuando ya hay algo que recoger. Es lo que se
      // enseña en la barra, y es lo único que autoriza que se lo den a alguien.
      if (item.status === 'matched' && item.handover_code) {
        const aviso = document.createElement('p');
        aviso.className = 'text-[11px] text-white/60';
        aviso.textContent = item.storage_note
          ? t('lf.pickUpAt', { place: item.storage_note })
          : t('lf.pickUp');
        const codigo = document.createElement('p');
        codigo.className = 'font-display text-2xl tracking-[0.2em] text-center py-1';
        codigo.style.color = 'var(--ev2-gold)';
        codigo.textContent = item.handover_code;
        card.append(aviso, codigo);
      }

      if (item.closed_reason) {
        const motivo = document.createElement('p');
        motivo.className = 'text-[11px] text-white/40';
        motivo.textContent = item.closed_reason;
        card.appendChild(motivo);
      }
      caja.appendChild(card);
    }
  }

  // ---------------------------------------------------------------- enganche

  function enganchar() {
    if (!$('btn-lf-open')) return;

    $('btn-lf-open').onclick = async () => {
      state.abierto = !state.abierto;
      $('lf-panel').hidden = !state.abierto;
      $('btn-lf-open').textContent = t(state.abierto ? 'lf.close' : 'lf.open');
      if (state.abierto) await loadAll();
    };

    const elegir = (kind) => {
      state.kind = kind;
      $('btn-lf-kind-lost').classList.toggle('on', kind === 'lost');
      $('btn-lf-kind-found').classList.toggle('on', kind === 'found');
      // El texto del botón cambia con lo que se va a hacer: "levantar un reporte" y
      // "entregar algo" son actos distintos y quien los hace está pensando en uno.
      $('btn-lf-send').textContent = t(kind === 'lost' ? 'lf.send' : 'lf.sendFound');
    };
    $('btn-lf-kind-lost').onclick = () => elegir('lost');
    $('btn-lf-kind-found').onclick = () => elegir('found');

    $('btn-lf-send').onclick = async () => {
      const error = $('lf-error');
      error.hidden = true;
      const details = $('lf-details').value.trim();
      // Se comprueba lo que el servidor va a comprobar: sin señas no hay forma de
      // demostrar que algo es de quien dice, así que es lo único obligatorio.
      if (details.length < 3) {
        error.textContent = t('lf.errDetails');
        error.hidden = false;
        return;
      }
      const boton = $('btn-lf-send');
      const antes = boton.textContent;
      boton.disabled = true;
      boton.textContent = t('lf.sending');
      try {
        await ctx.api.post(`/nightclubs/${ctx.clubId()}/lost-items`, {
          kind: state.kind,
          category: $('lf-category').value,
          details,
          place: $('lf-place').value.trim() || undefined,
        });
        $('lf-details').value = '';
        $('lf-place').value = '';
        ctx.toast(t(state.kind === 'lost' ? 'lf.sentLost' : 'lf.sentFound'), 'ok');
        await loadAll();
      } catch (err) {
        ctx.showError(err, error);
      } finally {
        boton.disabled = false;
        boton.textContent = antes;
      }
    };
  }

  EV2Screen.on('enter', (screen) => {
    ctx = screen;
    enganchar();
  });

  // El aviso del emparejamiento trae el código: se recarga para enseñarlo sin que la
  // persona tenga que salir y volver a entrar a la pantalla.
  EV2Screen.on('event', (message) => {
    if (!ctx || !state.abierto) return;
    if (message && message.event_type === 'lost_item_matched') loadAll();
  });

  EV2Screen.on('language', () => {
    if (!ctx) return;
    renderCategories();
    renderFound();
    renderMine();
  });
}());
