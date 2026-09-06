/**
 * Las decisiones de la pantalla "Conecta" y de la bandeja de moderación del gerente.
 *
 * Se prueban aquí porque son las únicas de toda la aplicación donde el error no cuesta
 * dinero: cuesta que alguien reciba algo que no quería recibir, o que una cuenta se
 * bloquee sin que nadie pueda explicar después por qué.
 */
'use strict';

const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'web', 'js');
const Flirt = require(path.join(WEB, 'flirt.js'));
const Manager = require(path.join(WEB, 'manager.js'));

const persona = (over) => ({
  id: 'p1', display_name: 'Ana', table_id: 't1', table_code: 'A3',
  section: 'Terraza', floor: 1, accept_flirts: true, ...over,
});
const miMesa = { id: 't9', code: 'B1' };

// --------------------------------------------------------------------- permisos propios

describe('los tres estados del permiso', () => {
  it('sin aceptar invitaciones, todo está apagado', () => {
    expect(Flirt.optInState({ accept_flirts: false, discoverable: true })).toBe('off');
  });

  it('aceptar sin aparecer es un estado válido: se puede mandar sin ser visto', () => {
    expect(Flirt.optInState({ accept_flirts: true, discoverable: false })).toBe('sending');
  });

  it('los dos encendidos es participar del todo', () => {
    expect(Flirt.optInState({ accept_flirts: true, discoverable: true })).toBe('full');
  });

  it('sin preferencias guardadas se asume apagado, nunca encendido', () => {
    expect(Flirt.optInState(null)).toBe('off');
    expect(Flirt.optInState({})).toBe('off');
  });
});

// --------------------------------------------------------------------- a quién se puede mandar

describe('a quién se le puede mandar', () => {
  it('sin mesa no se manda nada, y eso se dice antes que cualquier otra cosa', () => {
    // El orden importa: quien no se ha sentado no tiene que enterarse de nada sobre la
    // otra persona para saber qué le falta hacer.
    expect(Flirt.sendBlocker({ person: persona({ accept_flirts: false }), myTable: null }))
      .toBe('flirt.errNoTable');
  });

  it('a quien no acepta invitaciones no se le manda', () => {
    expect(Flirt.sendBlocker({ person: persona({ accept_flirts: false }), myTable: miMesa }))
      .toBe('flirt.errNotAccepting');
  });

  it('a quien ya se fue del club tampoco', () => {
    expect(Flirt.sendBlocker({ person: persona({ table_id: null }), myTable: miMesa }))
      .toBe('flirt.errLeft');
  });

  it('no se puede uno mandar a sí mismo', () => {
    expect(Flirt.sendBlocker({ me: { id: 'p1' }, person: persona(), myTable: miMesa }))
      .toBe('flirt.errSelf');
  });

  it('con todo en orden no hay impedimento', () => {
    expect(Flirt.sendBlocker({ me: { id: 'yo' }, person: persona(), myTable: miMesa })).toBeNull();
  });
});

describe('invitar un trago', () => {
  const menu = [
    { id: 'd1', name: 'Mezcal', available: true },
    { id: 'd2', name: 'Champaña', available: false },
  ];

  it('sin elegir qué invitar, no se manda', () => {
    expect(Flirt.giftBlocker(null, menu)).toBe('flirt.errNoDrink');
  });

  it('lo que se acabó no se ofrece: el servidor lo rechazaría después de cobrar', () => {
    expect(Flirt.giftBlocker('d2', menu)).toBe('flirt.errDrinkOut');
  });

  it('un trago que no está en el menú se trata como si no existiera', () => {
    expect(Flirt.giftBlocker('d99', menu)).toBe('flirt.errNoDrink');
  });

  it('con un trago disponible se puede', () => {
    expect(Flirt.giftBlocker('d1', menu)).toBeNull();
  });
});

// --------------------------------------------------------------------- lo que se manda

describe('lo que viaja al servidor', () => {
  it('una señal lleva emoji y nada de trago', () => {
    const body = Flirt.sendPayload(persona(), 'emoji', { clientRequestId: 'r1', emoji: 'fire' });
    expect(body).toEqual({
      client_request_id: 'r1', recipient_id: 'p1', type: 'emoji', emoji: 'fire',
    });
  });

  it('un emoji que el servidor no conoce se cambia por uno válido, no se manda tal cual', () => {
    const body = Flirt.sendPayload(persona(), 'emoji', { clientRequestId: 'r1', emoji: 'unicornio' });
    expect(Flirt.EMOJI_KEYS).toContain(body.emoji);
  });

  it('el mensaje se corta en 140: mandar 141 sería un 400 sin explicación', () => {
    const body = Flirt.sendPayload(persona(), 'meet', {
      clientRequestId: 'r1', message: 'x'.repeat(300),
    });
    expect(body.message).toHaveLength(140);
  });

  it('un mensaje en blanco no se manda como campo vacío', () => {
    const body = Flirt.sendPayload(persona(), 'meet', { clientRequestId: 'r1', message: '   ' });
    expect(body).not.toHaveProperty('message');
  });

  it('un trago lleva el id y la cantidad, acotada al tope del servidor', () => {
    const body = Flirt.sendPayload(persona(), 'drink', {
      clientRequestId: 'r1', drinkId: 'd1', quantity: 99,
    });
    expect(body.drink_id).toBe('d1');
    expect(body.quantity).toBe(10);
  });

  it('una cantidad basura vale uno, nunca cero ni negativa', () => {
    expect(Flirt.sendPayload(persona(), 'drink', { drinkId: 'd1', quantity: -3 }).quantity).toBe(1);
    expect(Flirt.sendPayload(persona(), 'drink', { drinkId: 'd1', quantity: 'ocho' }).quantity).toBe(1);
  });

  it('un tipo que no existe revienta aquí y no en la red', () => {
    expect(() => Flirt.sendPayload(persona(), 'abrazo', {})).toThrow(/abrazo/);
  });
});

describe('la advertencia del trago invitado', () => {
  // Un trago invitado es un pedido REAL: se cobra al mandarlo y si lo rechazan la copa
  // llega a la mesa de quien la mandó. Enseñar eso después de cobrar sería una trampa.
  it('un trago y una botella se advierten', () => {
    expect(Flirt.warningKey('drink')).toBe('flirt.warnDrink');
    expect(Flirt.warningKey('bottle')).toBe('flirt.warnBottle');
  });

  it('una señal o una invitación a conocerse no cobran nada, y no advierten nada', () => {
    expect(Flirt.warningKey('emoji')).toBeNull();
    expect(Flirt.warningKey('meet')).toBeNull();
  });
});

// --------------------------------------------------------------------- la bandeja

describe('la bandeja de recibidos', () => {
  const ayer = new Date(Date.now() - 3600e3).toISOString();
  const manana = new Date(Date.now() + 3600e3).toISOString();
  const nuevo = { id: 'f1', created_at: ayer, expires_at: manana, status: 'sent' };
  const visto = { id: 'f2', created_at: ayer, expires_at: manana, status: 'viewed', viewed_at: ayer };
  const contestado = {
    id: 'f3', created_at: manana, expires_at: manana, status: 'accepted',
    viewed_at: ayer, reaction: 'like',
  };
  const caducado = { id: 'f4', created_at: ayer, expires_at: ayer, status: 'sent' };

  it('el globito cuenta lo que no se ha abierto', () => {
    expect(Flirt.unread([nuevo, visto, contestado])).toBe(1);
  });

  it('lo caducado no cuenta: ya no se puede hacer nada con ello', () => {
    expect(Flirt.unread([caducado])).toBe(0);
  });

  it('lo que espera respuesta es lo que hay que atender', () => {
    expect(Flirt.pending([nuevo, visto, contestado, caducado])).toBe(2);
  });

  it('primero lo que espera respuesta, aunque sea más viejo', () => {
    const orden = Flirt.sortInbox([contestado, nuevo, visto]).map((f) => f.id);
    expect(orden.slice(0, 2).sort()).toEqual(['f1', 'f2']);
    expect(orden[2]).toBe('f3');
  });

  it('lo contestado no desaparece: quien recibió un trago quiere volver a verlo', () => {
    expect(Flirt.sortInbox([contestado])).toHaveLength(1);
  });

  it('un flirt vencido se llama vencido, no "enviado"', () => {
    expect(Flirt.statusKey(caducado)).toBe('flirt.stExpired');
    expect(Flirt.statusKey(nuevo)).toBe('flirt.stSent');
    expect(Flirt.statusKey(contestado)).toBe('flirt.stAccepted');
  });

  it('un flirt aceptado que ya venció sigue diciendo aceptado', () => {
    // Vencer no deshace una respuesta: decir "caducado" borraría que sí contestaron.
    expect(Flirt.statusKey({ status: 'accepted', expires_at: ayer })).toBe('flirt.stAccepted');
  });
});

describe('quién está esta noche', () => {
  const gente = [
    persona({ id: '1', display_name: 'Zoe', section: 'Terraza', floor: 1 }),
    persona({ id: '2', display_name: 'Ana', section: 'Terraza', floor: 1 }),
    persona({ id: '3', display_name: 'Beto', section: 'Pista', floor: 2 }),
  ];

  it('agrupa por zona y ordena por piso', () => {
    const grupos = Flirt.bySection(gente);
    expect(grupos.map((g) => g.section)).toEqual(['Terraza', 'Pista']);
  });

  it('dentro de una zona ordena por nombre: la lista no puede saltar bajo el dedo', () => {
    const [terraza] = Flirt.bySection(gente);
    expect(terraza.people.map((p) => p.display_name)).toEqual(['Ana', 'Zoe']);
  });

  it('ignora filas sin id: no se le puede mandar nada a nadie', () => {
    expect(Flirt.bySection([null, { display_name: 'X' }, gente[0]])).toHaveLength(1);
  });

  it('las zonas del filtro salen de la gente que hay, no de un catálogo inventado', () => {
    expect(Flirt.sections(gente)).toEqual(['Pista', 'Terraza']);
    expect(Flirt.sections([])).toEqual([]);
  });
});

// --------------------------------------------------------------------- reportar

describe('reportar a alguien', () => {
  it('el motivo tiene que ser uno de los que el servidor acepta', () => {
    expect(() => Flirt.reportPayload('me cae mal', {})).toThrow();
  });

  it('lleva el flirt como evidencia cuando lo hay', () => {
    expect(Flirt.reportPayload('harassment', { details: 'insistió', flirtId: 'f1' }))
      .toEqual({ reason: 'harassment', details: 'insistió', flirt_id: 'f1' });
  });

  it('sin detalle no manda un campo vacío', () => {
    expect(Flirt.reportPayload('other', { details: '  ' })).toEqual({ reason: 'other' });
  });
});

// --------------------------------------------------------------------- eventos

describe('los eventos del socket', () => {
  // El marco real trae el tipo en `event_type`; `type` siempre vale 'event'. Leer
  // `type` dejó una pantalla muda una vez y por eso está clavado con una prueba.
  it('lee el tipo real, que viaja en event_type', () => {
    expect(Flirt.affectsFlirts({ type: 'event', event_type: 'flirt_received' })).toBe(true);
    expect(Flirt.eventKind({ type: 'event', event_type: 'flirt_reaction' })).toBe('flirt_reaction');
  });

  it('un evento de otra pantalla no la toca', () => {
    expect(Flirt.affectsFlirts({ type: 'event', event_type: 'order_ready' })).toBe(false);
    expect(Flirt.eventKind({ type: 'event', event_type: 'order_ready' })).toBeNull();
  });

  it('el trago devuelto es asunto de esta pantalla: la copa llega a tu mesa', () => {
    expect(Flirt.affectsFlirts({ type: 'event', event_type: 'order_returned' })).toBe(true);
  });
});

// --------------------------------------------------------------------- moderación

describe('la bandeja de reportes del gerente', () => {
  const hace = (min) => new Date(Date.now() - min * 60e3).toISOString();
  const acoso = { id: 'r1', reason: 'harassment', status: 'open', created_at: hace(5), reports_against: 1 };
  const menor = { id: 'r2', reason: 'underage', status: 'open', created_at: hace(1), reports_against: 1 };
  const viejo = { id: 'r3', reason: 'other', status: 'open', created_at: hace(120), reports_against: 1 };
  const cerrado = { id: 'r4', reason: 'harassment', status: 'actioned', created_at: hace(200), reports_against: 3 };

  it('"parece menor de edad" es lo más grave: es lo único que puede cerrar el club', () => {
    expect(Manager.reportSeverity(menor)).toBe('urgent');
  });

  it('la segunda queja contra la misma persona sube sola de gravedad', () => {
    expect(Manager.reportSeverity({ reason: 'other', reports_against: 2 })).toBe('urgent');
  });

  it('lo abierto va primero, y dentro de eso lo grave', () => {
    expect(Manager.sortReports([cerrado, acoso, menor, viejo]).map((r) => r.id))
      .toEqual(['r2', 'r1', 'r3', 'r4']);
  });

  it('a igual gravedad, lo más viejo primero: una queja de hace dos horas es peor', () => {
    const a = { id: 'a', reason: 'other', status: 'open', created_at: hace(120) };
    const b = { id: 'b', reason: 'other', status: 'open', created_at: hace(2) };
    expect(Manager.sortReports([b, a]).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('un reporte ya resuelto no se vuelve a resolver', () => {
    expect(Manager.reportActions(cerrado)).toEqual([]);
    expect(Manager.reportActions({ status: 'dismissed' })).toEqual([]);
  });

  it('lo revisado todavía se puede accionar o descartar, pero no volver a revisar', () => {
    expect(Manager.reportActions({ status: 'reviewed' })).toEqual(['actioned', 'dismissed']);
  });

  it('bloquear una cuenta EXIGE una nota escrita', () => {
    // Bloquear cierra la sesión de una persona real y la saca de su mesa. Si esa
    // persona reclama dentro de un mes, la nota es lo único que el club va a tener.
    expect(Manager.validateResolution('actioned', '')).toBe('mod.errNote');
    expect(Manager.validateResolution('actioned', 'no sé')).toBe('mod.errNote');
    expect(Manager.validateResolution('actioned', 'Acoso repetido a dos clientas')).toBeNull();
  });

  it('descartar no exige nota: no le quita nada a nadie', () => {
    expect(Manager.validateResolution('dismissed', '')).toBeNull();
  });

  it('una nota kilométrica se rechaza antes de mandarla', () => {
    expect(Manager.validateResolution('reviewed', 'x'.repeat(501))).toBe('mod.errNoteLong');
  });

  it('un estado que el servidor no acepta se detiene aquí', () => {
    expect(Manager.validateResolution('borrado', 'lo que sea')).toBe('mod.errStatus');
  });

  it('la resolución no manda una nota vacía', () => {
    expect(Manager.resolutionPayload('dismissed', '   ')).toEqual({ status: 'dismissed' });
  });

  it('el resumen de arriba cuenta lo que espera y lo grave', () => {
    const s = Manager.moderationSummary([acoso, menor, viejo, cerrado]);
    expect(s).toEqual({ open: 3, urgent: 1, actioned: 1, total: 4 });
  });

  it('el aviso de reporte nuevo lee el tipo real del marco', () => {
    expect(Manager.affectsModeration({ type: 'event', event_type: 'user_reported' })).toBe(true);
    expect(Manager.affectsModeration({ type: 'event', event_type: 'tip_received' })).toBe(false);
  });
});
