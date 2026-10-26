// ===== Server copy of tracker state (subscribers only) =====
import { Router } from 'express';
import { tx, query } from '../db.js';
import { HttpError, requireSession, requireActive } from '../auth.js';

const router = Router();
router.use('/trackers', requireSession, requireActive);

const toClient = (r) => ({
  id: Number(r.id), target: Number(r.target), hits: r.hits, roundsSince: r.rounds_since,
  projection: r.projection, scores: r.scores,
});

router.get('/trackers', async (req, res) => {
  const { rows } = await query('SELECT * FROM trackers WHERE user_id = $1 ORDER BY position', [req.user.id]);
  res.json({ trackers: rows.map(toClient) });
});

/** Replace the full tracker list (last write wins). */
router.put('/trackers', async (req, res) => {
  const list = req.body?.trackers;
  if (!Array.isArray(list) || list.length > 200) throw new HttpError(400, 'bad_trackers', 'Invalid tracker data');
  for (const t of list) {
    if (!Number.isSafeInteger(t?.id) || !(t.target > 1) || !Array.isArray(t.hits) || !Array.isArray(t.scores)
      || !Number.isInteger(t.roundsSince) || t.roundsSince < 0) {
      throw new HttpError(400, 'bad_trackers', 'Invalid tracker data');
    }
  }
  await tx(async (c) => {
    await c.query('DELETE FROM trackers WHERE user_id = $1 AND NOT (id = ANY($2::bigint[]))', [req.user.id, list.map((t) => t.id)]);
    for (const [i, t] of list.entries()) {
      await c.query(
        `INSERT INTO trackers (user_id, id, target, hits, rounds_since, projection, scores, position, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (user_id, id) DO UPDATE SET target = EXCLUDED.target, hits = EXCLUDED.hits,
           rounds_since = EXCLUDED.rounds_since, projection = EXCLUDED.projection, scores = EXCLUDED.scores,
           position = EXCLUDED.position, updated_at = now()`,
        [req.user.id, t.id, Math.round(t.target * 100) / 100, JSON.stringify(t.hits), t.roundsSince,
          t.projection ? JSON.stringify(t.projection) : null, JSON.stringify(t.scores), i]);
    }
  });
  res.json({ ok: true });
});

export default router;
