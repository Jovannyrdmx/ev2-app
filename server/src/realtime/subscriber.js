// Redis side of the realtime channel: subscribes to the relay's stream and hands each
// event to the delivery function (docs/DECISIONES.md D26).
//
// Redis requires a connection in subscribe mode to do nothing else, so this duplicates
// the shared client instead of borrowing it.
'use strict';

const { CHANNEL } = require('./relay');

class EventSubscriber {
  /**
   * @param {object} opts
   * @param {object} opts.redis    a node-redis client to duplicate
   * @param {(event: object) => void} opts.onEvent
   * @param {object} [opts.logger]
   */
  constructor({ redis, onEvent, logger = console }) {
    this.source = redis;
    this.onEvent = onEvent;
    this.logger = logger;
    this.client = null;
    this.connected = false;
    this.received = 0;
    this.malformed = 0;
  }

  async start() {
    this.client = this.source.duplicate();
    this.client.on('error', (err) => {
      this.connected = false;
      this.logger.error('Realtime subscriber Redis error:', err.message);
    });
    this.client.on('ready', () => { this.connected = true; });
    await this.client.connect();
    await this.client.subscribe(CHANNEL, (message) => this.handle(message));
    this.connected = true;
    return this;
  }

  handle(message) {
    let event;
    try {
      event = JSON.parse(message);
    } catch {
      // A malformed message is counted and dropped: one bad frame must not take the
      // channel down for everyone connected.
      this.malformed += 1;
      return;
    }
    if (!event || !event.nightclub_id || !event.id) {
      this.malformed += 1;
      return;
    }
    this.received += 1;
    try {
      this.onEvent(event);
    } catch (err) {
      this.logger.error('Realtime delivery failed:', err.message);
    }
  }

  status() {
    return { connected: this.connected, received: this.received, malformed: this.malformed };
  }

  async stop() {
    if (!this.client) return;
    try {
      await this.client.unsubscribe(CHANNEL);
      await this.client.quit();
    } catch { /* closing anyway */ }
    this.client = null;
    this.connected = false;
  }
}

module.exports = { EventSubscriber };
