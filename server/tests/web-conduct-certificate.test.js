/**
 * La constancia de salida y el código de conducta.
 *
 * Esto es lo único de toda la aplicación que alguien va a enseñarle a una autoridad en
 * la calle. Si la pantalla dice "vigente" sobre una constancia vencida, o enseña una
 * placa que no corresponde, el club queda respaldando algo falso — y esa es una clase
 * de error mucho peor que un pedido mal cobrado.
 */
'use strict';

const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'web', 'js');
const Taxi = require(path.join(WEB, 'taxi-ride.js'));

const AHORA = Date.parse('2026-09-06T05:00:00Z');
const CERT = {
  folio: 'EV2-K7M2-P4XQ',
  nightclub: 'EV2 Clandestinoz',
  issued_at: '2026-09-06T04:00:00Z',
  expires_at: '2026-09-06T10:00:00Z',
  valid: true,
  guest: 'Ana L.',
  driver: 'Beto',
  vehicle: { plate: 'ABC-123-D', color: 'gris', description: 'Nissan Versa' },
  disclaimer: 'Acredita únicamente la salida del establecimiento.',
};

describe('la constancia en pantalla', () => {
  it('sin folio no hay constancia: se emite al arrancar el viaje, no al pedirlo', () => {
    expect(Taxi.certificateView(null)).toBeNull();
    expect(Taxi.certificateView({ folio: '' })).toBeNull();
  });

  it('enseña lo que se puede comparar con lo que se tiene enfrente, en ese orden', () => {
    const v = Taxi.certificateView(CERT, AHORA);
    expect(v.rows.map((r) => r.labelKey))
      .toEqual(['cert.guest', 'cert.driver', 'cert.plate', 'cert.vehicle']);
    expect(v.rows[2].value).toBe('ABC-123-D');
    expect(v.rows[3].value).toBe('gris Nissan Versa');
  });

  it('nunca inventa una fila que el servidor no mandó', () => {
    const v = Taxi.certificateView({ folio: 'X1', guest: 'Ana' }, AHORA);
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].labelKey).toBe('cert.guest');
  });

  it('un coche sin placa no finge tenerla', () => {
    const v = Taxi.certificateView({ ...CERT, vehicle: { color: 'gris' } }, AHORA);
    expect(v.rows.some((r) => r.labelKey === 'cert.plate')).toBe(false);
    expect(v.rows.find((r) => r.labelKey === 'cert.vehicle').value).toBe('gris');
  });

  it('vigente mientras no venza', () => {
    const v = Taxi.certificateView(CERT, AHORA);
    expect(v.valid).toBe(true);
    expect(v.expired).toBe(false);
  });

  it('vencida se dice vencida, con el reloj del teléfono y sin esperar a recargar', () => {
    // El servidor mandó valid:true hace una hora; ya no lo es. Enseñar "vigente" aquí
    // sería que el club respalde con su nombre algo que ya no sostiene.
    const v = Taxi.certificateView(CERT, Date.parse('2026-09-06T11:00:00Z'));
    expect(v.expired).toBe(true);
    expect(v.valid).toBe(false);
  });

  it('si el servidor la declara inválida, no se enseña como buena', () => {
    const v = Taxi.certificateView({ ...CERT, valid: false }, AHORA);
    expect(v.valid).toBe(false);
  });

  it('el descargo viaja tal cual: no se resume ni se recorta', () => {
    expect(Taxi.certificateView(CERT, AHORA).disclaimer).toBe(CERT.disclaimer);
  });
});

describe('el folio que alguien teclea de un papel', () => {
  it('se acepta en minúsculas y con espacios de sobra', () => {
    expect(Taxi.normalizeFolio('  ev2-k7m2 p4xq ')).toBe('EV2-K7M2P4XQ');
  });

  it('vacío o de dos letras no se manda al servidor', () => {
    expect(Taxi.folioLooksUsable('')).toBe(false);
    expect(Taxi.folioLooksUsable('ab')).toBe(false);
  });

  it('un folio de largo razonable sí', () => {
    expect(Taxi.folioLooksUsable('EV2-K7M2-P4XQ')).toBe(true);
  });

  it('algo absurdamente largo se corta aquí y no en la red', () => {
    expect(Taxi.folioLooksUsable('X'.repeat(50))).toBe(false);
  });
});

describe('el código de conducta', () => {
  it('un club sin reglas no molesta a nadie con una casilla', () => {
    expect(Taxi.conductTerms({ conduct_terms: null })).toBeNull();
    expect(Taxi.conductTerms({ conduct_terms: '   ' })).toBeNull();
    expect(Taxi.requestBlocker({ conduct_terms: null }, false)).toBeNull();
  });

  it('con reglas publicadas, no hay viaje sin aceptarlas', () => {
    expect(Taxi.requestBlocker({ conduct_terms: 'No fumar' }, false)).toBe('taxi.errConduct');
    expect(Taxi.requestBlocker({ conduct_terms: 'No fumar' }, undefined)).toBe('taxi.errConduct');
    expect(Taxi.requestBlocker({ conduct_terms: 'No fumar' }, true)).toBeNull();
  });

  it('solo `true` cuenta como aceptar: ni "on", ni 1, ni "sí"', () => {
    // La casilla de un formulario manda cosas raras. Aceptar por parecido sería
    // registrar un consentimiento que la persona no dio.
    for (const valor of ['on', 1, 'true', {}]) {
      expect(Taxi.requestBlocker({ conduct_terms: 'x' }, valor)).toBe('taxi.errConduct');
    }
  });

  it('con el servicio apagado no se pide nada, aunque se acepten las reglas', () => {
    expect(Taxi.requestBlocker({ enabled: false, conduct_terms: 'x' }, true)).toBe('taxi.errDisabled');
  });
});
