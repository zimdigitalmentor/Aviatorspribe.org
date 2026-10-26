// ===== Rendering =====
import { pRound, pWithin, medianGap, xClass } from './math.js';
import { fmtX, cX, pct, fmtClock, fmtDur } from './format.js';

function predictionBox(tr) {
  const pj = tr.projection; if (!pj) return '';
  const x = tr.target, p = pRound(x);
  const n = pj.dueRounds || Math.round(1 / p);
  return `
    <div class="result">
      <h3>Next round prediction</h3>
      <p class="big">${fmtClock(pj.dueTime)}</p>
      ${pj.dueRounds ? `<p>Prediction: next ${cX(x)} after <b>${pj.dueRounds} rounds</b></p>` : ''}
      <div class="truth">
        <p><b>Aviator logic says:</b> each round has a ${pct(p)} chance of reaching ${cX(x)}, no matter when it last appeared.</p>
        <p>Chance of at least one ${cX(x)} within the next ${n} rounds: <b>${pct(pWithin(x, n))}</b>.</p>
        <p>Half of all gaps are ${medianGap(x)} rounds or fewer; long droughts are normal.</p>
      </div>
      <p style="margin-top:8px">Log the next hit and the app will score this prediction.</p>
    </div>`;
}

function scoreBox(tr) {
  if (!tr.scores.length) return '';
  const wins = tr.scores.filter((s) => s.ok).length;
  const pills = tr.scores.slice(-10)
    .map((s) => `<span class="pill ${s.ok ? 'y' : 'n'}" title="${s.detail}">${s.ok ? 'Hit' : 'Miss'}</span>`).join('');
  return `<div class="score"><b>Prediction accuracy: ${wins} of ${tr.scores.length} (${pct(wins / tr.scores.length)})</b><br>${pills}</div>`;
}

function hitList(tr) {
  const n = tr.hits.length; if (!n) return '';
  const items = tr.hits.slice(-5).map((h, i, arr) => {
    const idx = n - arr.length + i + 1;
    const gap = h.rounds ? `${h.rounds} rounds after previous` : idx === 1 ? 'first hit' : '';
    return `<li><span><b>Hit ${idx}</b> at ${fmtClock(h.t)}</span><span>${gap}</span></li>`;
  }).join('');
  return `<ul class="hits">${items}</ul>`;
}

function card(tr) {
  const x = tr.target, n = tr.hits.length, last = tr.hits[n - 1];
  return `
  <article class="tracker" data-id="${tr.id}">
    <div class="thead">
      <span class="target ${xClass(x)}">${fmtX(x)}</span>
      <span class="odds">${pct(pRound(x))} chance per round</span>
    </div>
    ${last ? `<div class="since">Since last hit: <b data-since="${last.t}">${fmtDur(Date.now() - last.t)}</b> · <b>${tr.roundsSince}</b> rounds counted</div>` : ''}
    <div class="row">
      <button class="btn btn-hit" data-act="hit">${fmtX(x)} reached — log hit</button>
      <button class="btn" data-act="round" ${n ? '' : 'disabled'}>Round passed, no hit</button>
    </div>
    <div class="row">
      <button class="btn btn-primary" data-act="calc" ${n >= 2 && !tr.projection ? '' : 'disabled'}>Calculate</button>
    </div>
    ${n < 2 ? `<p class="since">Log ${2 - n} more hit${n === 1 ? '' : 's'} to calculate.</p>` : ''}
    ${predictionBox(tr)}
    ${scoreBox(tr)}
    ${hitList(tr)}
    <div class="row links">
      ${n ? '<button class="btn-link" data-act="undo">Undo last hit</button>' : ''}
      <button class="btn-link" data-act="delete">Delete tracker</button>
    </div>
  </article>`;
}

export function render(state) {
  const list = document.getElementById('list');
  list.innerHTML = state.length
    ? state.map(card).join('')
    : '<p class="empty">Add a target multiplier above to start logging when it appears.</p>';
}

/** Update the live "since last hit" clocks without re-rendering. */
export function tickClocks() {
  document.querySelectorAll('[data-since]').forEach((el) => {
    el.textContent = fmtDur(Date.now() - +el.dataset.since);
  });
}
