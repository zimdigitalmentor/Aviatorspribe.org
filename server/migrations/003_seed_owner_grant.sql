-- Seed a free 30-day monthly grant for the owner account.
-- Runs once per database on startup (migrate()), so a fresh deploy or a new
-- environment automatically gives this email a free month, applied as a
-- subscription on their first Google sign-in (see upsertUser / pending_grants).
-- Guarded so it never stacks a second open grant on a DB that already has one.
INSERT INTO pending_grants (email, days)
SELECT 'dumbumaxwell31@gmail.com', 30
WHERE NOT EXISTS (
  SELECT 1 FROM pending_grants
  WHERE lower(email) = 'dumbumaxwell31@gmail.com' AND applied_at IS NULL
);
