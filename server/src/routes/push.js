// Push notifications: the phone says "yes" here (D90).
//
//   anyone signed in  GET    /push/config                       is push on, and the public key
//                     POST   /nightclubs/:id/push/subscriptions this device, for me
//                     DELETE /nightclubs/:id/push/subscriptions this device, no more (sign-out)
//                     POST   /nightclubs/:id/push/test          one notice to my devices now
//
// What gets notified, and to whom, lives in services/push.js; this file only keeps
// the list of devices.
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, sameNightclub } = require('../middleware/auth');
const push = require('../services/push');

const router = express.Router({ mergeParams: true });

// A person rarely has more than two or three phones; past this the oldest go.
const MAX_DEVICES_PER_USER = 10;

/**
 * The server POSTs to whatever endpoint the browser gave. Accepting any https URL would
 * let anyone make the server call an address of their choosing, so only the push
 * services of the browsers that exist are accepted.
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, // Chrome, Edge on Android, Samsung Internet
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^web\.push\.apple\.com$/, // Safari, and iPhone apps on the home screen
  /^([a-z0-9-]+\.)*notify\.windows\.com$/, // Edge on Windows
];

function allowedEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && !url.port && PUSH_HOSTS.some((re) => re.test(url.hostname));
}

const endpoint = z.string().max(1000).refine(allowedEndpoint, 'no es un servicio de notificaciones conocido');

router.get('/push/config', authenticate, (req, res) => {
  const c = push.config();
  res.json({ enabled: c.enabled, public_key: c.enabled ? c.publicKey : null });
});

router.use('/nightclubs/:nightclubId/push', authenticate, sameNightclub());

router.post('/nightclubs/:nightclubId/push/subscriptions',
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      endpoint,
      keys: z.object({
        p256dh: z.string().min(16).max(200).regex(/^[A-Za-z0-9_-]+=*$/),
        auth: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+=*$/),
      }),
      lang: z.enum(['es', 'en']).default('es'),
    }),
  }),
  asyncHandler(async (req, res) => {
    if (!push.config().enabled) {
      throw new ApiError(503, 'push_disabled', 'Las notificaciones no están configuradas en el servidor');
    }
    const { nightclubId } = req.params;
    const b = req.body;
    const agent = String(req.get('user-agent') || '').slice(0, 300) || null;
    // Same endpoint = same phone. If someone else had it (a shared phone), it is now
    // this person's: the previous one must stop getting notices on it.
    const { rows } = await pool.query(
      `INSERT INTO push_subscriptions (nightclub_id, user_id, endpoint, p256dh, auth, lang, user_agent)
       VALUES ($1, $2, $3::text, $4, $5, $6, $7)
       ON CONFLICT (endpoint) DO UPDATE
         SET nightclub_id = EXCLUDED.nightclub_id, user_id = EXCLUDED.user_id,
             p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, lang = EXCLUDED.lang,
             user_agent = EXCLUDED.user_agent, failures = 0
       RETURNING id, (xmax = 0) AS created`,
      [nightclubId, req.user.id, b.endpoint, b.keys.p256dh, b.keys.auth, b.lang, agent]);
    await pool.query(
      `DELETE FROM push_subscriptions WHERE id IN (
         SELECT id FROM push_subscriptions WHERE user_id = $1
          ORDER BY created_at DESC OFFSET $2)`,
      [req.user.id, MAX_DEVICES_PER_USER]);
    res.status(rows[0].created ? 201 : 200).json({ subscription: { id: rows[0].id } });
  }));

router.delete('/nightclubs/:nightclubId/push/subscriptions',
  validate({ params: z.object({ nightclubId: uuid }), body: z.object({ endpoint: z.string().max(1000) }) }),
  asyncHandler(async (req, res) => {
    // Only your own: knowing someone's endpoint must not let you switch off their phone.
    await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1::text AND user_id = $2',
      [req.body.endpoint, req.user.id]);
    res.status(204).end();
  }));

router.post('/nightclubs/:nightclubId/push/test',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    if (!push.ensureConfigured()) {
      throw new ApiError(503, 'push_disabled', 'Las notificaciones no están configuradas en el servidor');
    }
    const r = await push.sendTest({ nightclubId: req.params.nightclubId, userId: req.user.id });
    res.json(r);
  }));

module.exports = router;
module.exports.allowedEndpoint = allowedEndpoint;
