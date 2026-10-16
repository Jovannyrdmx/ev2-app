/**
 * Servicio de botella (D117) del lado de las pantallas: el carrito lleva los
 * mezcladores, enseña el mismo extra que cobrará el servidor y los manda en el pedido.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const EV2Client = require('../../web/js/client.js');
const EV2OrderTaking = require('../../web/js/order-taking.js');

const read = (f) => fs.readFileSync(path.resolve(__dirname, '../../web', f), 'utf8');

const botella = { id: 'b1', name: 'BUCHANANS 12', price: '2650.00', currency: 'MXN', included_mixers: 2, stock: null };
const trago = { id: 't1', name: 'BUCHANANS 12 - SPRITE', price: '150.00', currency: 'MXN', included_mixers: null, stock: null };
const sprite = { mixer_id: 'm1', name: 'Sprite 3 L', extra_price: '120.00' };
const agua = { mixer_id: 'm2', name: 'Agua mineral 2 L', extra_price: '80.00' };

describe('la cuenta del extra', () => {
  test('dentro del tope no cuesta nada', () => {
    const r = EV2Client.mixerBreakdown(botella, 1, [{ ...sprite, quantity: 1 }, { ...agua, quantity: 1 }]);
    expect(r.extra).toBe('0.00');
  });

  test('se incluyen primero los más caros y se cobran los baratos (igual que el servidor)', () => {
    const r = EV2Client.mixerBreakdown(botella, 1, [{ ...agua, quantity: 1 }, { ...sprite, quantity: 2 }]);
    expect(r.extra).toBe('80.00');
    expect(r.lines.find((l) => l.name === 'Agua mineral 2 L')).toMatchObject({ included: 0, charged: 1 });
  });

  test('dos botellas incluyen el doble', () => {
    expect(EV2Client.mixerBreakdown(botella, 2, [{ ...sprite, quantity: 4 }]).extra).toBe('0.00');
  });

  test('solo las botellas con tope llevan servicio', () => {
    expect(EV2Client.hasMixerService(botella)).toBe(true);
    expect(EV2Client.hasMixerService(trago)).toBe(false);
  });
});

describe('el carrito', () => {
  test('suma el extra al total y manda los mezcladores en el pedido', () => {
    const cart = EV2Client.createCart();
    cart.add(botella);
    cart.setMixers('b1', [{ ...sprite, quantity: 2 }, { ...agua, quantity: 1 }]);
    expect(cart.total).toBe('2730.00');
    expect(cart.toOrderItems()).toEqual([{ drink_id: 'b1', quantity: 1,
      mixers: [{ mixer_id: 'm1', quantity: 2 }, { mixer_id: 'm2', quantity: 1 }] }]);
  });

  test('subir la cantidad conserva la elección y amplía lo incluido', () => {
    const cart = EV2Client.createCart();
    cart.add(botella);
    cart.setMixers('b1', [{ ...sprite, quantity: 3 }]);
    expect(cart.total).toBe('2770.00');
    cart.add(botella);
    expect(cart.mixersOf('b1')).toHaveLength(1);
    expect(cart.total).toBe('5300.00');
  });

  test('sin mezcladores el renglón sale como siempre', () => {
    const cart = EV2Client.createCart();
    cart.add(trago);
    expect(cart.toOrderItems()).toEqual([{ drink_id: 't1', quantity: 1 }]);
  });

  test('el mesero los manda en su pedido, sin precios', () => {
    const cart = EV2Client.createCart();
    cart.add(botella);
    cart.setMixers('b1', [{ ...sprite, quantity: 1 }]);
    const body = EV2OrderTaking.orderPayload({ tableId: 'mesa', cart: cart.lines, requestId: 'r' });
    expect(body.items[0].mixers).toEqual([{ mixer_id: 'm1', quantity: 1 }]);
    expect(JSON.stringify(body)).not.toMatch(/extra_price|120/);
  });
});

describe('las pantallas', () => {
  test('el cliente y el mesero cargan el selector; la app lo guarda sin señal', () => {
    expect(read('index.html')).toMatch(/js\/mixer-picker\.js/);
    expect(read('staff.html')).toMatch(/js\/mixer-picker\.js/);
    expect(read('sw.js')).toMatch(/'js\/mixer-picker\.js'/);
  });

  test('el gerente tiene la pestaña de servicio de botella', () => {
    expect(read('manager.html')).toMatch(/data-inv="service"/);
    expect(read('js/manager-screen.js')).toMatch(/renderBottleService/);
  });

  test('los textos existen en los dos idiomas', () => {
    const fmt = read('js/format.js');
    for (const key of ['mix.choose', 'mix.save', 'bs.tab', 'bs.includes']) {
      expect(fmt.split(`'${key}':`).length - 1).toBe(2);
    }
  });
});
