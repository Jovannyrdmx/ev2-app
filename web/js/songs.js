/**
 * EV2 — pedir una canción, y la cola que ve el DJ (paso 5.2 y 5.4).
 *
 * Dos pantallas, un solo módulo, porque las dos tienen que estar de acuerdo en el mismo
 * orden: si el cliente ve su canción en tercer lugar y el DJ la ve en séptima, el
 * cliente cree que el DJ lo ignoró.
 *
 * El servidor ya ordena por votos, luego propinas, luego antigüedad. Se repite ese
 * criterio aquí porque la lista se reordena en vivo con los eventos del socket, sin
 * volver a preguntar.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2Songs = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const cents = (value) => {
    if (value === null || value === undefined || value === '') return 0;
    const n = Math.round(Number(value) * 100);
    return Number.isFinite(n) ? n : 0;
  };

  /**
   * La misma llave que arma el servidor (`normalizeSong` en routes/tips.js): sin
   * acentos, minúsculas, y todo lo que no sea letra o número convertido en un espacio.
   *
   * Sirve para avisarle al cliente "esa canción ya está pedida, súmate" ANTES de
   * mandarla, en vez de dejar que el servidor conteste 409 "ya pediste esa canción".
   */
  function normalizeKey(title, artist) {
    const norm = (v) => String(v === null || v === undefined ? '' : v)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return `${norm(title)}|${norm(artist)}`;
  }

  /**
   * Busca en la cola una canción que sea la misma. Devuelve la fila o null.
   *
   * Solo cuenta contra las que siguen pedidas: una canción que ya sonó puede volver a
   * pedirse, y el servidor abre una fila nueva.
   */
  function findSame(queue, title, artist) {
    const key = normalizeKey(title, artist);
    if (key === '|') return null;
    return (queue || []).find((s) => s.status !== 'played'
      && normalizeKey(s.song_title, s.artist) === key) || null;
  }

  /** El orden de la cola: más votadas, luego más propina, luego las que llevan esperando. */
  function ranked(queue) {
    return (queue || []).slice().sort((a, b) => {
      const votes = (Number(b.votes) || 0) - (Number(a.votes) || 0);
      if (votes) return votes;
      const tips = cents(b.tips_total) - cents(a.tips_total);
      if (tips) return tips;
      return new Date(a.created_at || 0) - new Date(b.created_at || 0);
    });
  }

  /** Solo las que faltan por sonar. */
  const pending = (queue) => ranked((queue || []).filter((s) => s.status === 'requested'));

  /** Qué lugar ocupa una canción en la cola, contando desde 1. 0 si ya no está. */
  function positionOf(queue, songId) {
    const list = pending(queue);
    const i = list.findIndex((s) => s.id === songId);
    return i === -1 ? 0 : i + 1;
  }

  /**
   * Si el cliente ya pidió o votó esta canción.
   *
   * Para un invitado el servidor recorta `requesters` a nombre y mensaje y agrega
   * `i_voted`; para el personal manda los `user_id`. Se aceptan las dos formas para
   * que la misma tarjeta sirva en las dos pantallas.
   */
  function iVoted(song, userId) {
    if (!song) return false;
    if (song.i_voted !== undefined) return !!song.i_voted;
    return (song.requesters || []).some((r) => r.user_id && r.user_id === userId);
  }

  /**
   * Qué hacer con lo que escribió el cliente. Devuelve:
   *   { action: 'request' }                 → canción nueva
   *   { action: 'vote', song }              → ya está en la cola, se suma un voto
   *   { action: 'blocked', reason, song }   → ya votó esa, o falta el título
   *
   * Las tres llevan al mismo POST; la diferencia es lo que se le dice antes de tocar,
   * porque "tu canción es la número 3 con 5 votos" y "la pedimos" no son la misma
   * noticia.
   */
  function planRequest(queue, title, artist, userId) {
    if (!String(title || '').trim()) return { action: 'blocked', reason: 'song.errTitle', song: null };
    const same = findSame(queue, title, artist);
    if (!same) return { action: 'request', song: null };
    if (iVoted(same, userId)) return { action: 'blocked', reason: 'song.errAlready', song: same };
    return { action: 'vote', song: same };
  }

  /** Lo que se manda al servidor. La propina es opcional y va en el mismo POST. */
  function requestPayload(title, artist, opts) {
    const o = opts || {};
    const body = {
      client_request_id: o.clientRequestId,
      song_title: String(title || '').trim().slice(0, 200),
      tip_amount: Number(((cents(o.tipAmount) || 0) / 100).toFixed(2)),
      currency: o.currency || 'MXN',
      anonymous_tip: !!o.anonymous,
    };
    const art = String(artist || '').trim();
    if (art) body.artist = art.slice(0, 200);
    const message = String(o.message || '').trim();
    if (message) body.message = message.slice(0, 280);
    if (o.djUserId) body.dj_user_id = o.djUserId;
    return body;
  }

  /**
   * Por qué no se puede pedir canción. El servidor exige un DJ en turno: sin eso
   * contesta 422, y el cliente que ya escribió su canción se queda sin entender.
   */
  function requestBlocker(djs) {
    if (!(djs || []).length) return 'song.errNoDj';
    return null;
  }

  // ------------------------------------------------------------------ el DJ

  /**
   * Lo que el DJ necesita de un vistazo: cuántas esperan y cuánto llevan pedidas las
   * más viejas. Trabaja de espaldas a la pista y con una mano en la mezcla.
   */
  function djSummary(queue, now) {
    const list = pending(queue);
    const when = now ? new Date(now) : new Date();
    const oldest = list.reduce((acc, s) => {
      const at = new Date(s.created_at || when);
      return acc === null || at < acc ? at : acc;
    }, null);
    let tips = 0;
    for (const s of list) tips += cents(s.tips_total);
    return {
      waiting: list.length,
      votes: list.reduce((sum, s) => sum + (Number(s.votes) || 0), 0),
      tips: (tips / 100).toFixed(2),
      // Redondeado hacia arriba: una canción que lleva 90 segundos esperando lleva
      // "2 min", no "1". Quedarse corto hace que el DJ crea que va al día.
      oldestMinutes: oldest ? Math.max(0, Math.ceil((when - oldest) / 60000)) : 0,
    };
  }

  /**
   * Los eventos del socket que mueven estas pantallas.
   *
   * El marco real trae el tipo en `event_type`; `type` siempre vale 'event'. Leer
   * `type` ya dejó una pantalla muda una vez y no se vuelve a repetir.
   */
  const SONG_EVENTS = ['song_requested', 'song_request_voted', 'song_played', 'song_tip_received'];

  const affectsSongs = (message) => SONG_EVENTS
    .includes(message && (message.event_type || message.type));

  return {
    SONG_EVENTS,
    normalizeKey,
    findSame,
    ranked,
    pending,
    positionOf,
    iVoted,
    planRequest,
    requestPayload,
    requestBlocker,
    djSummary,
    affectsSongs,
  };
}));
