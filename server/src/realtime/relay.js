// Relays committed domain events from Postgres to Redis (docs/DECISIONES.md D26).
//
// Why not publish straight from the routes: most of them write their event inside the
// same transaction as the change, which is what makes the two atomic. Publishing there
// would announce a pedido that the transaction may still roll back. So the `events`
// table is the outbox, `pg_notify` (transactional, fires only on commit) is the wake-up
// call, and this relay is what puts the event on Redis.
//
// The relay never trusts notifications alone. It sweeps forward from a persisted cursor;
// the notification only means "sweep now instead of in a second". A notification lost
// while the listening connection was down is picked up by the next sweep.
//
// Exactly one process relays at a time, chosen with a Postgres advisory lock. Two
// relays would publish everything twice; the others stand by and take over if the
// leader dies.
'use strict';

const { pool } = require('../db/pool');

const CHANNEL = 'ev2:events';
const PG_CHANNEL = 'ev2_events';
const LOCK_KEY = 4552321; // arbitrary but fixed: "EV2" + 1
const SWEEP_LIMIT = 500;

// Events older than this are not delivered live: a socket that reconnects after an
// outage should get them through the catch-up read (step 3.3), not as a burst of
// notifications about things that already happened.
const LIVE_WINDOW_SECONDS = 300;

class EventRelay {
  /**
   * @param {object} opts
   * @param {object} opts.redis        connected node-redis client (publisher)
   * @param {object} [opts.db]         pg pool
   * @param {string} [opts.instanceId] identifies the leader in the state table
   * @param {number} [opts.sweepIntervalMs] safety sweep, independent of notifications
   * @param {number} [opts.leaderRetryMs]   how often a stand-by tries to take over
   * @param {object} [opts.logger]
   */
  constructor({
    redis, db = pool, instanceId = `${process.pid}@${require('os').hostname()}`,
    sweepIntervalMs = 1000, leaderRetryMs = 5000, logger = console,
  }) {
    this.redis = redis;
    this.db = db;
    this.instanceId = instanceId;
    this.sweepIntervalMs = sweepIntervalMs;
    this.leaderRetryMs = leaderRetryMs;
    this.logger = logger;
    this.isLeader = false;
    this.running = false;
    this.cursor = 0n;
    this.published = 0;
    this.skippedStale = 0;
    this.listener = null;
    this.onNotification = null;
    this.onListenerError = null;
    // Sweeps are serialised through this chain rather than through a flag. A boolean
    // guard let three sweeps overlap under a burst of notifications and the same event
    // went out twice, out of order. A chain cannot overlap by construction.
    this.inFlight = Promise.resolve();
    this.queued = false;
    this.timers = [];
  }

  async start() {
    this.running = true;
    await this.tryBecomeLeader();
    if (!this.isLeader) {
      const t = setInterval(() => {
        this.tryBecomeLeader().catch((err) => this.logger.error('Relay leadership retry failed:', err.message));
      }, this.leaderRetryMs);
      t.unref?.();
      this.timers.push(t);
    }
    return this;
  }

  async tryBecomeLeader() {
    if (!this.running || this.isLeader) return false;
    const client = await this.db.connect();
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
    if (!rows[0].locked) {
      client.release();
      return false;
    }
    // The lock lives on this connection, so the connection is held for as long as we
    // lead: releasing it to the pool would release the lock with it.
    this.listener = client;
    this.isLeader = true;

    await this.loadCursor();
    // Kept as references so stop() can remove them. A pooled connection is reused, and
    // listeners left behind pile up on the same client every time a relay restarts
    // (Node warns at ten, and then they are a real leak).
    this.onNotification = () => this.requestSweep();
    this.onListenerError = (err) => {
      this.logger.error('Relay listener connection error:', err.message);
      this.stepDown();
    };
    client.on('notification', this.onNotification);
    client.on('error', this.onListenerError);
    await client.query(`LISTEN ${PG_CHANNEL}`);
    this.logger.log?.(`Realtime relay: leading from event ${this.cursor}`);

    const t = setInterval(() => this.requestSweep(), this.sweepIntervalMs);
    t.unref?.();
    this.timers.push(t);
    await this.requestSweep();
    return true;
  }

  /**
   * A stored cursor is resumed exactly, including 0, which legitimately means "nothing
   * relayed yet, start from the first event". NULL is different: it means this relay has
   * never run here, and then it starts at the newest event, because a fresh deployment
   * must not replay a whole night into everyone's screen.
   */
  async loadCursor() {
    const { rows } = await this.db.query('SELECT last_event_id FROM realtime_relay_state WHERE id = 1');
    const stored = rows[0]?.last_event_id;
    if (stored !== null && stored !== undefined) {
      this.cursor = BigInt(stored);
      return;
    }
    const max = await this.db.query('SELECT COALESCE(max(id), 0) AS id FROM events');
    this.cursor = BigInt(max.rows[0].id);
    await this.saveCursor();
  }

  async saveCursor() {
    await this.db.query(
      `UPDATE realtime_relay_state SET last_event_id = $1, leader_instance = $2, updated_at = now()
        WHERE id = 1`,
      [this.cursor.toString(), this.instanceId]);
  }

  /**
   * Queues a sweep behind whatever is running. At most one sweep runs and one waits:
   * a hundred inserts in one second cause two sweeps, not a hundred, and never two at
   * the same time.
   */
  requestSweep() {
    if (this.queued) return this.inFlight;
    this.queued = true;
    this.inFlight = this.inFlight
      .then(() => { this.queued = false; return this.sweep(); })
      .catch((err) => this.logger.error('Relay sweep failed:', err.message));
    return this.inFlight;
  }

  async sweep() {
    if (!this.isLeader || !this.running) return 0;
    let total = 0;
    {
      for (;;) {
        // `ORDER BY e.id` is qualified on purpose. With `SELECT id::text AS id`,
        // PostgreSQL resolves an unqualified `ORDER BY id` to the OUTPUT column -- the
        // text one -- and sorts lexicographically: 1, 10, 2. Events went out in that
        // order until this was caught. The text alias is also renamed so no future
        // reader has to know that rule.
        const { rows } = await this.db.query(
          `SELECT e.id::text AS event_id, e.nightclub_id, e.type, e.audience, e.payload,
                  e.created_at,
                  (e.created_at > now() - ($2 || ' seconds')::interval) AS is_live
             FROM events e WHERE e.id > $1 ORDER BY e.id ASC LIMIT $3`,
          [this.cursor.toString(), String(LIVE_WINDOW_SECONDS), SWEEP_LIMIT]);
        if (rows.length === 0) break;
        for (const row of rows) {
          // Checked per row, not just per sweep: a relay that is stepping down or
          // shutting down must stop publishing immediately. Without this, a stopped
          // relay kept draining rows and a second one published the same events again.
          if (!this.isLeader || !this.running) return total;
          if (row.is_live) {
            await this.publish(row);
            this.published += 1;
            total += 1;
          } else {
            this.skippedStale += 1;
          }
          this.cursor = BigInt(row.event_id);
        }
        await this.saveCursor();
        if (rows.length < SWEEP_LIMIT) break;
      }
    }
    return total;
  }

  async publish(row) {
    const message = JSON.stringify({
      id: row.event_id,
      nightclub_id: row.nightclub_id,
      type: row.type,
      audience: row.audience,
      payload: row.payload,
      created_at: row.created_at,
    });
    try {
      await this.redis.publish(CHANNEL, message);
    } catch (err) {
      // Redis being down must not stall the relay or the API. The event is already
      // committed in Postgres and reaches the client through the catch-up read.
      this.logger.error('Relay could not publish to Redis:', err.message);
    }
  }

  detachListeners() {
    if (!this.listener) return;
    if (this.onNotification) this.listener.removeListener('notification', this.onNotification);
    if (this.onListenerError) this.listener.removeListener('error', this.onListenerError);
    this.onNotification = null;
    this.onListenerError = null;
  }

  stepDown() {
    this.isLeader = false;
    if (this.listener) {
      this.detachListeners();
      // Destroyed rather than returned to the pool: this connection is in an unknown
      // state and still holds the advisory lock until it closes.
      try { this.listener.release(true); } catch { /* already gone */ }
      this.listener = null;
    }
  }

  status() {
    return {
      leader: this.isLeader,
      cursor: this.cursor.toString(),
      published: this.published,
      skipped_stale: this.skippedStale,
    };
  }

  async stop() {
    this.running = false;
    this.isLeader = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    // Wait for whatever sweep is in flight: releasing the connection while it is still
    // publishing is how a "stopped" relay keeps talking.
    await this.inFlight.catch(() => {});
    if (this.listener) {
      this.detachListeners();
      try {
        await this.listener.query(`UNLISTEN ${PG_CHANNEL}`);
        await this.listener.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
      } catch { /* the connection may already be gone */ }
      try { this.listener.release(); } catch { /* ditto */ }
      this.listener = null;
    }
  }
}

module.exports = { EventRelay, CHANNEL, PG_CHANNEL, LOCK_KEY, LIVE_WINDOW_SECONDS };
