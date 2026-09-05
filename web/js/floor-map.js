/**
 * EV2 — plano interactivo del club.
 *
 * Reemplaza la lista de botones del paso 5.2 por el mapa que ya estaba diseñado en
 * `table-selector.html`: cada mesa en su coordenada real, la barra, la pista y la
 * entrada dibujadas, y se toca la mesa donde uno se va a sentar.
 *
 * Las coordenadas NO se inventan aquí: vienen de la base (`tables.x/y/radius/color` y
 * `venue_landmarks`), que a su vez salieron del plano oficial "PICK YOUR PARTY".
 *
 * Todo lo que se puede equivocar en silencio — qué mesa cae bajo el dedo, cómo se
 * escala el plano a una pantalla de teléfono, cuántas mesas quedan libres — vive en
 * funciones puras probadas en Node. `draw()` recibe el contexto por parámetro, así que
 * también se prueba sin navegador.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2Map = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Paleta del diseño original (table-selector.html). No se cambia por gusto: el dueño
  // reconoce el club por estos colores.
  const COLORS = {
    background: '#000000',
    grid: 'rgba(0, 191, 255, 0.08)',
    cyan: '#00BFFF',
    pink: '#FF1493',
    lime: '#00FF00',
    red: '#FF4444',
    amber: '#FFD700',
    text: '#FFFFFF',
    muted: '#8892A6',
    selected: '#FFFF00',
    mine: '#00FF00',
  };

  const LANDMARK_STYLE = {
    dance_area: { fill: 'rgba(0, 255, 0, 0.10)', stroke: '#00FF00' },
    bar: { fill: 'rgba(255, 215, 0, 0.10)', stroke: '#FFD700' },
    dj: { fill: 'rgba(157, 0, 255, 0.14)', stroke: '#9D00FF' },
    entrance: { fill: 'rgba(0, 191, 255, 0.10)', stroke: '#00BFFF' },
    restroom: { fill: 'rgba(255, 255, 255, 0.06)', stroke: '#8892A6' },
    vip: { fill: 'rgba(255, 20, 147, 0.12)', stroke: '#FF1493' },
    stage: { fill: 'rgba(255, 20, 147, 0.12)', stroke: '#FF1493' },
    other: { fill: 'rgba(255, 255, 255, 0.05)', stroke: '#8892A6' },
  };

  const DEFAULT_CANVAS = { width: 800, height: 580 };
  const DEFAULT_RADIUS = 24;
  /** Un dedo no es un puntero: se acepta el toque un poco fuera del círculo. */
  const TOUCH_SLACK = 8;

  /**
   * `Number(null)` y `Number('')` valen 0 y 0 es finito, así que un `Number.isFinite`
   * a secas acepta como medida válida lo que en realidad es "no vino nada" — y un
   * plano de 0x0 se escala al infinito. Aquí ausente es ausente.
   */
  const num = (value, fallback = 0) => {
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  const radiusOf = (table) => Math.max(num(table.radius, DEFAULT_RADIUS), 10);

  // ---------------------------------------------------------------- estado de una mesa

  function seatedCount(table) {
    if (Array.isArray(table.occupants)) return table.occupants.length;
    return num(table.seated, 0);
  }

  function isFull(table) {
    const capacity = num(table.capacity, 0);
    return capacity > 0 && seatedCount(table) >= capacity;
  }

  /**
   * Libre = se puede uno sentar ahí ahora. `status` manda sobre el conteo: una mesa
   * reservada puede estar vacía y aun así no ser tuya.
   */
  function isFree(table) {
    if (table.status && table.status !== 'available') return false;
    return !isFull(table);
  }

  function isVip(table) {
    if (table.bottle_service) return true;
    const type = String(table.type || '').toLowerCase();
    if (type.includes('vip')) return true;
    return /VIP|DIAMANTE|ROSA|SUITE/i.test(String(table.section || ''));
  }

  /** Los contadores del panel superior del diseño: total / libres / VIP / ocupadas. */
  function stats(tables) {
    const list = Array.isArray(tables) ? tables : [];
    let available = 0;
    let occupied = 0;
    let vip = 0;
    for (const table of list) {
      if (isFree(table)) available += 1; else occupied += 1;
      if (isVip(table)) vip += 1;
    }
    return { total: list.length, available, occupied, vip };
  }

  /** Las zonas presentes, con su color, para pintar la leyenda sin listarla a mano. */
  function zones(tables) {
    const seen = new Map();
    for (const table of (tables || [])) {
      const name = table.section || 'SIN ZONA';
      if (!seen.has(name)) seen.set(name, table.color || COLORS.cyan);
    }
    return [...seen].map(([name, color]) => ({ name, color }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  function floors(tables) {
    const order = { baja: 1, alta: 2, ambas: 3 };
    return [...new Set((tables || []).map((t) => t.floor).filter(Boolean))]
      .sort((a, b) => (order[a] || 9) - (order[b] || 9));
  }

  const FLOOR_LABELS = { baja: 'PLANTA BAJA', alta: 'PLANTA ALTA', ambas: 'TODO EL CLUB' };
  const floorLabel = (floor) => FLOOR_LABELS[floor] || String(floor || '').toUpperCase();

  // ---------------------------------------------------------------- escala

  /**
   * Encaja el plano en el lienzo disponible manteniendo la proporción.
   *
   * El plano del club mide 800x580; el teléfono no. Si se estirara para llenar la
   * pantalla, las mesas dejarían de estar donde el dueño las tiene y el mapa dejaría de
   * servir para lo único que sirve: reconocer el lugar.
   */
  function layout(canvasSize, planSize) {
    const plan = {
      width: Math.max(num(planSize && planSize.width, DEFAULT_CANVAS.width), 1),
      height: Math.max(num(planSize && planSize.height, DEFAULT_CANVAS.height), 1),
    };
    const view = {
      width: Math.max(num(canvasSize && canvasSize.width, plan.width), 1),
      height: Math.max(num(canvasSize && canvasSize.height, plan.height), 1),
    };
    const scale = Math.min(view.width / plan.width, view.height / plan.height);
    return {
      scale,
      offsetX: (view.width - plan.width * scale) / 2,
      offsetY: (view.height - plan.height * scale) / 2,
      plan,
      view,
    };
  }

  const project = (point, l) => ({
    x: num(point.x) * l.scale + l.offsetX,
    y: num(point.y) * l.scale + l.offsetY,
  });

  /** El inverso: del punto que tocó el dedo a coordenadas del plano. */
  const unproject = (point, l) => ({
    x: (num(point.x) - l.offsetX) / l.scale,
    y: (num(point.y) - l.offsetY) / l.scale,
  });

  /**
   * Qué mesa cae bajo el toque. Devuelve la más cercana entre las que contienen el
   * punto, no la primera del arreglo: en las zonas apretadas dos círculos se tocan y
   * "la primera" sentaría al cliente en la mesa de al lado.
   */
  function hitTest(tables, planPoint, options) {
    const slack = num(options && options.slack, TOUCH_SLACK);
    let best = null;
    let bestDistance = Infinity;
    for (const table of (tables || [])) {
      if (table.x == null || table.y == null) continue;
      const dx = num(table.x) - num(planPoint.x);
      const dy = num(table.y) - num(planPoint.y);
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance <= radiusOf(table) + slack && distance < bestDistance) {
        best = table;
        bestDistance = distance;
      }
    }
    return best;
  }

  /**
   * Convierte el clic del navegador a coordenadas del plano en un solo paso.
   * `rect` es lo que devuelve getBoundingClientRect(): el lienzo se dibuja a una
   * resolución y se muestra a otra, así que sin este ajuste el toque cae desplazado.
   */
  function pointFromEvent(event, rect, canvasSize, l) {
    const scaleX = num(canvasSize.width, 1) / Math.max(num(rect.width, 1), 1);
    const scaleY = num(canvasSize.height, 1) / Math.max(num(rect.height, 1), 1);
    return unproject({
      x: (num(event.clientX) - num(rect.left)) * scaleX,
      y: (num(event.clientY) - num(rect.top)) * scaleY,
    }, l);
  }

  // ---------------------------------------------------------------- colores de la mesa

  function tableFill(table, view) {
    const v = view || {};
    if (v.myTableId && table.id === v.myTableId) return COLORS.mine;
    if (v.selectedId && table.id === v.selectedId) return COLORS.selected;
    if (!isFree(table)) return COLORS.red;
    return table.color || COLORS.cyan;
  }

  function tableStroke(table, view) {
    const v = view || {};
    if (v.myTableId && table.id === v.myTableId) return COLORS.lime;
    if (v.selectedId && table.id === v.selectedId) return COLORS.lime;
    return 'rgba(255,255,255,0.55)';
  }

  // ---------------------------------------------------------------- dibujo

  /**
   * Pinta el plano. `ctx` se recibe por parámetro (no se busca un canvas en el DOM)
   * para poder verificar en pruebas qué se dibuja sin abrir un navegador.
   */
  function draw(ctx, options) {
    const opts = options || {};
    const canvasSize = opts.canvasSize || DEFAULT_CANVAS;
    const l = opts.layout || layout(canvasSize, opts.planSize);
    const tables = opts.tables || [];
    const landmarks = opts.landmarks || [];

    ctx.save();
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, canvasSize.width, canvasSize.height);

    // 1. Los elementos fijos van primero: son el fondo contra el que se leen las mesas.
    for (const mark of landmarks) {
      if (mark.x == null || mark.y == null) continue;
      const style = LANDMARK_STYLE[mark.type] || LANDMARK_STYLE.other;
      const at = project(mark, l);
      const w = num(mark.width, 60) * l.scale;
      const h = num(mark.height, 40) * l.scale;
      ctx.fillStyle = style.fill;
      ctx.fillRect(at.x, at.y, w, h);
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = Math.max(1, 2 * l.scale);
      ctx.strokeRect(at.x, at.y, w, h);

      ctx.fillStyle = style.stroke;
      ctx.font = `bold ${Math.max(9, Math.round(13 * l.scale))}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(mark.name || ''), at.x + w / 2, at.y + h / 2);
    }

    // 2. Las mesas.
    for (const table of tables) {
      if (table.x == null || table.y == null) continue;
      const at = project(table, l);
      const r = Math.max(radiusOf(table) * l.scale, 8);
      const selected = opts.selectedId && table.id === opts.selectedId;

      ctx.beginPath();
      ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
      ctx.fillStyle = tableFill(table, opts);
      ctx.globalAlpha = isFree(table) ? 0.9 : 0.55;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = selected ? Math.max(2, 3 * l.scale) : Math.max(1, 1.5 * l.scale);
      ctx.strokeStyle = tableStroke(table, opts);
      ctx.stroke();

      // El número de la mesa es lo que la gente dice en voz alta ("la 39"), así que se
      // dibuja siempre que quepa.
      if (r >= 9) {
        ctx.fillStyle = '#000000';
        ctx.font = `bold ${Math.max(9, Math.round(r * 0.85))}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(table.table_number != null ? table.table_number : (table.code || '')),
          at.x, at.y);
      }
    }

    ctx.restore();
    return l;
  }

  return {
    COLORS,
    LANDMARK_STYLE,
    DEFAULT_CANVAS,
    seatedCount,
    isFull,
    isFree,
    isVip,
    stats,
    zones,
    floors,
    floorLabel,
    layout,
    project,
    unproject,
    hitTest,
    pointFromEvent,
    tableFill,
    tableStroke,
    draw,
  };
}));
