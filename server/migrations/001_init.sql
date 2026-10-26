-- Accounts, devices, plans, payments, subscriptions and synced trackers.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub    text NOT NULL UNIQUE,
  email         text NOT NULL,
  name          text,
  picture_url   text,
  saved_phone   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now()
);

-- A device is a non-extractable WebCrypto key pair; id = SHA-256 of its public JWK.
CREATE TABLE devices (
  id             text PRIMARY KEY,                        -- PK: one account per device
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key_jwk jsonb NOT NULL,
  label          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);
-- One active device per account
CREATE UNIQUE INDEX devices_one_active_per_user ON devices (user_id) WHERE revoked_at IS NULL;

CREATE TABLE device_transfers (
  id             bigserial PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_device_id text,
  to_device_id   text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_transfers_user ON device_transfers (user_id, created_at DESC);

CREATE TABLE auth_challenges (
  nonce      text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

CREATE TABLE plans (
  id            serial PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  price_usd     numeric(10,2) NOT NULL CHECK (price_usd > 0),
  duration_days integer NOT NULL CHECK (duration_days > 0),
  active        boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0
);
INSERT INTO plans (code, name, price_usd, duration_days, sort_order) VALUES ('monthly', 'Monthly', 10.00, 30, 1);

CREATE TABLE payments (
  id               bigserial PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id),
  plan_id          integer NOT NULL REFERENCES plans(id),
  reference        text NOT NULL UNIQUE,
  method           text NOT NULL,
  amount_usd       numeric(10,2) NOT NULL,
  phone            text,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'paid', 'failed', 'cancelled', 'expired')),
  paynow_reference text,
  poll_url         text,
  browser_url      text,
  innbucks_code    text,
  innbucks_expires text,
  raw_last_update  jsonb,
  error            text,
  last_polled_at   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  paid_at          timestamptz
);
CREATE INDEX payments_status_created ON payments (status, created_at);
CREATE INDEX payments_user ON payments (user_id, created_at DESC);

CREATE TABLE subscriptions (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id),
  plan_id    integer NOT NULL REFERENCES plans(id),
  payment_id bigint REFERENCES payments(id) UNIQUE,  -- blocks double-crediting
  starts_at  timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_user_expiry ON subscriptions (user_id, expires_at);

-- Server copy of each tracker; id is the client-generated id.
CREATE TABLE trackers (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id           bigint NOT NULL,
  target       numeric(10,2) NOT NULL,
  hits         jsonb NOT NULL DEFAULT '[]',
  rounds_since integer NOT NULL DEFAULT 0,
  projection   jsonb,
  scores       jsonb NOT NULL DEFAULT '[]',
  position     integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
