-- ============================================================================
-- Migration 045: push notifications to phones (D90).
--
-- One row per device that said "yes" to notifications. The browser hands us an
-- endpoint (its push service) and two keys to encrypt the message for that device
-- alone; nothing else about the phone is stored.
--
-- A subscription belongs to the person signed in when it was made. Signing out
-- removes it (the next person on that phone must not get the previous one's
-- notices), and the push service answering 404/410 removes it too: that device
-- uninstalled the app or revoked the permission.
-- ============================================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id    UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The push service URL is the device's identity: the same phone subscribing again
  -- gets the same endpoint, so it replaces its row instead of doubling notices.
  endpoint        TEXT NOT NULL UNIQUE CHECK (endpoint ~ '^https://'),
  p256dh          VARCHAR(200) NOT NULL,
  auth            VARCHAR(100) NOT NULL,
  -- The language the notice is written in: the one the app had when subscribing.
  lang            VARCHAR(2) NOT NULL DEFAULT 'es' CHECK (lang IN ('es', 'en')),
  user_agent      VARCHAR(300),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sent_at    TIMESTAMPTZ,
  -- Consecutive failures that were not "gone" (timeouts, 5xx). After several in a
  -- row the device is dropped: a subscription nobody can deliver to is just noise.
  failures        SMALLINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS push_subscriptions_club ON push_subscriptions (nightclub_id);
