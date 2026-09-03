-- ============================================================================
-- EV2 Clandestinoz — Migration 001: unified initial schema
-- PostgreSQL 15+. Replaces legacy init.sql / init-nightclub.sql / init-reservations.sql.
-- Conventions: UUID ids, TIMESTAMPTZ, NUMERIC(12,2) money + currency, CHECK'd states,
--              nightclub_id on tenant-scoped tables, updated_at via trigger.
-- Transaction is managed by src/db/migrate.js (do not add BEGIN/COMMIT here).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'DELETE is not allowed on table %', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Core
-- ---------------------------------------------------------------------------
CREATE TABLE nightclubs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(255) NOT NULL,
  slug             VARCHAR(100) NOT NULL UNIQUE,
  address          TEXT,
  city             VARCHAR(100),
  country          CHAR(2) NOT NULL DEFAULT 'MX',
  phone            VARCHAR(30),
  timezone         VARCHAR(64) NOT NULL DEFAULT 'America/Hermosillo',
  currency_default CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency_default IN ('MXN','USD')),
  capacity         INTEGER CHECK (capacity IS NULL OR capacity > 0),
  settings         JSONB NOT NULL DEFAULT '{}'::jsonb,
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id       UUID NOT NULL REFERENCES nightclubs(id) ON DELETE RESTRICT,
  email              VARCHAR(255) NOT NULL,
  phone              VARCHAR(30),
  password_hash      TEXT NOT NULL,
  first_name         VARCHAR(100) NOT NULL,
  last_name          VARCHAR(100) NOT NULL DEFAULT '',
  display_name       VARCHAR(100),
  role               VARCHAR(20) NOT NULL DEFAULT 'guest'
                     CHECK (role IN ('guest','waiter','bartender','dancer','dj','light_tech','valet','hostess','manager','admin')),
  birth_date         DATE NOT NULL,
  age_verified       BOOLEAN NOT NULL DEFAULT false,
  terms_version      VARCHAR(20),
  terms_accepted_at  TIMESTAMPTZ,
  status             VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','deleted')),
  locale             VARCHAR(10) NOT NULL DEFAULT 'es-MX',
  preferred_currency CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (preferred_currency IN ('MXN','USD')),
  last_login_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nightclub_id, email)
);
CREATE INDEX users_nightclub_role_idx ON users (nightclub_id, role);

CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  device_info TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_active_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

CREATE TABLE user_devices (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform   VARCHAR(10) NOT NULL CHECK (platform IN ('ios','android','web')),
  push_token TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, push_token)
);

CREATE TABLE audit_log (
  id           BIGSERIAL PRIMARY KEY,
  nightclub_id UUID REFERENCES nightclubs(id) ON DELETE SET NULL,
  actor_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  action       VARCHAR(100) NOT NULL,
  entity       VARCHAR(60) NOT NULL,
  entity_id    UUID,
  before       JSONB,
  after        JSONB,
  ip           INET,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id);
CREATE INDEX audit_log_nightclub_created_idx ON audit_log (nightclub_id, created_at);
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- Tables (floor layout)
-- ---------------------------------------------------------------------------
CREATE TABLE tables (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  code           VARCHAR(30) NOT NULL,
  name           VARCHAR(100),
  section        VARCHAR(40) NOT NULL DEFAULT 'main',
  type           VARCHAR(20) NOT NULL DEFAULT 'standard' CHECK (type IN ('standard','vip','premium','bar_top','booth')),
  capacity       INTEGER NOT NULL DEFAULT 4 CHECK (capacity > 0),
  x              NUMERIC(8,2) NOT NULL DEFAULT 0,
  y              NUMERIC(8,2) NOT NULL DEFAULT 0,
  radius         NUMERIC(8,2) NOT NULL DEFAULT 1,
  status         VARCHAR(20) NOT NULL DEFAULT 'available'
                 CHECK (status IN ('available','occupied','reserved','blocked','cleaning')),
  bottle_service BOOLEAN NOT NULL DEFAULT false,
  pos_table_id   VARCHAR(60),
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nightclub_id, code)
);
CREATE INDEX tables_nightclub_status_idx ON tables (nightclub_id, status);

CREATE TABLE table_occupants (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id   UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX table_occupants_one_open_per_user ON table_occupants (user_id) WHERE left_at IS NULL;
CREATE INDEX table_occupants_table_open_idx ON table_occupants (table_id) WHERE left_at IS NULL;

-- ---------------------------------------------------------------------------
-- Drinks, inventory, orders
-- ---------------------------------------------------------------------------
CREATE TABLE drinks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  name           VARCHAR(255) NOT NULL,
  category       VARCHAR(40) NOT NULL DEFAULT 'cocktail',
  price          NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  currency       CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  description    TEXT,
  image_url      TEXT,
  pos_product_id VARCHAR(60),
  available      BOOLEAN NOT NULL DEFAULT true,
  active         BOOLEAN NOT NULL DEFAULT true,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX drinks_pos_product_uidx ON drinks (nightclub_id, pos_product_id) WHERE pos_product_id IS NOT NULL;
CREATE INDEX drinks_nightclub_active_idx ON drinks (nightclub_id, active, available);

CREATE TABLE inventory (
  drink_id            UUID PRIMARY KEY REFERENCES drinks(id) ON DELETE CASCADE,
  quantity            NUMERIC(12,3) NOT NULL DEFAULT 0,
  unit                VARCHAR(20) NOT NULL DEFAULT 'unit',
  low_stock_threshold NUMERIC(12,3) NOT NULL DEFAULT 5,
  synced_at           TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE drink_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id      UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  sender_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recipient_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  table_id          UUID REFERENCES tables(id) ON DELETE SET NULL,
  bartender_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  message           TEXT,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','confirmed','preparing','ready','delivered','cancelled','pos_error')),
  subtotal          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  currency          CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  pos_order_id      VARCHAR(80),
  pos_error         TEXT,
  client_request_id UUID NOT NULL UNIQUE,
  confirmed_at      TIMESTAMPTZ,
  ready_at          TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX drink_orders_queue_idx ON drink_orders (nightclub_id, status, created_at);
CREATE INDEX drink_orders_sender_idx ON drink_orders (sender_id, created_at DESC);
CREATE INDEX drink_orders_recipient_idx ON drink_orders (recipient_id, created_at DESC);
CREATE INDEX drink_orders_pos_idx ON drink_orders (pos_order_id) WHERE pos_order_id IS NOT NULL;

CREATE TABLE drink_order_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID NOT NULL REFERENCES drink_orders(id) ON DELETE CASCADE,
  drink_id   UUID NOT NULL REFERENCES drinks(id) ON DELETE RESTRICT,
  quantity   INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  notes      TEXT
);
CREATE INDEX drink_order_items_order_idx ON drink_order_items (order_id);

-- ---------------------------------------------------------------------------
-- Flirt & safety
-- ---------------------------------------------------------------------------
CREATE TABLE user_preferences (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  accept_flirts BOOLEAN NOT NULL DEFAULT false,
  show_on_map   BOOLEAN NOT NULL DEFAULT true,
  notifications JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE flirts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  sender_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           VARCHAR(20) NOT NULL DEFAULT 'emoji' CHECK (type IN ('emoji','drink','bottle','meet')),
  emoji          VARCHAR(16),
  message        VARCHAR(280),
  drink_order_id UUID REFERENCES drink_orders(id) ON DELETE SET NULL,
  viewed_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX flirts_recipient_idx ON flirts (recipient_id, created_at DESC);
CREATE INDEX flirts_sender_rate_idx ON flirts (sender_id, created_at DESC);

CREATE TABLE flirt_reactions (
  flirt_id   UUID NOT NULL REFERENCES flirts(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction   VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (flirt_id, user_id)
);

CREATE TABLE user_blocks (
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE TABLE user_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  reporter_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason       VARCHAR(40) NOT NULL,
  details      TEXT,
  status       VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','actioned','dismissed')),
  reviewed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX user_reports_open_idx ON user_reports (nightclub_id, status);

-- ---------------------------------------------------------------------------
-- Finance: ledger, rates, withdrawals, payment methods
-- ---------------------------------------------------------------------------
CREATE TABLE exchange_rates (
  id             BIGSERIAL PRIMARY KEY,
  base           CHAR(3) NOT NULL DEFAULT 'USD',
  quote          CHAR(3) NOT NULL DEFAULT 'MXN',
  rate           NUMERIC(12,6) NOT NULL CHECK (rate > 0),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  source         VARCHAR(40) NOT NULL DEFAULT 'manual',
  set_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX exchange_rates_lookup_idx ON exchange_rates (base, quote, effective_from DESC);

CREATE TABLE transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id      UUID NOT NULL REFERENCES nightclubs(id) ON DELETE RESTRICT,
  type              VARCHAR(30) NOT NULL
                    CHECK (type IN ('drink_order','bottle_service','tip','song_request','reservation_deposit',
                                    'reservation_balance','refund','valet','withdrawal','adjustment')),
  direction         CHAR(3) NOT NULL CHECK (direction IN ('in','out')),
  amount            NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency          CHAR(3) NOT NULL CHECK (currency IN ('MXN','USD')),
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','pending_manual','paid','failed','refunded','cancelled')),
  payer_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  payee_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  provider          VARCHAR(20) NOT NULL DEFAULT 'manual'
                    CHECK (provider IN ('stripe','mercadopago','manual','pos','cash')),
  provider_ref      VARCHAR(120),
  reference_type    VARCHAR(30),
  reference_id      UUID,
  client_request_id UUID UNIQUE,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  confirmed_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transactions_nightclub_created_idx ON transactions (nightclub_id, created_at DESC);
CREATE INDEX transactions_reference_idx ON transactions (reference_type, reference_id);
CREATE INDEX transactions_payee_idx ON transactions (payee_user_id, status);
CREATE INDEX transactions_provider_ref_idx ON transactions (provider, provider_ref) WHERE provider_ref IS NOT NULL;

-- Ledger integrity: amounts/type/currency/parties are immutable; rows are never deleted.
CREATE OR REPLACE FUNCTION transactions_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency OR NEW.type <> OLD.type
     OR NEW.direction <> OLD.direction OR NEW.nightclub_id <> OLD.nightclub_id
     OR NEW.payer_user_id IS DISTINCT FROM OLD.payer_user_id
     OR NEW.payee_user_id IS DISTINCT FROM OLD.payee_user_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'transactions: immutable columns cannot be changed (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER transactions_guard BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION transactions_guard_update();
CREATE TRIGGER transactions_no_delete BEFORE DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE payment_methods (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       VARCHAR(20) NOT NULL CHECK (provider IN ('stripe','mercadopago','manual')),
  type           VARCHAR(20) NOT NULL CHECK (type IN ('card','apple_pay','google_pay','zelle','cash_app','bank','oxxo','spei')),
  provider_token TEXT,
  last4          VARCHAR(4),
  brand          VARCHAR(30),
  label          VARCHAR(60),
  is_default     BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_methods_user_idx ON payment_methods (user_id);

CREATE TABLE employee_profiles (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  employee_code VARCHAR(30),
  country       CHAR(2) NOT NULL DEFAULT 'MX' CHECK (country IN ('MX','US')),
  stage_name    VARCHAR(80),
  avatar_url    TEXT,
  hire_date     DATE,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE employee_bank_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  country           CHAR(2) NOT NULL CHECK (country IN ('MX','US')),
  type              VARCHAR(20) NOT NULL CHECK (type IN ('clabe','us_checking','us_savings')),
  bank_name         VARCHAR(80) NOT NULL,
  holder_name       VARCHAR(120) NOT NULL,
  account_encrypted BYTEA NOT NULL,
  account_last4     VARCHAR(4) NOT NULL,
  routing_encrypted BYTEA,
  is_default        BOOLEAN NOT NULL DEFAULT false,
  verified_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX employee_bank_accounts_user_idx ON employee_bank_accounts (user_id);

CREATE TABLE withdrawals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id    UUID NOT NULL REFERENCES nightclubs(id) ON DELETE RESTRICT,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  bank_account_id UUID REFERENCES employee_bank_accounts(id) ON DELETE SET NULL,
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency        CHAR(3) NOT NULL CHECK (currency IN ('MXN','USD')),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','rejected')),
  note            TEXT,
  reviewed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,
  transaction_id  UUID REFERENCES transactions(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX withdrawals_status_idx ON withdrawals (nightclub_id, status, created_at);

-- ---------------------------------------------------------------------------
-- Tips, staff drinks, song requests, shifts
-- ---------------------------------------------------------------------------
CREATE TABLE tips (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id      UUID NOT NULL REFERENCES nightclubs(id) ON DELETE RESTRICT,
  from_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  to_user_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount            NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency          CHAR(3) NOT NULL CHECK (currency IN ('MXN','USD')),
  message           VARCHAR(280),
  source            VARCHAR(10) NOT NULL DEFAULT 'app' CHECK (source IN ('app','qr')),
  transaction_id    UUID REFERENCES transactions(id) ON DELETE SET NULL,
  client_request_id UUID NOT NULL UNIQUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tips_to_user_idx ON tips (to_user_id, created_at DESC);
CREATE INDEX tips_nightclub_created_idx ON tips (nightclub_id, created_at DESC);

CREATE TABLE staff_drinks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  from_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  drink_id       UUID NOT NULL REFERENCES drinks(id) ON DELETE RESTRICT,
  drink_order_id UUID REFERENCES drink_orders(id) ON DELETE SET NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','declined')),
  confirmed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX staff_drinks_to_user_idx ON staff_drinks (to_user_id, status);

CREATE TABLE song_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  from_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  dj_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  song_title     VARCHAR(200) NOT NULL,
  artist         VARCHAR(200),
  message        VARCHAR(280),
  tip_amount     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tip_amount >= 0),
  currency       CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','played','declined')),
  played_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX song_requests_dj_idx ON song_requests (dj_user_id, status, created_at);

CREATE TABLE staff_shifts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section      VARCHAR(40),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX staff_shifts_one_open_per_user ON staff_shifts (user_id) WHERE ended_at IS NULL;

-- ---------------------------------------------------------------------------
-- Reservations
-- ---------------------------------------------------------------------------
CREATE TABLE reservation_rules (
  nightclub_id           UUID PRIMARY KEY REFERENCES nightclubs(id) ON DELETE CASCADE,
  min_party_size         INTEGER NOT NULL DEFAULT 2 CHECK (min_party_size > 0),
  max_party_size         INTEGER NOT NULL DEFAULT 20 CHECK (max_party_size >= min_party_size),
  deposit_pct            NUMERIC(5,2) NOT NULL DEFAULT 30.00 CHECK (deposit_pct BETWEEN 0 AND 100),
  base_price_per_hour    NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency               CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  min_advance_hours      INTEGER NOT NULL DEFAULT 2,
  max_duration_minutes   INTEGER NOT NULL DEFAULT 360,
  cancellation_windows   JSONB NOT NULL DEFAULT '[{"hours":48,"refund_pct":100},{"hours":24,"refund_pct":50},{"hours":0,"refund_pct":0}]'::jsonb,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reservation_discounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  code           VARCHAR(40) NOT NULL,
  description    TEXT,
  discount_type  VARCHAR(20) NOT NULL CHECK (discount_type IN ('percentage','fixed_amount')),
  discount_value NUMERIC(12,2) NOT NULL CHECK (discount_value > 0),
  valid_from     DATE,
  valid_until    DATE,
  max_uses       INTEGER,
  used_count     INTEGER NOT NULL DEFAULT 0,
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nightclub_id, code)
);

CREATE TABLE reservations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id     UUID NOT NULL REFERENCES nightclubs(id) ON DELETE RESTRICT,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  table_id         UUID NOT NULL REFERENCES tables(id) ON DELETE RESTRICT,
  starts_at        TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 180 CHECK (duration_minutes BETWEEN 30 AND 720),
  ends_at          TIMESTAMPTZ NOT NULL,  -- maintained by trigger: starts_at + duration
  guest_count      INTEGER NOT NULL CHECK (guest_count > 0),
  status           VARCHAR(20) NOT NULL DEFAULT 'pending_payment'
                   CHECK (status IN ('pending_payment','confirmed','seated','completed','cancelled','no_show')),
  currency         CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  total_estimated  NUMERIC(12,2) NOT NULL DEFAULT 0,
  deposit_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_id      UUID REFERENCES reservation_discounts(id) ON DELETE SET NULL,
  special_requests TEXT,
  cancelled_at     TIMESTAMPTZ,
  cancel_reason    TEXT,
  refund_amount    NUMERIC(12,2),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  -- No two live reservations may overlap on the same table.
  EXCLUDE USING gist (
    table_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('pending_payment','confirmed','seated'))
);

CREATE OR REPLACE FUNCTION reservations_set_ends_at() RETURNS trigger AS $$
BEGIN
  NEW.ends_at = NEW.starts_at + make_interval(mins => NEW.duration_minutes);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER reservations_ends_at BEFORE INSERT OR UPDATE OF starts_at, duration_minutes ON reservations
  FOR EACH ROW EXECUTE FUNCTION reservations_set_ends_at();
CREATE INDEX reservations_nightclub_starts_idx ON reservations (nightclub_id, starts_at);
CREATE INDEX reservations_user_idx ON reservations (user_id, starts_at DESC);

CREATE TABLE reservation_addons (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  addon_type     VARCHAR(30) NOT NULL CHECK (addon_type IN ('bottle_service','vip_upgrade','extra_hour','decorations','other')),
  name           VARCHAR(120) NOT NULL,
  price          NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  quantity       INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reservation_addons_reservation_idx ON reservation_addons (reservation_id);

-- ---------------------------------------------------------------------------
-- Safe departure (taxi) & valet
-- ---------------------------------------------------------------------------
CREATE TABLE emergency_contacts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  name         VARCHAR(100) NOT NULL,
  phone        VARCHAR(30) NOT NULL,
  type         VARCHAR(20) NOT NULL CHECK (type IN ('police','ambulance','fire','taxi','club_security','other')),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  active       BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE taxi_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id     UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pickup_location  VARCHAR(200),
  destination      VARCHAR(300),
  passengers       INTEGER NOT NULL DEFAULT 1 CHECK (passengers BETWEEN 1 AND 8),
  provider         VARCHAR(20) NOT NULL DEFAULT 'taxi' CHECK (provider IN ('taxi','uber','didi','club')),
  status           VARCHAR(20) NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','completed','cancelled')),
  conduct_code     CHAR(6),
  code_expires_at  TIMESTAMPTZ,
  confirmed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at     TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX taxi_requests_open_idx ON taxi_requests (nightclub_id, status, created_at);
CREATE UNIQUE INDEX taxi_requests_code_uidx ON taxi_requests (nightclub_id, conduct_code) WHERE conduct_code IS NOT NULL;

CREATE TABLE parking_spots (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  code         VARCHAR(20) NOT NULL,
  zone         VARCHAR(40),
  active       BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (nightclub_id, code)
);

CREATE TABLE valet_tickets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  code           VARCHAR(20) NOT NULL,
  user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  valet_in_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  valet_out_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  spot_id        UUID REFERENCES parking_spots(id) ON DELETE SET NULL,
  plate          VARCHAR(20) NOT NULL,
  vehicle_desc   VARCHAR(120),
  phone          VARCHAR(30),
  status         VARCHAR(20) NOT NULL DEFAULT 'parked' CHECK (status IN ('parked','requested','ready','delivered','cancelled')),
  fee            NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  currency       CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  rating         SMALLINT CHECK (rating BETWEEN 1 AND 5),
  checked_in_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  requested_at   TIMESTAMPTZ,
  ready_at       TIMESTAMPTZ,
  delivered_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nightclub_id, code)
);
CREATE INDEX valet_tickets_active_idx ON valet_tickets (nightclub_id, status);
CREATE UNIQUE INDEX valet_tickets_spot_in_use_uidx ON valet_tickets (spot_id) WHERE status IN ('parked','requested','ready');

-- ---------------------------------------------------------------------------
-- Pricing, POS integration, events
-- ---------------------------------------------------------------------------
CREATE TABLE pricing_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id    UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  name            VARCHAR(100) NOT NULL,
  applies_to      VARCHAR(20) NOT NULL CHECK (applies_to IN ('table_type','section','drink_category','reservation')),
  target          VARCHAR(60),
  days_of_week    SMALLINT[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  time_from       TIME,
  time_to         TIME,
  date_from       DATE,
  date_to         DATE,
  adjustment_type VARCHAR(20) NOT NULL CHECK (adjustment_type IN ('multiplier','fixed','override')),
  value           NUMERIC(12,4) NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 100,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pricing_rules_lookup_idx ON pricing_rules (nightclub_id, applies_to, active);

CREATE TABLE pos_integrations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id          UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  provider              VARCHAR(30) NOT NULL DEFAULT 'softrestaurant11',
  mode                  VARCHAR(10) NOT NULL DEFAULT 'agent' CHECK (mode IN ('agent','api','mock')),
  credentials_encrypted BYTEA,
  agent_key_hash        TEXT,
  config                JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                VARCHAR(20) NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive','active','error')),
  last_seen_at          TIMESTAMPTZ,
  last_error            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nightclub_id, provider)
);

CREATE TABLE pos_sync_log (
  id           BIGSERIAL PRIMARY KEY,
  nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  kind         VARCHAR(20) NOT NULL CHECK (kind IN ('menu','inventory','orders','status','tables')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  ok           BOOLEAN,
  items_synced INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
CREATE INDEX pos_sync_log_recent_idx ON pos_sync_log (nightclub_id, started_at DESC);

CREATE TABLE events (
  id           BIGSERIAL PRIMARY KEY,
  nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  type         VARCHAR(40) NOT NULL,
  audience     JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_nightclub_id_idx ON events (nightclub_id, id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'nightclubs','users','tables','drinks','inventory','drink_orders','user_preferences','transactions',
    'payment_methods','employee_profiles','employee_bank_accounts','withdrawals','reservation_rules',
    'reservations','taxi_requests','valet_tickets','pricing_rules','pos_integrations'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
