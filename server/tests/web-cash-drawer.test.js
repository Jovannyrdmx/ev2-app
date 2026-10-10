/**
 * El cambio que ve la anfitriona mientras cuenta el dinero (D96) tiene que dar lo
 * mismo que decide el servidor: mismos casos que `cash-drawer.test.js`.
 */
'use strict';

const D = require('../../web/js/cash-drawer');

describe('EV2Drawer.change', () => {
  it('pesos: cambio exacto', () => {
    expect(D.change({ total: 300, mxn: 500 })).toMatchObject({ ok: true, change: '200.00' });
  });

  it('dólares y pesos: lo de dólares baja al peso, los pesos vuelven completos', () => {
    expect(D.change({ total: 300, usd: 20, mxn: 100, rate: 17.35 })).toMatchObject({ ok: true, change: '147.00' });
    expect(D.change({ total: 300, usd: 10, mxn: 200, rate: 17.35 })).toMatchObject({ ok: true, change: '73.50' });
    expect(D.change({ total: 300, usd: 18, rate: 17.35 })).toMatchObject({ ok: true, change: '12.00' });
  });

  it('dice cuánto falta', () => {
    expect(D.change({ total: 300, mxn: 250 })).toMatchObject({ ok: false, missing: '50.00' });
    expect(D.change({ total: 300, usd: 10, rate: 17.35 })).toMatchObject({ ok: false, missing: '126.50' });
  });

  it('sin nada capturado no enseña nada; dólares sin tipo de cambio lo pide', () => {
    expect(D.change({ total: 300 })).toEqual({ ready: false });
    expect(D.change({ total: 300, usd: 10 })).toEqual({ ready: false, needsRate: true });
  });
});

describe('EV2Drawer.tenderPayload', () => {
  it('solo agrega lo recibido a un cobro en efectivo', () => {
    expect(D.tenderPayload({ payment_method: 'cash' }, { mxn: '500', usd: '', rateId: 7 }))
      .toEqual({ payment_method: 'cash', cash_received: 500 });
    expect(D.tenderPayload({ payment_method: 'cash' }, { mxn: '', usd: '20', rateId: 7 }))
      .toEqual({ payment_method: 'cash', usd_received: 20, exchange_rate_id: '7' });
    expect(D.tenderPayload({ payment_method: 'card' }, { mxn: '500' })).toEqual({ payment_method: 'card' });
  });
});

describe('Avisos del cajón', () => {
  it('solo avisa cuando el cajón NO se va a abrir', () => {
    expect(D.notice({ status: 'queued' })).toBeNull();
    expect(D.notice({ status: 'no_drawer' })).toBeNull();
    expect(D.notice({ status: 'failed' })).toMatchObject({ key: 'drawer.failed' });
  });

  it('el aviso en vivo es solo para el cajón', () => {
    expect(D.failedEvent({ type: 'print_job_failed', payload: { kind: 'drawer', error: 'sin papel' } }))
      .toMatchObject({ key: 'drawer.notOpened', vars: { error: 'sin papel' } });
    expect(D.failedEvent({ type: 'print_job_failed', payload: { kind: 'receipt' } })).toBeNull();
  });
});
