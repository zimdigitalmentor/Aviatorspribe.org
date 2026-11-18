-- Access granted by an admin (e.g. paid in cash) to an email that has not signed in yet.
-- Applied as a subscription on that account's first sign-in.
CREATE TABLE pending_grants (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL,
  days        integer NOT NULL CHECK (days BETWEEN 1 AND 366),
  created_at  timestamptz NOT NULL DEFAULT now(),
  applied_at  timestamptz,
  applied_to  uuid REFERENCES users(id)
);
CREATE INDEX pending_grants_open ON pending_grants (lower(email)) WHERE applied_at IS NULL;
