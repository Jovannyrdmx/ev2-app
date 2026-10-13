/**
 * El anticipo y el resto, del lado de las pantallas (D113).
 *
 * Lo que se prueba es lo que el cliente y la puerta leen: en qué va su anticipo,
 * cuánto le falta al llegar, el cambio del efectivo en centavos enteros, y que cada
 * id que buscan los scripts nuevos exista en su página (si no, el botón no hace nada
 * y nadie se entera hasta la noche del sábado).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'web');
const D = require(path.join(ROOT, 'js', 'deposit.js'));
const leer = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const info = (over = {}) => ({
  reservation: { status: 'pending_payment', currency: 'MXN' },
  total: '4000.00', deposit: '1200.00', paid: '0.00', due: '4000.00',
  deposit_status: 'pending', deposit_amount_due: '1200.00', last_proof: null, options: [],
  ...over,
});

describe('en qué va el anticipo', () => {
  it('pendiente, en revisión, confirmado y cerrado', () => {
    expect(D.stage(info())).toBe('pay');
    expect(D.stage(info({ deposit_status: 'pending_manual' }))).toBe('review');
    expect(D.stage(info({ deposit_status: 'paid', reservation: { status: 'confirmed' } }))).toBe('confirmed');
    expect(D.stage(info({ reservation: { status: 'cancelled' } }))).toBe('closed');
  });

  it('un rechazo se dice solo mientras haya que volver a pagar', () => {
    const rechazado = info({ last_proof: { status: 'rejected', rejection_reason: 'no llegó' } });
    expect(D.wasRejected(rechazado)).toBe(true);
    expect(D.wasRejected({ ...rechazado, deposit_status: 'pending_manual' })).toBe(false);
  });

  it('el resto al llegar descuenta el anticipo aunque todavía no esté confirmado', () => {
    expect(D.restAtDoor(info())).toBe('2800.00');
    expect(D.restAtDoor(info({ deposit_status: 'paid', paid: '1200.00', reservation: { status: 'confirmed' } })))
      .toBe('2800.00');
    expect(D.restAtDoor(info({ total: '1200.00' }))).toBe('0.00');
  });
});

describe('el comprobante antes de mandarlo', () => {
  const foto = { type: 'image/jpeg', size: 500_000 };
  it('pide escoger cuenta cuando hay cuentas, y el archivo', () => {
    expect(D.proofBlocker({ file: foto, optionId: null, options: [{ id: 'a' }] })).toBe('dpo.errPickAccount');
    expect(D.proofBlocker({ file: null, optionId: 'a', options: [{ id: 'a' }] })).toBe('dpo.errNoFile');
    expect(D.proofBlocker({ file: foto, optionId: 'a', options: [{ id: 'a' }] })).toBeNull();
  });
  it('rechaza lo que no es foto ni PDF y lo que pesa demasiado; deja pasar un tipo vacío', () => {
    expect(D.proofBlocker({ file: { type: 'text/html', size: 10 }, optionId: null, options: [] })).toBe('dpo.errType');
    expect(D.proofBlocker({ file: { type: 'image/png', size: 11 * 1024 * 1024 }, optionId: null, options: [] }))
      .toBe('dpo.errSize');
    expect(D.proofBlocker({ file: { type: '', size: 10 }, optionId: null, options: [] })).toBeNull();
    expect(D.proofBlocker({ file: { type: 'application/pdf', size: 10 }, optionId: null, options: [] })).toBeNull();
  });
});

describe('el cambio del resto en efectivo', () => {
  it('en centavos enteros, exacto si no se captura nada', () => {
    expect(D.cashChange('2800.00', '3000')).toEqual({ ok: true, change: '200.00', missing: '0.00' });
    expect(D.cashChange('2800.00', '')).toEqual({ ok: true, change: '0.00', missing: '0.00' });
    expect(D.cashChange('0.30', '0.10')).toEqual({ ok: false, change: '0.00', missing: '0.20' });
    expect(D.cashChange('100', 'abc').ok).toBe(false);
  });
  it('un rechazo de comprobante necesita motivo', () => {
    expect(D.rejectBlocker('no')).toBe('dpo.errReason');
    expect(D.rejectBlocker('No aparece en el banco')).toBeNull();
  });
});

describe('cada id que buscan los scripts existe en su página', () => {
  const idsDe = (js) => [...new Set([...js.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]))];

  it('la página del anticipo (index.html)', () => {
    const html = leer('index.html');
    for (const id of idsDe(leer('js/deposit-screen.js'))) {
      expect(html.includes(`id="${id}"`)).toBe(true);
    }
    expect(html.indexOf('js/deposit.js')).toBeLessThan(html.indexOf('js/deposit-screen.js'));
  });

  it('la puerta (staff.html) tiene el cuadro del resto y la cola', () => {
    const html = leer('staff.html');
    for (const id of ['scan-balance', 'scan-balance-amount', 'scan-balance-cash', 'scan-balance-change',
      'btn-balance-cash', 'btn-balance-card', 'scan-balance-error', 'btn-scan-deposit', 'depr-card', 'depr-list']) {
      expect(html.includes(`id="${id}"`)).toBe(true);
    }
    expect(html.indexOf('js/deposit-review.js')).toBeLessThan(html.indexOf('js/staff-screen.js'));
  });

  it('el panel (manager.html) tiene la cola y las cuentas', () => {
    const html = leer('manager.html');
    for (const id of ['depq-list', 'btn-depq-refresh', 'mpo-list', 'mpo-method', 'mpo-label',
      'mpo-destination', 'mpo-instructions', 'mpo-error', 'btn-mpo-add']) {
      expect(html.includes(`id="${id}"`)).toBe(true);
    }
  });

  it('cada texto nuevo existe en español y en inglés', () => {
    const fmt = leer('js/format.js');
    const usados = new Set();
    for (const f of ['js/deposit.js', 'js/deposit-review.js', 'js/deposit-screen.js', 'index.html',
      'staff.html', 'manager.html', 'js/staff-screen.js', 'js/manager-screen.js', 'js/booking-screen.js']) {
      for (const m of leer(f).matchAll(/['"`]((?:dpo|mpo|bal)\.[A-Za-z_]+)['"`]/g)) usados.add(m[1]);
    }
    usados.add('scan.balanceDue');
    for (const k of ['dpo.m_spei', 'dpo.m_bank_transfer', 'dpo.m_zelle', 'dpo.m_cash_app', 'dpo.stage_pay',
      'dpo.stage_review', 'dpo.stage_confirmed', 'dpo.stage_closed']) usados.add(k);
    for (const k of usados) {
      expect([k, fmt.split(`'${k}':`).length - 1]).toEqual([k, 2]);
    }
  });
});
