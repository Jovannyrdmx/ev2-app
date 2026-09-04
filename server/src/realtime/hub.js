// Connection registry for the realtime server (docs/DECISIONES.md D25).
//
// The hub holds connections, never domain state. Who is sitting where, what has been
// ordered and what has been paid live in Postgres and are changed only through the
// REST API; the socket is a delivery channel, so restarting it loses nothing but the
// sockets themselves. That is the whole point of "sin estado propio": the old server
// kept five hard-coded tables in memory and became the third place the truth lived.
'use strict';

const { matchesAudience } = require('../services/events');

/** The wire form of an event. Ids travel as strings: they are 64-bit. */
function toMessage(event) {
  return {
    type: 'event',
    id: String(event.id),
    event_type: event.type,
    payload: event.payload,
    created_at: event.created_at,
  };
}

/**
 * Of the live events held back while a connection was replaying, the ones it has not
 * already been sent. Without this, an event that arrived during the catch-up read and
 * was also part of it would be shown twice (D27).
 *
 * @param {{id: bigint, message: object}[]} buffered
 * @param {bigint|null|undefined} lastReplayedId
 */
function pendingAfter(buffered, lastReplayedId) {
  const cutoff = lastReplayedId ?? -1n;
  return buffered.filter((held) => held.id > cutoff).map((held) => held.message);
}

class Hub {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxPerUser] connections one account may hold at once. A phone
   *   plus a laptop is normal; fifty is a runaway client or someone hammering us.
   */
  constructor({ maxPerUser = 5 } = {}) {
    this.maxPerUser = maxPerUser;
    /** @type {Map<string, Set<object>>} nightclubId -> connections */
    this.byClub = new Map();
    /** @type {Map<string, Set<object>>} userId -> connections */
    this.byUser = new Map();
  }

  get size() {
    let total = 0;
    for (const set of this.byClub.values()) total += set.size;
    return total;
  }

  countForUser(userId) {
    return this.byUser.get(userId)?.size || 0;
  }

  add(conn) {
    const club = conn.user.nightclub_id;
    if (!this.byClub.has(club)) this.byClub.set(club, new Set());
    this.byClub.get(club).add(conn);
    if (!this.byUser.has(conn.user.id)) this.byUser.set(conn.user.id, new Set());
    this.byUser.get(conn.user.id).add(conn);
    return conn;
  }

  remove(conn) {
    const club = this.byClub.get(conn.user.nightclub_id);
    if (club) {
      club.delete(conn);
      if (club.size === 0) this.byClub.delete(conn.user.nightclub_id);
    }
    const user = this.byUser.get(conn.user.id);
    if (user) {
      user.delete(conn);
      if (user.size === 0) this.byUser.delete(conn.user.id);
    }
  }

  /** Oldest connection of a user, so a new one can push it out instead of being refused. */
  oldestForUser(userId) {
    const set = this.byUser.get(userId);
    if (!set || set.size === 0) return null;
    return [...set].reduce((a, b) => (a.connectedAt <= b.connectedAt ? a : b));
  }

  /**
   * Delivers one domain event to the connections it is addressed to, inside its own
   * club. An event without an audience goes to everyone in that club; an audience of
   * roles or user ids narrows it. Nothing ever crosses to another club.
   * @returns {number} connections the event reached
   */
  deliver(event, send) {
    const conns = this.byClub.get(event.nightclub_id);
    if (!conns) return 0;
    let delivered = 0;
    for (const conn of conns) {
      if (!matchesAudience(event.audience, conn.user)) continue;
      // The event is handed over too, not just the message: a connection that is still
      // replaying what it missed needs the id to buffer and de-duplicate (D27).
      send(conn, toMessage(event), event);
      delivered += 1;
    }
    return delivered;
  }

  /** Every connection of one account, for a forced sign-out or a token expiry sweep. */
  forUser(userId) {
    return [...(this.byUser.get(userId) || [])];
  }

  all() {
    const out = [];
    for (const set of this.byClub.values()) out.push(...set);
    return out;
  }

  stats() {
    return {
      connections: this.size,
      users: this.byUser.size,
      nightclubs: this.byClub.size,
    };
  }
}

module.exports = { Hub, toMessage, pendingAfter };
