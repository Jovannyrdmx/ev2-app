/**
 * EV2 — flirt: mandar una señal a alguien que está esta noche en el club (paso 2.3/5.2).
 *
 * Este módulo decide QUÉ se le deja hacer al cliente y qué se le enseña. Importa más
 * que cualquier otra pantalla porque aquí el error no cuesta dinero: cuesta que alguien
 * reciba algo que no quería recibir. Por eso las reglas se comprueban dos veces —aquí
 * antes de mandar, y en el servidor otra vez— y por eso la interfaz nunca ofrece un
 * botón que el servidor va a rechazar.
 *
 * Tres reglas que no se negocian, copiadas del servidor (docs/DECISIONES.md D18):
 *
 *   1. **Nadie aparece sin haberlo pedido.** La lista solo trae a quien activó
 *      "aparecer en la lista"; recibir requiere activar "aceptar invitaciones". Son dos
 *      permisos distintos a propósito: se puede querer mandar sin querer aparecer.
 *   2. **Los dos tienen que estar sentados AHORA.** Sin mesa no se manda ni se ve nada.
 *      Es lo que hace que esto sea el club y no una app de citas.
 *   3. **Un trago invitado es un pedido REAL y no se devuelve.** Si la otra persona lo
 *      rechaza, la copa se va a la mesa de quien la mandó: se cobra igual. Eso hay que
 *      decirlo ANTES de tocar el botón, no después.
 *
 * Sin DOM a propósito: todo esto se prueba en Node.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2Flirt = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Las mismas claves que acepta el servidor (server/src/routes/flirts.js). Si aquí se
  // ofreciera una que allá no existe, el cliente recibiría un 400 sin explicación.
  const EMOJIS = [
    { key: 'wave', icon: '👋', labelKey: 'flirt.emWave' },
    { key: 'wink', icon: '😉', labelKey: 'flirt.emWink' },
    { key: 'kiss', icon: '😘', labelKey: 'flirt.emKiss' },
    { key: 'fire', icon: '🔥', labelKey: 'flirt.emFire' },
    { key: 'heart', icon: '❤️', labelKey: 'flirt.emHeart' },
    { key: 'dance', icon: '💃', labelKey: 'flirt.emDance' },
    { key: 'star', icon: '⭐', labelKey: 'flirt.emStar' },
  ];
  const EMOJI_KEYS = EMOJIS.map((e) => e.key);
  const ICON_BY_KEY = EMOJIS.reduce((acc, e) => { acc[e.key] = e.icon; return acc; }, {});

  // Lo que puede contestar quien recibe. `not_interested` es distinto de todos los
  // demás: cierra la conversación por esta noche y el servidor silencia a ese remitente.
  const REACTIONS = [
    { key: 'like', icon: '👍', labelKey: 'flirt.rcLike', accepts: true },
    { key: 'wave', icon: '👋', labelKey: 'flirt.rcWave', accepts: true },
    { key: 'kiss', icon: '😘', labelKey: 'flirt.rcKiss', accepts: true },
    { key: 'fire', icon: '🔥', labelKey: 'flirt.rcFire', accepts: true },
    { key: 'interested', icon: '💬', labelKey: 'flirt.rcInterested', accepts: true },
    { key: 'not_interested', icon: '🚫', labelKey: 'flirt.rcNo', accepts: false },
  ];

  const TYPES = ['emoji', 'meet', 'drink', 'bottle'];
  const GIFT_TYPES = ['drink', 'bottle'];
  const REPORT_REASONS = [
    { key: 'harassment', labelKey: 'flirt.rpHarassment' },
    { key: 'underage', labelKey: 'flirt.rpUnderage' },
    { key: 'fake_profile', labelKey: 'flirt.rpFake' },
    { key: 'other', labelKey: 'flirt.rpOther' },
  ];

  // Los mismos números que aplica el servidor. Se repiten aquí para poder avisar ANTES
  // de gastar el intento; el servidor los vuelve a contar, que es donde cuentan.
  const LIMITS = { perHour: 20, unansweredPerNight: 3, messageMax: 140, quantityMax: 10 };

  const isGift = (type) => GIFT_TYPES.indexOf(type) !== -1;

  // ------------------------------------------------------- quién está esta noche

  /**
   * Agrupa a la gente por zona, en el orden en que se camina el club: por piso, luego
   * por zona, y dentro de cada una por nombre.
   *
   * Va ordenado y no por cercanía ni por "sugeridos" a propósito: una lista que se
   * reacomoda sola hace que el dedo toque a otra persona, y aquí eso significa mandarle
   * algo a quien no era.
   */
  function bySection(people) {
    const groups = new Map();
    for (const person of (people || [])) {
      if (!person || !person.id) continue;
      const key = `${person.floor == null ? '' : person.floor}|${person.section || ''}`;
      if (!groups.has(key)) {
        groups.set(key, { floor: person.floor == null ? null : person.floor, section: person.section || '', people: [] });
      }
      groups.get(key).people.push(person);
    }
    return [...groups.values()]
      .map((g) => ({
        ...g,
        people: g.people.slice().sort((a, b) => String(a.display_name || '')
          .localeCompare(String(b.display_name || ''), 'es')),
      }))
      .sort((a, b) => (a.floor || 0) - (b.floor || 0)
        || String(a.section).localeCompare(String(b.section), 'es'));
  }

  /** Las zonas presentes, para el filtro. Nunca inventa una que no tenga a nadie. */
  function sections(people) {
    const seen = new Set();
    for (const p of (people || [])) if (p && p.section) seen.add(p.section);
    return [...seen].sort((a, b) => a.localeCompare(b, 'es'));
  }

  // ------------------------------------------------------- permisos y estado propio

  /**
   * En cuál de los tres estados está el cliente. Son tres y no dos porque mandar y
   * recibir se activan por separado:
   *
   *   'off'      — no acepta invitaciones: no recibe nada y no aparece en la lista.
   *   'sending'  — acepta recibir pero eligió no aparecer: puede mandar, nadie lo ve.
   *   'full'     — acepta y aparece.
   */
  function optInState(prefs) {
    const p = prefs || {};
    if (!p.accept_flirts) return 'off';
    return p.discoverable ? 'full' : 'sending';
  }

  // ------------------------------------------------------- mandar

  /**
   * Por qué NO se puede mandar ahora mismo. Devuelve la clave del motivo o null.
   *
   * El orden importa: primero lo que el cliente puede arreglar solo (sentarse), después
   * lo que depende de la otra persona. Decirle "esa persona no acepta" a quien ni
   * siquiera se ha sentado lo manda a buscar el problema donde no está.
   */
  function sendBlocker(opts) {
    const o = opts || {};
    const person = o.person;
    if (!o.myTable || !o.myTable.id) return 'flirt.errNoTable';
    if (!person || !person.id) return 'flirt.errNoPerson';
    if (o.me && person.id === o.me.id) return 'flirt.errSelf';
    if (person.accept_flirts === false) return 'flirt.errNotAccepting';
    if (!person.table_id) return 'flirt.errLeft';
    return null;
  }

  /**
   * Por qué NO se puede invitar un trago. Es aparte de `sendBlocker` porque manda al
   * cliente a otro lado: aquí el problema es el menú, no la persona.
   */
  function giftBlocker(drinkId, drinks) {
    if (!drinkId) return 'flirt.errNoDrink';
    const list = drinks || [];
    const drink = list.find((d) => d && d.id === drinkId);
    if (!drink) return 'flirt.errNoDrink';
    if (drink.available === false) return 'flirt.errDrinkOut';
    return null;
  }

  /** El recorte del mensaje. Se corta aquí para que el servidor no rechace 141 letras. */
  function trimMessage(text) {
    return String(text == null ? '' : text).trim().slice(0, LIMITS.messageMax);
  }

  /**
   * Lo que se manda al crear un flirt. El id de petición lo pone quien llama y se fija
   * AL ABRIR la hoja, no al tocar enviar: si el dedo toca dos veces —cosa que pasa a
   * oscuras— el servidor reconoce el repetido y devuelve el mismo flirt en vez de
   * mandar dos, que con un trago invitado significaría cobrar dos.
   */
  function sendPayload(person, type, opts) {
    const o = opts || {};
    if (TYPES.indexOf(type) === -1) throw new Error(`unknown flirt type: ${type}`);
    const body = {
      client_request_id: o.clientRequestId,
      recipient_id: person.id,
      type,
    };
    if (type === 'emoji') {
      body.emoji = EMOJI_KEYS.indexOf(o.emoji) === -1 ? EMOJI_KEYS[0] : o.emoji;
    }
    if (isGift(type)) {
      body.drink_id = o.drinkId;
      body.quantity = Math.min(LIMITS.quantityMax, Math.max(1, Number(o.quantity) || 1));
    }
    const message = trimMessage(o.message);
    if (message) body.message = message;
    return body;
  }

  /**
   * Lo que hay que advertir antes de mandar, o null.
   *
   * Un trago invitado es un pedido real que se cobra al mandarlo: si la otra persona lo
   * rechaza, la copa llega a la mesa de quien la mandó, y se paga igual. Enseñar esto
   * después de cobrar sería una trampa.
   */
  function warningKey(type) {
    if (type === 'bottle') return 'flirt.warnBottle';
    if (type === 'drink') return 'flirt.warnDrink';
    return null;
  }

  // ------------------------------------------------------- bandeja

  const expired = (flirt, now) => {
    if (!flirt || !flirt.expires_at) return false;
    return new Date(flirt.expires_at).getTime() <= (now ? now.getTime() : Date.now());
  };

  const answered = (flirt) => !!(flirt && flirt.reaction);

  /** Los que llegaron y todavía no se abren. Es el número del globito de la pestaña. */
  function unread(flirts, now) {
    return (flirts || []).filter((f) => f && !f.viewed_at && !expired(f, now)).length;
  }

  /** Los recibidos que siguen esperando respuesta: eso es lo que el cliente debe atender. */
  function pending(flirts, now) {
    return (flirts || []).filter((f) => f && !answered(f) && !expired(f, now)).length;
  }

  /**
   * El orden de la bandeja: primero lo que espera respuesta, después lo más reciente.
   *
   * Lo ya contestado no desaparece —quien recibió un trago quiere volver a verlo— pero
   * baja, para que lo que exige una decisión esté siempre bajo el pulgar.
   */
  function sortInbox(flirts, now) {
    return (flirts || []).slice().sort((a, b) => {
      const pa = answered(a) || expired(a, now) ? 1 : 0;
      const pb = answered(b) || expired(b, now) ? 1 : 0;
      if (pa !== pb) return pa - pb;
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });
  }

  const STATUS_KEY = {
    sent: 'flirt.stSent',
    viewed: 'flirt.stViewed',
    accepted: 'flirt.stAccepted',
    declined: 'flirt.stDeclined',
  };

  /** Cómo se llama el estado de un flirt. Lo caducado se dice caducado, no "enviado". */
  function statusKey(flirt, now) {
    if (!flirt) return 'flirt.stSent';
    if (expired(flirt, now) && (flirt.status === 'sent' || flirt.status === 'viewed')) return 'flirt.stExpired';
    return STATUS_KEY[flirt.status] || 'flirt.stSent';
  }

  const TYPE_KEY = {
    emoji: 'flirt.tyEmoji', meet: 'flirt.tyMeet', drink: 'flirt.tyDrink', bottle: 'flirt.tyBottle',
  };
  const typeKey = (type) => TYPE_KEY[type] || 'flirt.tyEmoji';
  const emojiIcon = (key) => ICON_BY_KEY[key] || '';

  const reactionOf = (key) => REACTIONS.find((r) => r.key === key) || null;

  /**
   * Si se puede reportar a quien mandó esto. Solo un flirt REALMENTE recibido sirve de
   * evidencia: el servidor comprueba que el reportante sea el destinatario, así que
   * ofrecer el botón en otro lado sería ofrecer un 404.
   */
  const canReport = (flirt) => !!(flirt && flirt.id && flirt.sender_id);

  /** Lo que se manda al reportar. Sin motivo válido no se manda nada. */
  function reportPayload(reason, opts) {
    const o = opts || {};
    if (!REPORT_REASONS.some((r) => r.key === reason)) throw new Error(`unknown report reason: ${reason}`);
    const body = { reason };
    const details = String(o.details == null ? '' : o.details).trim().slice(0, 500);
    if (details) body.details = details;
    if (o.flirtId) body.flirt_id = o.flirtId;
    return body;
  }

  // ------------------------------------------------------- tiempo real

  /**
   * Un evento del socket que toca a esta pantalla. Ojo: el marco real trae el tipo en
   * `event_type`; `type` siempre vale 'event'. Leer `type` fue un error que ya costó
   * una pantalla muda una vez.
   *
   * `order_returned` está aquí porque un trago rechazado vuelve a la mesa de quien lo
   * mandó: quien lo invitó tiene que enterarse de que la copa va para allá.
   */
  const FLIRT_EVENTS = ['flirt_received', 'flirt_reaction', 'order_returned'];

  const affectsFlirts = (message) => FLIRT_EVENTS
    .includes(message && (message.event_type || message.type));

  const eventKind = (message) => {
    const kind = message && (message.event_type || message.type);
    return FLIRT_EVENTS.includes(kind) ? kind : null;
  };

  return {
    EMOJIS,
    EMOJI_KEYS,
    REACTIONS,
    TYPES,
    GIFT_TYPES,
    REPORT_REASONS,
    LIMITS,
    FLIRT_EVENTS,
    isGift,
    bySection,
    sections,
    optInState,
    sendBlocker,
    giftBlocker,
    trimMessage,
    sendPayload,
    warningKey,
    expired,
    answered,
    unread,
    pending,
    sortInbox,
    statusKey,
    typeKey,
    emojiIcon,
    reactionOf,
    canReport,
    reportPayload,
    affectsFlirts,
    eventKind,
  };
}));
