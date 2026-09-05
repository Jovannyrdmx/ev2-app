'use strict';

// La cola de la barra (paso 5.7). Lo que se rompe sin que nadie lo note: un pedido que
// desaparece de la pantalla, uno que se hunde al fondo mientras el cliente espera, o un
// botón que ofrece una transición que el servidor va a rechazar.

const Bar = require('../../web/js/bar-queue.js');

const MINUTE = 60000;
const NOW = Date.parse('2026-09-05T23:30:00.000Z');
const agoMinutes = (n) => new Date(NOW - n * MINUTE).toISOString();

const order = (over = {}) => Object.assign({
  id: 'o1',
  status: 'pending',
  subtotal: '158.00',
  currency: 'MXN',
  created_at: agoMinutes(1),
  table_id: 'tbl',
  table_code: '39',
  sender_id: 'u1',
  sender_name: 'María',
  recipient_id: null,
  recipient_name: null,
  message: null,
  items: [{ drink_id: 'd1', name: 'Corona', quantity: 2, unit_price: '79.00' }],
}, over);

// ---------------------------------------------------------------- carriles

describe('En qué carril cae cada pedido', () => {
  it('los seis estados vivos se reparten en tres carriles', () => {
    expect(Bar.laneOf('pending')).toBe('new');
    expect(Bar.laneOf('pos_error')).toBe('new');
    expect(Bar.laneOf('confirmed')).toBe('prep');
    expect(Bar.laneOf('preparing')).toBe('prep');
    expect(Bar.laneOf('ready')).toBe('ready');
  });

  it('lo entregado y lo cancelado sale de la pantalla', () => {
    expect(Bar.laneOf('delivered')).toBe(null);
    expect(Bar.laneOf('cancelled')).toBe(null);
    expect(Bar.isClosed('delivered')).toBe(true);
    expect(Bar.isClosed('cancelled')).toBe(true);
    expect(Bar.isClosed('preparing')).toBe(false);
  });

  it('un estado que la app no conoce no se cuela a un carril', () => {
    // Si el servidor agrega un estado, es mejor que no aparezca a que aparezca en el
    // carril equivocado con un botón que lo rompa.
    expect(Bar.laneOf('refunded')).toBe(null);
  });
});

// ---------------------------------------------------------------- botones

describe('El botón que se ofrece', () => {
  it('cada estado ofrece exactamente la transición que el servidor permite', () => {
    // Espejo de TRANSITIONS en server/src/routes/orders.js.
    expect(Bar.nextAction('pending').status).toBe('confirmed');
    expect(Bar.nextAction('confirmed').status).toBe('preparing');
    expect(Bar.nextAction('preparing').status).toBe('ready');
    expect(Bar.nextAction('ready').status).toBe('delivered');
    expect(Bar.nextAction('pos_error').status).toBe('confirmed');
  });

  it('nunca se salta un estado: no hay atajo de pendiente a listo', () => {
    // Encadenar dos llamadas en un toque deja el pedido en un limbo si la segunda falla.
    expect(Bar.nextAction('pending').status).not.toBe('ready');
    expect(Bar.nextAction('confirmed').status).not.toBe('ready');
  });

  it('un pedido entregado ya no ofrece nada', () => {
    expect(Bar.nextAction('delivered')).toBe(null);
    expect(Bar.nextAction('cancelled')).toBe(null);
  });

  it('cancelar solo mientras no se haya servido', () => {
    expect(Bar.canCancel('pending')).toBe(true);
    expect(Bar.canCancel('preparing')).toBe(true);
    expect(Bar.canCancel('pos_error')).toBe(true);
    // Ya está en la charola: cancelarlo es un problema de caja, no de la barra.
    expect(Bar.canCancel('ready')).toBe(false);
    expect(Bar.canCancel('delivered')).toBe(false);
  });
});

// ---------------------------------------------------------------- espera

describe('Cuánto lleva esperando', () => {
  it('se cuenta desde que el cliente lo pidió, no desde el último cambio', () => {
    const o = order({ created_at: agoMinutes(7), confirmed_at: agoMinutes(1) });
    expect(Bar.waitMinutes(o, NOW)).toBe(7);
  });

  it('un pedido recién entrado es 0, no un número negativo', () => {
    expect(Bar.waitMinutes(order({ created_at: new Date(NOW + 2000).toISOString() }), NOW)).toBe(0);
  });

  it('una fecha inservible no imprime NaN', () => {
    expect(Bar.waitMinutes(order({ created_at: 'ayer' }), NOW)).toBe(null);
    expect(Bar.waitMinutes(order({ created_at: null }), NOW)).toBe(null);
  });

  it('el color avisa antes de que el cliente reclame', () => {
    expect(Bar.urgency(0)).toBe('ok');
    expect(Bar.urgency(4)).toBe('ok');
    expect(Bar.urgency(5)).toBe('warn');
    expect(Bar.urgency(9)).toBe('warn');
    expect(Bar.urgency(10)).toBe('late');
    expect(Bar.urgency(40)).toBe('late');
  });

  it('sin fecha el color no grita', () => {
    expect(Bar.urgency(null)).toBe('ok');
  });

  it('la espera más larga ignora lo que ya está listo en la charola', () => {
    const orders = [
      order({ id: 'a', status: 'preparing', created_at: agoMinutes(6) }),
      // Este lleva media hora pero ya está servido: no es la barra la que va atrasada.
      order({ id: 'b', status: 'ready', created_at: agoMinutes(30) }),
    ];
    expect(Bar.oldestWait(orders, NOW)).toBe(6);
  });

  it('sin pedidos abiertos no hay espera', () => {
    expect(Bar.oldestWait([], NOW)).toBe(null);
    expect(Bar.oldestWait([order({ status: 'delivered' })], NOW)).toBe(null);
  });
});

// ---------------------------------------------------------------- orden

describe('El orden dentro del carril', () => {
  it('el más viejo va arriba: es la regla de la barra, no una preferencia', () => {
    const lanes = Bar.groupByLane([
      order({ id: 'nuevo', created_at: agoMinutes(1) }),
      order({ id: 'viejo', created_at: agoMinutes(12) }),
      order({ id: 'medio', created_at: agoMinutes(6) }),
    ]);
    expect(lanes.new.map((o) => o.id)).toEqual(['viejo', 'medio', 'nuevo']);
  });

  it('confirmado y preparando comparten carril, y el viejo sigue arriba', () => {
    const lanes = Bar.groupByLane([
      order({ id: 'prep', status: 'preparing', created_at: agoMinutes(2) }),
      order({ id: 'conf', status: 'confirmed', created_at: agoMinutes(9) }),
    ]);
    expect(lanes.prep.map((o) => o.id)).toEqual(['conf', 'prep']);
  });

  it('un pedido sin fecha va al final, no al principio', () => {
    const lanes = Bar.groupByLane([
      order({ id: 'roto', created_at: null }),
      order({ id: 'bueno', created_at: agoMinutes(3) }),
    ]);
    expect(lanes.new.map((o) => o.id)).toEqual(['bueno', 'roto']);
  });

  it('los carriles existen aunque estén vacíos', () => {
    const lanes = Bar.groupByLane([]);
    expect(lanes).toEqual({ new: [], prep: [], ready: [] });
    expect(Bar.groupByLane(undefined).new).toEqual([]);
  });

  it('los conteos del encabezado cuadran con los carriles', () => {
    const orders = [
      order({ id: 'a', status: 'pending' }),
      order({ id: 'b', status: 'confirmed' }),
      order({ id: 'c', status: 'preparing' }),
      order({ id: 'd', status: 'ready' }),
      order({ id: 'e', status: 'delivered' }),
    ];
    expect(Bar.counts(orders)).toEqual({ new: 1, prep: 2, ready: 1, total: 4 });
  });
});

// ---------------------------------------------------------------- qué preparar

describe('Lo que el bartender tiene que leer', () => {
  it('resume los tragos en una línea', () => {
    const o = order({
      items: [{ name: 'Corona', quantity: 2 }, { name: 'Margarita', quantity: 1 }],
    });
    expect(Bar.itemsSummary(o)).toBe('2× Corona, 1× Margarita');
  });

  it('cuenta los tragos totales: doce no es "un pedido", es una ronda', () => {
    const o = order({ items: [{ name: 'Corona', quantity: 8 }, { name: 'Shot', quantity: 4 }] });
    expect(Bar.itemCount(o)).toBe(12);
  });

  it('un pedido sin partidas no revienta la tarjeta', () => {
    expect(Bar.itemsSummary(order({ items: [] }))).toBe('');
    expect(Bar.itemCount(order({ items: null }))).toBe(0);
    expect(Bar.itemsSummary(null)).toBe('');
  });

  it('el destino es el código de la mesa, y null si el pedido no tiene mesa', () => {
    expect(Bar.destination(order())).toBe('39');
    expect(Bar.destination(order({ table_code: null }))).toBe(null);
  });
});

// ---------------------------------------------------------------- eventos

describe('Qué hace un evento con la cola', () => {
  it('un pedido que avanza se mueve de carril sin perder lo que ya sabíamos', () => {
    const orders = [order({ id: 'o1', status: 'pending' })];
    const change = Bar.applyEvent(orders, {
      type: 'event', event_type: 'order_preparing', payload: { order_id: 'o1', status: 'preparing' },
    });
    expect(change).toMatchObject({ changed: true, moved: 'o1', lane: 'prep' });
    expect(orders[0].status).toBe('preparing');
    // El evento no trae las bebidas: no deben borrarse al aplicarlo.
    expect(orders[0].items).toHaveLength(1);
    expect(orders[0].table_code).toBe('39');
  });

  it('un pedido entregado sale de la lista', () => {
    const orders = [order({ id: 'o1', status: 'ready' })];
    const change = Bar.applyEvent(orders, {
      type: 'event', event_type: 'order_delivered', payload: { order_id: 'o1', status: 'delivered' },
    });
    expect(change).toMatchObject({ changed: true, removed: 'o1' });
    expect(orders).toHaveLength(0);
  });

  it('un pedido nuevo se pide al servidor en vez de inventarlo con el evento', () => {
    // El mensaje trae id y estado, no la mesa ni las bebidas: construirlo desde ahí
    // pintaría una tarjeta vacía.
    const orders = [];
    const change = Bar.applyEvent(orders, {
      type: 'event', event_type: 'order_created', payload: { order_id: 'nuevo', table_id: 'tbl' },
    });
    expect(change).toMatchObject({ changed: true, fetch: 'nuevo' });
    expect(orders).toHaveLength(0);
  });

  it('deduce el estado del tipo cuando el mensaje no lo trae', () => {
    const orders = [order({ id: 'o1', status: 'preparing' })];
    Bar.applyEvent(orders, { type: 'event', event_type: 'order_ready', payload: { order_id: 'o1' } });
    expect(orders[0].status).toBe('ready');
  });

  it('un pedido que se cerró en otra pantalla no se trae de vuelta', () => {
    // Sin esto, cada "entregado" de un pedido que ya no teníamos dispararía una
    // petición inútil por cada bartender conectado.
    const orders = [];
    expect(Bar.applyEvent(orders, {
      type: 'event', event_type: 'order_delivered', payload: { order_id: 'x', status: 'delivered' },
    })).toEqual({ changed: false });
  });

  it('lee el tipo de `event_type`, que es donde viaja de verdad', () => {
    // El servidor manda { type: 'event', event_type: 'order_ready', payload }. Leer
    // `type` deja la cola congelada: la pantalla se ve conectada y no se entera de nada.
    const orders = [order({ id: 'o1', status: 'preparing' })];
    const real = { type: 'event', event_type: 'order_ready', payload: { order_id: 'o1' } };
    expect(Bar.applyEvent(orders, real).changed).toBe(true);
    expect(orders[0].status).toBe('ready');
  });

  it('los eventos que no son de pedidos no tocan la cola', () => {
    const orders = [order()];
    for (const eventType of ['table_updated', 'flirt_received', 'taxi_requested', undefined]) {
      expect(Bar.applyEvent(orders, { type: 'event', event_type: eventType, payload: { order_id: 'o1' } })
        .changed).toBe(false);
    }
    expect(Bar.applyEvent(orders, null).changed).toBe(false);
  });

  it('un evento sin id de pedido se ignora en vez de romper la pantalla', () => {
    expect(Bar.applyEvent([order()], { type: 'event', event_type: 'order_ready', payload: {} })
      .changed).toBe(false);
    expect(Bar.applyEvent([order()], { type: 'event', event_type: 'order_ready' }).changed).toBe(false);
  });

  it('el mismo evento dos veces deja la cola igual', () => {
    // El socket reproduce lo que uno se perdió al reconectar: llega repetido a propósito.
    const orders = [order({ id: 'o1', status: 'pending' })];
    const message = {
      type: 'event', event_type: 'order_confirmed',
      payload: { order_id: 'o1', status: 'confirmed' },
    };
    Bar.applyEvent(orders, message);
    Bar.applyEvent(orders, message);
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('confirmed');
  });
});

// ---------------------------------------------------------------- el rol

describe('Quién abre la pantalla de la barra', () => {
  // eslint-disable-next-line global-require
  const Roles = require('../../web/js/roles.js');

  it('el bartender ya se redirige a su pantalla al entrar', () => {
    expect(Roles.route('bartender', '/index.html')).toMatchObject({
      action: 'redirect', to: 'bartender.html',
    });
  });

  it('y estando ya en ella, se queda', () => {
    expect(Roles.route('bartender', '/bartender.html').action).toBe('stay');
  });

  it('el invitado no se queda en la pantalla de la barra', () => {
    expect(Roles.route('guest', '/bartender.html')).toMatchObject({
      action: 'redirect', to: 'index.html',
    });
  });
});
