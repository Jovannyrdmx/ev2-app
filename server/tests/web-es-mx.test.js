'use strict';

const fs = require('fs');
const path = require('path');
const F = require('../../web/js/format');

beforeEach(() => F.setLanguage('es'));

describe('Español mexicano claro y consistente', () => {
  test('conserva todas las variables de las traducciones en ambos idiomas', () => {
    const vars = value => [...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    const differences = Object.keys(F.STRINGS.es)
      .filter(key => JSON.stringify(vars(F.STRINGS.es[key])) !== JSON.stringify(vars(F.STRINGS.en[key])));
    expect(differences).toEqual([]);
  });

  test('no hay claves repetidas que sobrescriban textos de otro contexto', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../web/js/format.js'), 'utf8');
    const main = src.split('const STRINGS = {')[1].split('const UX = {')[0];
    for (const locale of main.split(/\n    (?:es|en): \{/).slice(1)) {
      const keys = [...locale.matchAll(/^      '([^']+)':/gm)].map(m => m[1]);
      expect(keys.length).toBe(new Set(keys).size);
    }
  });

  test('el corte de la noche y el corte de turno tienen títulos independientes', () => {
    expect(F.t('nightCut.title')).toBe('Corte de la noche');
    expect(F.t('cut.title')).toBe('Mi corte del turno');
    expect(F.locale()).toBe('es-MX');
  });

  test('traduce categorías conocidas y conserva nombres personalizados', () => {
    expect(F.categoryLabel('beer')).toBe('Cervezas');
    expect(F.categoryLabel('cocktails')).toBe('Cocteles');
    expect(F.categoryLabel('Especiales Clandestinoz')).toBe('Especiales Clandestinoz');
    expect(F.categoryLabel(null)).toBe('');
    F.setLanguage('en');
    expect(F.categoryLabel('beer')).toBe('Beer');
    expect(F.categoryLabel('Especiales Clandestinoz')).toBe('Especiales Clandestinoz');
  });

  test.each([
    ['Employee profile not found', /perfil del empleado/],
    ['Table is full', /lugares disponibles/],
    ['Some drinks are not available', /bebidas.*disponibles/],
    ['Validation failed', /Revisa los datos/],
    ['Internal server error', /No pudimos confirmar/],
  ])('no muestra en inglés el error conocido: %s', (message, expected) => {
    expect(F.errorMessage({ code: 'unprocessable', message })).toMatch(expected);
  });

  test('no expone detalles técnicos, pero conserva los mensajes operativos en español', () => {
    expect(F.errorMessage({ status: 500, code: 'internal', message: 'database secret details' }))
      .not.toContain('database');
    expect(F.errorMessage({ code: 'conflict', message: 'Ya tienes una solicitud abierta' }))
      .toBe('Ya tienes una solicitud abierta');
    expect(F.errorMessage({ status: 401 }, { context: 'login' })).toBe(F.t('error.badLogin'));
    expect(F.errorMessage({ status: 401 }, { context: 'pin' })).toBe(F.t('error.badPin'));
  });

  test('los mensajes no confunden registrar un pedido con confirmar su pago', () => {
    expect(F.t('orders.sent')).toMatch(/Falta confirmar el pago/);
    expect(F.t('orders.awaitingPayment')).toMatch(/Pago pendiente/);
    expect(F.t('auth.adults')).toContain('18 años o más');
    expect(F.t('wh.noCatalogHelp')).not.toMatch(/npm|seed/i);
    expect(F.t('order.reprintOk')).toMatch(/enviadas/);
    expect(F.t('order.reprintOk')).not.toMatch(/impresas/);
    expect(F.tf('wh.entryLines', { n: 1 })).toBe('Renglones: 1');
  });
});
