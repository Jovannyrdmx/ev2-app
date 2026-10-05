/**
 * Salida sin taxi en la web (D85): en qué va la salida del cliente, cómo se lee la
 * constancia a pie o con valet, y la página pública que la verifica.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const EV2Taxi = require('../../web/js/taxi-ride');

const WEB = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

const FUTURO = '2099-01-01T00:00:00Z';
const PASADO = '2000-01-01T00:00:00Z';

describe('departureStage', () => {
  it('sin salida, el cliente puede pedirla', () => {
    expect(EV2Taxi.departureStage(null)).toBe('none');
    expect(EV2Taxi.departureStage({ status: 'canceled' })).toBe('none');
  });

  it('pedida espera a la hostess; confirmada y vigente es constancia', () => {
    expect(EV2Taxi.departureStage({ status: 'requested' })).toBe('requested');
    expect(EV2Taxi.departureStage({ status: 'confirmed', expires_at: FUTURO })).toBe('confirmed');
  });

  it('una constancia vencida deja pedir otra', () => {
    expect(EV2Taxi.departureStage({ status: 'confirmed', expires_at: PASADO })).toBe('expired');
  });

  it('reconoce los eventos de salida y nada más', () => {
    expect(EV2Taxi.isDepartureEvent({ type: 'departure_confirmed' })).toBe(true);
    expect(EV2Taxi.isDepartureEvent({ event_type: 'departure_requested' })).toBe(true);
    expect(EV2Taxi.isDepartureEvent({ type: 'taxi_started' })).toBe(false);
    expect(EV2Taxi.isDepartureEvent(null)).toBe(false);
  });
});

describe('certificateView sin taxi', () => {
  it('a pie: dice "persona" y cómo salió, sin conductor ni placa', () => {
    const view = EV2Taxi.certificateView({
      folio: 'EV2-AAAA-BBBB', guest: 'Ana T.', driver: null, vehicle: null,
      mode: 'on_foot', expires_at: FUTURO, valid: true,
    });
    expect(view.rows).toEqual([
      { labelKey: 'cert.person', value: 'Ana T.' },
      { labelKey: 'cert.leftBy', valueKey: 'cert.mode_on_foot' },
    ]);
  });

  it('con valet: lleva la placa del auto entregado', () => {
    const view = EV2Taxi.certificateView({
      folio: 'EV2-AAAA-BBBB', guest: 'Ana T.', mode: 'valet', expires_at: FUTURO,
      vehicle: { plate: 'ABC-123', color: null, description: 'Sentra gris' },
    });
    expect(view.rows.map((r) => r.labelKey))
      .toEqual(['cert.person', 'cert.leftBy', 'cert.plate', 'cert.vehicle']);
  });

  it('la del taxi no cambia', () => {
    const view = EV2Taxi.certificateView({
      folio: 'EV2-AAAA-BBBB', guest: 'Ana T.', driver: 'Beto', mode: 'taxi', expires_at: FUTURO,
    });
    expect(view.rows).toEqual([
      { labelKey: 'cert.guest', value: 'Ana T.' },
      { labelKey: 'cert.driver', value: 'Beto' },
    ]);
  });
});

describe('verificar.html con una salida a pie', () => {
  it('enseña cómo salió, en palabras, y no habla de pasajero', async () => {
    const dom = new JSDOM(leer('verificar.html'), {
      runScripts: 'outside-only', pretendToBeVisual: true,
      url: 'https://ev2.local/verificar.html?folio=EV2-AAAA-BBBB',
    });
    const { window } = dom;
    window.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        certificate: {
          folio: 'EV2-AAAA-BBBB', nightclub: 'EV2 Clandestinoz', guest: 'Ana T.',
          driver: null, vehicle: null, mode: 'on_foot', valid: true,
          issued_at: '2026-10-05T07:00:00Z', expires_at: FUTURO,
          disclaimer: 'confirmado por personal del club',
        },
      }),
    });
    window.localStorage.setItem('ev2.lang', 'es');
    window.eval(leer('js/format.js'));
    window.eval(leer('js/taxi-ride.js'));
    window.eval(leer('js/verify-screen.js'));
    await new Promise((r) => setTimeout(r, 20));

    const text = window.document.getElementById('verify-rows').textContent;
    expect(text).toContain('A pie, confirmada en la puerta');
    expect(text).toContain('Persona');
    expect(text).not.toContain('Pasajero');
    expect(window.document.getElementById('verify-result').hidden).toBe(false);
    window.close();
  });
});
