'use strict';

// El plano del club: qué mesa cae bajo el dedo, cómo se encaja un plano de 800x580 en la
// pantalla de un teléfono, y qué se dibuja. Nada de esto se nota mal a simple vista —
// un mapa desplazado sienta al cliente en la mesa de al lado y parece que funcionó.

const Map = require('../../web/js/floor-map.js');
const Roles = require('../../web/js/roles.js');

const table = (over = {}) => Object.assign({
  id: 't1', code: '39', table_number: 39, section: 'ZONA ROJA', floor: 'baja',
  type: 'booth', capacity: 8, x: 255, y: 88, radius: 30, color: '#FF2D2D',
  status: 'available', bottle_service: true, occupants: [],
}, over);

// ---------------------------------------------------------------- estado de la mesa

describe('Estado de una mesa', () => {
  it('cuenta a los sentados desde `occupants` o desde `seated`', () => {
    // /tables devuelve la lista de personas; /floor-plan solo el número.
    expect(Map.seatedCount(table({ occupants: [{ user_id: 'a' }, { user_id: 'b' }] }))).toBe(2);
    expect(Map.seatedCount(table({ occupants: undefined, seated: 3 }))).toBe(3);
    expect(Map.seatedCount(table({ occupants: undefined, seated: undefined }))).toBe(0);
  });

  it('una mesa llena no está libre', () => {
    const full = table({ capacity: 2, occupants: [{ user_id: 'a' }, { user_id: 'b' }] });
    expect(Map.isFull(full)).toBe(true);
    expect(Map.isFree(full)).toBe(false);
  });

  it('el estado manda sobre el conteo: una mesa reservada y vacía no es tuya', () => {
    const reserved = table({ status: 'reserved', occupants: [] });
    expect(Map.isFull(reserved)).toBe(false);
    expect(Map.isFree(reserved)).toBe(false);
  });

  it('reconoce las mesas VIP por servicio de botella, tipo o nombre de zona', () => {
    expect(Map.isVip(table({ bottle_service: true }))).toBe(true);
    expect(Map.isVip(table({ bottle_service: false, type: 'vip' }))).toBe(true);
    expect(Map.isVip(table({ bottle_service: false, type: 'booth', section: 'ZONA DOBLE DIAMANTE' }))).toBe(true);
    expect(Map.isVip(table({ bottle_service: false, type: 'standard', section: 'GENERAL' }))).toBe(false);
  });

  it('los contadores del panel cuadran con el total', () => {
    const tables = [
      table({ id: 'a' }),
      table({ id: 'b', bottle_service: false, section: 'GENERAL', capacity: 4, occupants: [{}, {}, {}, {}] }),
      table({ id: 'c', bottle_service: false, section: 'GENERAL', status: 'blocked' }),
    ];
    const s = Map.stats(tables);
    expect(s.total).toBe(3);
    expect(s.available).toBe(1);
    expect(s.occupied).toBe(2);
    expect(s.available + s.occupied).toBe(s.total);
    expect(s.vip).toBe(1);
  });

  it('sin mesas los contadores son ceros, no NaN', () => {
    expect(Map.stats([])).toEqual({ total: 0, available: 0, occupied: 0, vip: 0 });
    expect(Map.stats(undefined).total).toBe(0);
  });
});

// ---------------------------------------------------------------- pisos y zonas

describe('Pisos y zonas', () => {
  it('la planta baja va antes que la alta, sin importar el orden que llegue', () => {
    const tables = [table({ floor: 'alta' }), table({ floor: 'baja' }), table({ floor: 'alta' })];
    expect(Map.floors(tables)).toEqual(['baja', 'alta']);
  });

  it('traduce el piso al nombre que usa el club', () => {
    expect(Map.floorLabel('baja')).toBe('PLANTA BAJA');
    expect(Map.floorLabel('alta')).toBe('PLANTA ALTA');
    // Un piso que la app no conoce se muestra tal cual, no vacío.
    expect(Map.floorLabel('terraza')).toBe('TERRAZA');
  });

  it('la leyenda toma el color real de cada zona, sin repetirla', () => {
    const zones = Map.zones([
      table({ section: 'ZONA ROJA', color: '#FF2D2D' }),
      table({ section: 'ZONA ROJA', color: '#FF2D2D' }),
      table({ section: 'ZONA AZUL', color: '#1E90FF' }),
    ]);
    expect(zones).toEqual([
      { name: 'ZONA AZUL', color: '#1E90FF' },
      { name: 'ZONA ROJA', color: '#FF2D2D' },
    ]);
  });
});

// ---------------------------------------------------------------- escala

describe('Encaje del plano en la pantalla', () => {
  it('mantiene la proporción: el plano no se estira', () => {
    // 800x580 dentro de 400x400: manda el ancho.
    const l = Map.layout({ width: 400, height: 400 }, { width: 800, height: 580 });
    expect(l.scale).toBeCloseTo(0.5, 6);
    expect(l.offsetX).toBeCloseTo(0, 6);
    expect(l.offsetY).toBeCloseTo((400 - 290) / 2, 6);
  });

  it('proyectar y desproyectar devuelve el mismo punto', () => {
    const l = Map.layout({ width: 400, height: 400 }, { width: 800, height: 580 });
    const back = Map.unproject(Map.project({ x: 255, y: 88 }, l), l);
    expect(back.x).toBeCloseTo(255, 6);
    expect(back.y).toBeCloseTo(88, 6);
  });

  it('sin tamaño de plano usa el del club (800x580) en vez de dividir entre cero', () => {
    const l = Map.layout({ width: 800, height: 580 }, null);
    expect(l.scale).toBe(1);
    expect(Number.isFinite(l.offsetX)).toBe(true);
  });

  it('un lienzo mostrado más chico que su resolución no desplaza el toque', () => {
    // El canvas se dibuja a 800x580 y el navegador lo muestra a 320px de ancho.
    const size = { width: 800, height: 580 };
    const l = Map.layout(size, size);
    const rect = { left: 0, top: 0, width: 320, height: 232 };
    // Tocar el centro visual tiene que caer en el centro del plano.
    const point = Map.pointFromEvent({ clientX: 160, clientY: 116 }, rect, size, l);
    expect(point.x).toBeCloseTo(400, 4);
    expect(point.y).toBeCloseTo(290, 4);
  });

  it('el desplazamiento de la página se descuenta con `rect`', () => {
    const size = { width: 800, height: 580 };
    const l = Map.layout(size, size);
    const rect = { left: 50, top: 120, width: 800, height: 580 };
    const point = Map.pointFromEvent({ clientX: 50 + 255, clientY: 120 + 88 }, rect, size, l);
    expect(point.x).toBeCloseTo(255, 4);
    expect(point.y).toBeCloseTo(88, 4);
  });
});

// ---------------------------------------------------------------- toque

describe('Qué mesa cae bajo el dedo', () => {
  it('acierta en el centro', () => {
    const t = table();
    expect(Map.hitTest([t], { x: 255, y: 88 })).toBe(t);
  });

  it('no devuelve nada al tocar el piso vacío', () => {
    expect(Map.hitTest([table()], { x: 10, y: 10 })).toBe(null);
  });

  it('entre dos mesas encimadas devuelve la más cercana, no la primera del arreglo', () => {
    // En las zonas apretadas los círculos se tocan; "la primera" sentaría al cliente
    // en la mesa de al lado.
    const a = table({ id: 'a', x: 100, y: 100, radius: 30 });
    const b = table({ id: 'b', x: 140, y: 100, radius: 30 });
    expect(Map.hitTest([a, b], { x: 135, y: 100 }).id).toBe('b');
    expect(Map.hitTest([a, b], { x: 105, y: 100 }).id).toBe('a');
  });

  it('perdona unos píxeles alrededor: un dedo no es un puntero', () => {
    const t = table({ x: 100, y: 100, radius: 20 });
    expect(Map.hitTest([t], { x: 125, y: 100 })).toBe(t);   // 25 px: dentro de la holgura
    expect(Map.hitTest([t], { x: 160, y: 100 })).toBe(null); // 60 px: claramente fuera
  });

  it('ignora las mesas sin coordenadas en vez de ponerlas en la esquina', () => {
    const sinPlano = table({ id: 'x', x: null, y: null });
    expect(Map.hitTest([sinPlano], { x: 0, y: 0 })).toBe(null);
  });
});

// ---------------------------------------------------------------- colores

describe('Color de la mesa', () => {
  it('tu mesa se pinta distinto que la seleccionada y que una libre', () => {
    const t = table();
    expect(Map.tableFill(t, { myTableId: 't1' })).toBe(Map.COLORS.mine);
    expect(Map.tableFill(t, { selectedId: 't1' })).toBe(Map.COLORS.selected);
    expect(Map.tableFill(t, {})).toBe('#FF2D2D');
  });

  it('una mesa ocupada se pinta en rojo aunque su zona sea de otro color', () => {
    const full = table({ capacity: 1, occupants: [{ user_id: 'a' }] });
    expect(Map.tableFill(full, {})).toBe(Map.COLORS.red);
  });

  it('tu mesa gana sobre la selección: siempre sabes dónde estás sentado', () => {
    expect(Map.tableFill(table(), { myTableId: 't1', selectedId: 't1' })).toBe(Map.COLORS.mine);
  });
});

// ---------------------------------------------------------------- dibujo

/** Un lienzo de mentira que apunta lo que se le pidió, para verificar sin navegador. */
function recordingContext() {
  const calls = [];
  const record = (name) => (...args) => calls.push({ name, args });
  return {
    calls,
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    arc: record('arc'),
    fill: record('fill'),
    stroke: record('stroke'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    fillText: record('fillText'),
    set fillStyle(v) { calls.push({ name: 'fillStyle', args: [v] }); },
    get fillStyle() { return null; },
    set strokeStyle(v) { calls.push({ name: 'strokeStyle', args: [v] }); },
    get strokeStyle() { return null; },
    set lineWidth(v) { calls.push({ name: 'lineWidth', args: [v] }); },
    get lineWidth() { return 0; },
    set globalAlpha(v) { calls.push({ name: 'globalAlpha', args: [v] }); },
    get globalAlpha() { return 1; },
    set font(v) { calls.push({ name: 'font', args: [v] }); },
    get font() { return ''; },
    set textAlign(v) { calls.push({ name: 'textAlign', args: [v] }); },
    get textAlign() { return ''; },
    set textBaseline(v) { calls.push({ name: 'textBaseline', args: [v] }); },
    get textBaseline() { return ''; },
  };
}

describe('Dibujo del plano', () => {
  const canvasSize = { width: 800, height: 580 };
  const planSize = { width: 800, height: 580 };

  it('dibuja un círculo por mesa, en su coordenada real', () => {
    const ctx = recordingContext();
    Map.draw(ctx, {
      canvasSize, planSize, tables: [table({ x: 255, y: 88, radius: 30 })], landmarks: [],
    });
    const arcs = ctx.calls.filter((c) => c.name === 'arc');
    expect(arcs).toHaveLength(1);
    expect(arcs[0].args[0]).toBeCloseTo(255, 4);
    expect(arcs[0].args[1]).toBeCloseTo(88, 4);
    expect(arcs[0].args[2]).toBeCloseTo(30, 4);
  });

  it('escribe el número que la gente dice en voz alta', () => {
    const ctx = recordingContext();
    Map.draw(ctx, { canvasSize, planSize, tables: [table({ table_number: 39 })], landmarks: [] });
    const texts = ctx.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
    expect(texts).toContain('39');
  });

  it('dibuja la barra y la pista antes que las mesas, para que se lean encima', () => {
    const ctx = recordingContext();
    Map.draw(ctx, {
      canvasSize,
      planSize,
      tables: [table()],
      landmarks: [{ code: 'dance', name: 'DANCE FLOOR', type: 'dance_area', x: 300, y: 150, width: 210, height: 120 }],
    });
    const firstLandmark = ctx.calls.findIndex((c) => c.name === 'strokeRect');
    const firstTable = ctx.calls.findIndex((c) => c.name === 'arc');
    expect(firstLandmark).toBeGreaterThan(-1);
    expect(firstLandmark).toBeLessThan(firstTable);
    expect(ctx.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]))
      .toContain('DANCE FLOOR');
  });

  it('una mesa sin coordenadas no se dibuja en la esquina superior izquierda', () => {
    const ctx = recordingContext();
    Map.draw(ctx, { canvasSize, planSize, tables: [table({ x: null, y: null })], landmarks: [] });
    expect(ctx.calls.filter((c) => c.name === 'arc')).toHaveLength(0);
  });

  it('devuelve el mismo encaje que usó, para que el toque coincida con lo pintado', () => {
    const ctx = recordingContext();
    const used = Map.draw(ctx, {
      canvasSize: { width: 400, height: 400 }, planSize, tables: [], landmarks: [],
    });
    expect(used.scale).toBeCloseTo(Map.layout({ width: 400, height: 400 }, planSize).scale, 8);
  });
});

// ---------------------------------------------------------------- ruteo por rol

describe('A dónde va cada rol al entrar', () => {
  it('el invitado se queda en la pantalla del club', () => {
    expect(Roles.route('guest', '/index.html')).toEqual({
      action: 'stay', info: expect.objectContaining({ role: 'guest', ready: true }),
    });
  });

  it('un empleado NO se queda en la pantalla del invitado', () => {
    // Este era el error: bartender y admin aterrizaban en el plano de mesas.
    for (const role of ['bartender', 'waiter', 'manager', 'admin', 'valet', 'driver']) {
      expect(Roles.route(role, '/index.html').action).not.toBe('stay');
    }
  });

  it('mientras su pantalla no esté conectada se le dice, no se le manda a datos falsos', () => {
    const r = Roles.route('bartender', '/index.html');
    expect(r.action).toBe('pending');
    expect(r.info.step).toBe('5.7');
    expect(r.info.does).toMatch(/barra/i);
  });

  it('un rol que la base acepta pero la app no conoce no deja la pantalla en blanco', () => {
    const r = Roles.route('inspector_de_humo', '/index.html');
    expect(r.action).toBe('pending');
    expect(r.info.label).toBe('Sin rol asignado');
    expect(r.info.step).toBe(null);
  });

  it('todos los roles del CHECK de la migración 009 tienen destino', () => {
    // Si alguien agrega un rol en la base y no aquí, esta prueba lo señala.
    const inDatabase = ['guest', 'waiter', 'bartender', 'dancer', 'dj', 'light_tech',
      'valet', 'hostess', 'driver', 'manager', 'admin'];
    for (const role of inDatabase) {
      const info = Roles.describe(role);
      expect(info.label).not.toBe('Sin rol asignado');
      expect(info.home).toBeTruthy();
      if (!info.ready) expect(info.step).toMatch(/^5\.\d$/);
    }
  });

  it('cuando una pantalla se conecte, el rol se redirige sin tocar nada más', () => {
    // Simula el paso 5.7 ya hecho: basta con ready:true en roles.js.
    const original = Roles.ROLES.bartender.ready;
    Roles.ROLES.bartender.ready = true;
    try {
      expect(Roles.route('bartender', '/index.html')).toEqual(
        expect.objectContaining({ action: 'redirect', to: 'bartender.html' }),
      );
      expect(Roles.route('bartender', '/bartender.html').action).toBe('stay');
    } finally {
      Roles.ROLES.bartender.ready = original;
    }
  });
});
