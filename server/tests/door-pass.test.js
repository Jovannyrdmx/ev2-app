/**
 * El pase de la puerta: cómo se genera, cómo se lee y cuándo abre.
 *
 * Esto se usa con una fila esperando, música a todo volumen y un teléfono con la
 * pantalla estrellada. Cada decisión de aquí es para que esa fila no se detenga —
 * y para que un pase no abra dos veces ni abra el que no es.
 */
'use strict';

const door = require('../src/services/door');

describe('el código del pase', () => {
  it('tiene la forma que se dicta en voz alta: EV2-XXXX-XXXX', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(door.generatePassCode()).toMatch(/^EV2-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    }
  });

  it('no usa las letras que se confunden al dictarlas', () => {
    // Sin O ni 0, sin I ni L ni 1. En una puerta con música, "EV2-1L..." se
    // escucha igual de cinco maneras distintas.
    for (const prohibida of ['O', '0', 'I', 'L', '1']) {
      expect(door.ALPHABET).not.toContain(prohibida);
    }
    const muchos = Array.from({ length: 200 }, () => door.generatePassCode()).join('');
    expect(muchos).not.toMatch(/[OIL01]/);
  });

  it('no se repite: dos reservaciones con el mismo código sentarían a quien no es', () => {
    const vistos = new Set(Array.from({ length: 2000 }, () => door.generatePassCode()));
    expect(vistos.size).toBe(2000);
  });
});

describe('leer lo que la puerta teclea o escanea', () => {
  it('acepta minúsculas, espacios y guiones de más', () => {
    expect(door.normalizePassCode(' ev2 4k7m 2p4x ')).toBe('EV2-4K7M-2P4X');
    expect(door.normalizePassCode('EV24K7M2P4X')).toBe('EV2-4K7M-2P4X');
  });

  it('un QR puede traer una dirección completa y se saca el código', () => {
    expect(door.passFromScan('https://ev2clandestinoz.com/pase/EV2-4K7M-2P4X')).toBe('EV2-4K7M-2P4X');
    expect(door.passFromScan('EV2-4K7M-2P4X')).toBe('EV2-4K7M-2P4X');
  });

  it('NO adivina letras parecidas', () => {
    // La tentación es convertir la O en cero. Pero el alfabeto no tiene ninguna de
    // las dos: una O tecleada significa que se leyó mal una D o una Q, y adivinar
    // cuál convertiría un código inválido en el pase de otra persona.
    expect(door.passFromScan('ev2-4k7m-2p4o')).toBe('EV2-4K7M-2P4O');
  });

  it('lo vacío no revienta', () => {
    expect(door.normalizePassCode(null)).toBe('');
    expect(door.passFromScan(undefined)).toBe('');
  });
});

describe('cuándo abre un pase', () => {
  const ahora = new Date('2026-09-12T23:30:00Z');
  const viva = {
    status: 'confirmed',
    starts_at: '2026-09-12T23:00:00Z',
    ends_at: '2026-09-13T05:00:00Z',
  };

  it('una reservación confirmada, en su horario, abre', () => {
    expect(door.checkPass(viva, { now: ahora })).toEqual({ status: 'ok', ok: true });
  });

  it('un código que no existe no abre, y lo dice sin ambigüedad', () => {
    expect(door.checkPass(null)).toEqual({ status: 'not_found', ok: false });
  });

  it('un pase ya usado no vuelve a abrir', () => {
    // Es lo que impide que el mismo QR, reenviado por WhatsApp, meta a dos grupos.
    const usada = { ...viva, status: 'seated', checked_in_at: '2026-09-12T23:10:00Z' };
    const r = door.checkPass(usada, { now: ahora });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('already_in');
    expect(r.at).toBe('2026-09-12T23:10:00Z');
  });

  it('una cancelada no abre', () => {
    expect(door.checkPass({ ...viva, status: 'cancelled' }, { now: ahora }).status).toBe('cancelled');
    expect(door.checkPass({ ...viva, status: 'no_show' }, { now: ahora }).status).toBe('cancelled');
  });

  it('una que no se ha pagado no abre, y se distingue de una cancelada', () => {
    // La puerta tiene que poder decir "te falta el depósito", que se arregla ahí
    // mismo, en vez de "está cancelada", que manda a la persona a su casa.
    expect(door.checkPass({ ...viva, status: 'pending_payment' }, { now: ahora }).status).toBe('unpaid');
  });

  it('la de mañana no abre hoy', () => {
    const manana = {
      status: 'confirmed',
      starts_at: '2026-09-13T23:00:00Z',
      ends_at: '2026-09-14T05:00:00Z',
    };
    const r = door.checkPass(manana, { now: ahora });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('not_tonight');
    expect(r.starts_at).toBe('2026-09-13T23:00:00Z');
  });

  it('llegar temprano SÍ abre: rebotar a alguien por veinte minutos es una pelea', () => {
    const temprano = new Date('2026-09-12T22:15:00Z'); // 45 min antes
    expect(door.checkPass(viva, { now: temprano }).ok).toBe(true);
  });

  it('pero no tres horas antes', () => {
    const muyTemprano = new Date('2026-09-12T19:00:00Z');
    expect(door.checkPass(viva, { now: muyTemprano }).status).toBe('not_tonight');
  });

  it('ya cerrado el club, tampoco', () => {
    expect(door.checkPass(viva, { now: new Date('2026-09-13T06:00:00Z') }).status).toBe('not_tonight');
  });
});

describe('cuánta gente suma una reservación', () => {
  it('los que reservó más los extras que compró en la puerta', () => {
    expect(door.headcount({ guest_count: 8 }, 2)).toBe(10);
  });

  it('sin extras, los que reservó', () => {
    expect(door.headcount({ guest_count: 6 })).toBe(6);
  });

  it('una reservación vacía no suma gente fantasma', () => {
    expect(door.headcount(null, 0)).toBe(0);
  });
});
