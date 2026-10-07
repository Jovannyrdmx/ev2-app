// Las piezas del checador de huella que no necesitan base ni comparador (D94).
'use strict';

const fp = require('../src/services/fingerprints');

describe('configuración', () => {
  const completa = {
    FINGERPRINT_KEY: 'k'.repeat(32), MATCHER_URL: 'http://matcher:8090', MATCHER_TOKEN: 't'.repeat(32),
  };

  it('dice qué falta, de una en una', () => {
    expect(fp.configProblem({})).toMatch(/FINGERPRINT_KEY/);
    expect(fp.configProblem({ ...completa, FINGERPRINT_KEY: 'corta' })).toMatch(/FINGERPRINT_KEY/);
    expect(fp.configProblem({ ...completa, MATCHER_URL: '' })).toMatch(/MATCHER_URL/);
    expect(fp.configProblem({ ...completa, MATCHER_TOKEN: 'corto' })).toMatch(/MATCHER_TOKEN/);
    expect(fp.configProblem(completa)).toBeNull();
  });

  const conEnv = (vars, fn) => {
    const antes = { ...process.env };
    Object.assign(process.env, vars);
    try { return fn(); } finally {
      for (const k of Object.keys(vars)) {
        if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k];
      }
    }
  };

  it('umbral de SourceAFIS: 40 por omisión, ajustable pero no absurdo', () => {
    expect(conEnv({}, fp.threshold)).toBe(40);
    expect(conEnv({ FINGERPRINT_THRESHOLD: '60' }, fp.threshold)).toBe(60);
    // Un umbral bajísimo dejaría marcar a cualquiera por cualquiera.
    expect(conEnv({ FINGERPRINT_THRESHOLD: '3' }, fp.threshold)).toBe(40);
    expect(conEnv({ FINGERPRINT_THRESHOLD: 'abc' }, fp.threshold)).toBe(40);
  });

  it('resolución del DigitalPersona 4500: 512 dpi', () => {
    expect(conEnv({}, fp.dpi)).toBe(512);
    expect(conEnv({ FINGERPRINT_DPI: '500' }, fp.dpi)).toBe(500);
    expect(conEnv({ FINGERPRINT_DPI: '50' }, fp.dpi)).toBe(512);
  });
});

describe('la imagen como llega del navegador', () => {
  const b64 = Buffer.from('imagen de prueba con relleno suficiente').toString('base64');

  it('acepta base64, base64url y el prefijo data:', () => {
    const url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(fp.cleanImage(b64)).toBe(b64);
    expect(fp.cleanImage(url)).toBe(b64);
    expect(fp.cleanImage(`data:image/png;base64,${b64}`)).toBe(b64);
  });

  it('rechaza lo que no es base64, y lo demasiado grande', () => {
    expect(() => fp.cleanImage('<script>')).toThrow(/no es válida/);
    expect(() => fp.cleanImage('')).toThrow(/no es válida/);
    expect(() => fp.cleanImage('A'.repeat(500 * 1024))).toThrow(/no es válida/);
  });
});

describe('agrupar puntajes por persona', () => {
  const candidatos = [
    { id: 'f1:0', userId: 'juan' }, { id: 'f1:1', userId: 'juan' }, { id: 'f2:0', userId: 'juan' },
    { id: 'f3:0', userId: 'ana' },
  ];

  it('se queda con el mejor de cada quien, el más alto primero', () => {
    const top = [
      { id: 'f1:0', score: 80 }, { id: 'f1:1', score: 95 }, { id: 'f3:0', score: 12 }, { id: 'f2:0', score: 40 },
    ];
    expect(fp.bestByUser(top, candidatos)).toEqual([
      { userId: 'juan', score: 95 }, { userId: 'ana', score: 12 },
    ]);
  });

  it('ignora ids que no mandó (el comparador no inventa personas)', () => {
    expect(fp.bestByUser([{ id: 'otro:0', score: 99 }], candidatos)).toEqual([]);
    expect(fp.bestByUser(undefined, candidatos)).toEqual([]);
  });
});

describe('la pantalla del checador (web/js/checador.js)', () => {
  const Clock = require('../../web/js/checador.js');

  it('la muestra de HID llega en base64url, a veces dentro de un objeto', () => {
    expect(Clock.sampleToBase64('ab-_cd')).toBe('ab+/cd==');
    expect(Clock.sampleToBase64({ Data: 'ab-_' })).toBe('ab+/');
    expect(Clock.sampleToBase64(null)).toBe('');
  });

  it('entrada en verde, salida en azul, repetida sin alarma', () => {
    expect(Clock.punchView({ kind: 'in', user: { name: 'Juan' }, at: 'x' }))
      .toEqual({ tone: 'in', titleKey: 'clk.in', name: 'Juan', at: 'x' });
    expect(Clock.punchView({ kind: 'out', user: { name: 'Juan' } }).titleKey).toBe('clk.out');
    expect(Clock.punchView({ kind: 'in', repeated: true }).tone).toBe('repeat');
    expect(Clock.punchView({ kind: 'out', repeated: true }).titleKey).toBe('clk.repeatOut');
  });

  it('los errores: el del dedo se repite, el del corte bloquea, el de la PC la desempareja', () => {
    expect(Clock.errorView({ status: 404, message: 'No te reconocí' }))
      .toEqual({ tone: 'retry', message: 'No te reconocí' });
    expect(Clock.errorView({ status: 422, message: 'Haz tu corte primero' }).tone).toBe('blocked');
    expect(Clock.errorView({ status: 401 })).toMatchObject({ unpaired: true });
    expect(Clock.errorView({ status: 0 }).key).toBe('clk.offline');
    expect(Clock.errorView({ status: 503, message: 'Avisa al gerente' }).tone).toBe('error');
    expect(Clock.errorView({ status: 400, message: 'Validation failed' })).toEqual({ tone: 'error', key: 'clk.failed' });
  });

  it('cada dedo tiene su nombre en los dos idiomas', () => {
    const F = require('../../web/js/format.js');
    for (const finger of Clock.FINGERS) {
      expect(F.STRINGS.es[Clock.fingerKey(finger)]).toBeTruthy();
      expect(F.STRINGS.en[Clock.fingerKey(finger)]).toBeTruthy();
    }
    // Los mismos diez que acepta el servidor.
    expect([...Clock.FINGERS].sort()).toEqual([...fp.FINGERS].sort());
  });

  it('sin la librería de HID no truena: dice que falta el programa', async () => {
    const estados = [];
    const r = Clock.createReader({ onStatus: (s) => estados.push(s) });
    expect(await r.start()).toBe(false);
    expect(estados).toEqual(['no-agent']);
  });
});
