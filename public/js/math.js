// ===== Aviator logic: probability maths =====
// Each round reaches multiplier x with probability ≈ EDGE / x (≈3% house edge).

export const EDGE = 0.97;

/** Chance a single round reaches x. */
export const pRound = (x) => Math.min(1, EDGE / x);

/** Chance of at least one round reaching x within n rounds. */
export const pWithin = (x, n) => 1 - Math.pow(1 - pRound(x), Math.max(0, n));

/** Number of rounds within which half of all gaps fall. */
export const medianGap = (x) => {
  const p = pRound(x);
  return p >= 1 ? 1 : Math.ceil(Math.log(0.5) / Math.log(1 - p));
};

/** Average number of rounds between hits. */
export const meanGap = (x) => 1 / pRound(x);

/** Colour class matching the game's round history. */
export const xClass = (x) => (x >= 10 ? 'x-pink' : x >= 2 ? 'x-purple' : 'x-blue');
