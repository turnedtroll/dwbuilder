import { canon, zeroFlat, pointsSpent, powerFor, pointsForPower, ALL_STATS, BASE_STATS, ATTUNEMENTS, WEAPON_STATS } from "./stats.js";
import { shrineOfOrder } from "./shrine.js";
import { resolveTalent } from "./validate.js";

const REQ_DEFAULTS = {
  role: "dps",
  include_attunements: [],
  exclude_attunements: [],
  attunementless: false,
  weapon_type: null,
  weapon: null,
  oath: null,
  origin: null,
  race: null,
  shrine: true,
  multifaceted: false,
  must_talents: [],
  avoid_talents: [],
  must_mantras: [],
  avoid_mantras: [],
  free_text: "",
};

const IGNORE_REQ_KEYS = new Set(["Power", "Body", "Mind", "Weapon", "Weapons", "Attunement"]);

// §2.1: fill request defaults. Array/object defaults are fresh per call so callers never share references.
export function normalizeRequest(partial) {
  const p = partial ?? {};
  const req = { ...REQ_DEFAULTS };
  for (const key of Object.keys(REQ_DEFAULTS)) {
    if (p[key] !== undefined) req[key] = p[key];
  }
  return req;
}

function topWeaponStat(a) {
  let best = WEAPON_STATS[0], bestVal = -1;
  for (const w of WEAPON_STATS) {
    const v = a.post_shrine_modal[w] ?? 0;
    if (v > bestVal) { bestVal = v; best = w; }
  }
  return best;
}

function scoreArchetype(req, a) {
  let score = 100;
  for (const exRaw of req.exclude_attunements) {
    const ex = canon(exRaw) ?? exRaw;
    if ((a.post_shrine_modal[ex] ?? 0) >= 20) score -= 30;
  }
  for (const incRaw of req.include_attunements) {
    const inc = canon(incRaw) ?? incRaw;
    if ((a.post_shrine_modal[inc] ?? 0) >= 20) score += 20;
  }
  if (req.weapon_type === "none") {
    if (WEAPON_STATS.every(w => (a.post_shrine_modal[w] ?? 0) < 40)) score += 15;
  } else if (req.weapon_type) {
    const w = canon(req.weapon_type) ?? req.weapon_type;
    if (topWeaponStat(a) === w) score += 15;
  }
  if (req.oath && a.oath?.[0]?.[0] === req.oath) score += 10;
  score += Math.log10(Math.max(1, a.views_total ?? 1));
  return score;
}

// candidates with role === req.role (fallback: all); highest-scoring wins.
export function selectArchetype(req, archetypes) {
  let candidates = archetypes.filter(a => a.role === req.role);
  if (candidates.length === 0) candidates = archetypes;

  let best = null, bestScore = -Infinity;
  for (const a of candidates) {
    const s = scoreArchetype(req, a);
    if (s > bestScore) { bestScore = s; best = a; }
  }

  const adapted =
    req.include_attunements.some(inc => (best.post_shrine_modal[canon(inc) ?? inc] ?? 0) < 20) ||
    req.exclude_attunements.some(ex => (best.post_shrine_modal[canon(ex) ?? ex] ?? 0) >= 20);

  return { archetype: best, adapted };
}

// Reduce non-stack stats proportionally toward `floor` (used when pre overshoots the budget ceiling).
// Pure: returns a new object, never mutates `pre`.
function reduceTowardFloor(pre, floor, stackStat, ceiling) {
  const out = { ...pre };
  let pts = pointsSpent(out);
  let guard = 100000;
  while (pts > ceiling && guard-- > 0) {
    let bestStat = null, bestSlack = 0;
    for (const s of ALL_STATS) {
      if (s === stackStat) continue;
      const slack = out[s] - (floor[s] ?? 0);
      if (slack > bestSlack) { bestSlack = slack; bestStat = s; }
    }
    if (!bestStat) break;
    out[bestStat] -= 1;
    pts = pointsSpent(out);
  }
  return out;
}

// Raise pre-shrine points up toward `budget` in the order the ruling specifies:
// 1. the stack stat up to min(stack.modal, 100)
// 2. every other stat with target[s] > 0, proportionally toward target[s] (capped at target[s] and 100)
// 3. the stack stat up toward 100
// "Proportionally" is implemented as a deterministic greedy unit-step: each iteration adds one point
// to whichever eligible stat currently has the largest remaining gap to its cap. Over many iterations
// this converges to (and never overshoots) a proportional split of the deficit across the gaps.
// Pure: returns a new object, never mutates `pre`.
function raiseTowardBudget(pre, budget, target, stack) {
  const out = { ...pre };
  let pts = pointsSpent(out);
  let deficit = budget - pts;
  if (deficit <= 0) return out;

  const cap1 = Math.min(stack.modal, 100);
  let guard = 100000;
  while (deficit > 0 && out[stack.stat] < cap1 && guard-- > 0) {
    out[stack.stat] += 1;
    const newPts = pointsSpent(out);
    deficit -= (newPts - pts);
    pts = newPts;
  }

  guard = 100000;
  while (deficit > 0 && guard-- > 0) {
    let bestStat = null, bestGap = 0;
    for (const s of ALL_STATS) {
      if (s === stack.stat) continue;
      if (!((target[s] ?? 0) > 0)) continue;
      const cap = Math.min(target[s], 100);
      const gap = cap - out[s];
      if (gap > bestGap) { bestGap = gap; bestStat = s; }
    }
    if (!bestStat) break;
    out[bestStat] += 1;
    const newPts = pointsSpent(out);
    deficit -= (newPts - pts);
    pts = newPts;
  }

  guard = 100000;
  while (deficit > 0 && out[stack.stat] < 100 && guard-- > 0) {
    out[stack.stat] += 1;
    const newPts = pointsSpent(out);
    deficit -= (newPts - pts);
    pts = newPts;
  }

  return out;
}

// Two-sided fit of pre-shrine stats toward the power budget B = pointsForPower(clamp(shrine_power_modal, 8, 19)).
// Accepts pointsSpent(pre) in [budget, budget + 14]; only reduces down to `floor`, only raises using `target`/`stack`.
// Pure helper, kept separate from fitTo330 per the ruling.
export function fitPreToBudget(pre, budget, floor, target, stack) {
  const ceiling = budget + 14;
  const pts = pointsSpent(pre);
  if (pts > ceiling) return reduceTowardFloor(pre, floor, stack.stat, ceiling);
  if (pts < budget) return raiseTowardBudget(pre, budget, target, stack);
  return { ...pre };
}

// §Step 8: fit `target` to exactly 330 points. Pure: returns a new object, never mutates inputs.
// Returns { final, raised } — `raised` lists every stat pushed up under ruling rules 1-2 (phases B/C
// below), as {stat, from, to, phase}, so callers can build notes from what actually happened instead
// of re-deriving it from p75 (a stat can be raised under rule 1/2 without ever crossing its own p75 —
// e.g. a phase-C base stat introduced from 0 that only needed a few points before 330 was reached).
export function fitTo330(target, floor, priority, spread, stackStat) {
  const out = { ...target };
  const isPriority = s => priority.has(s);
  let pts = pointsSpent(out);

  let guard = 100000;
  while (pts > 330 && guard-- > 0) {
    let bestStat = null, bestSlack = 0;
    for (const s of ALL_STATS) {
      if (isPriority(s)) continue;
      const slack = out[s] - (floor[s] ?? 0);
      if (slack > bestSlack) { bestSlack = slack; bestStat = s; }
    }
    if (bestStat) { out[bestStat] -= 1; pts = pointsSpent(out); continue; }

    // every non-priority stat is at its floor: decrement the largest priority slack instead
    let pBest = null, pSlack = 0;
    for (const s of ALL_STATS) {
      if (!isPriority(s)) continue;
      const slack = out[s] - (floor[s] ?? 0);
      if (slack > pSlack) { pSlack = slack; pBest = s; }
    }
    if (pBest) { out[pBest] -= 1; pts = pointsSpent(out); continue; }
    break;
  }
  if (pts > 330) throw new Error(`cannot fit to 330 points: stuck at ${pts} with every stat at its floor`);

  // Phase A: raise stats with target > 0 up toward their own p75 (largest gap first).
  guard = 100000;
  while (pts < 330 && guard-- > 0) {
    let bestStat = null, bestGap = 0;
    for (const s of ALL_STATS) {
      if (!(out[s] > 0)) continue;
      const p75 = spread?.[s]?.p75 ?? 0;
      const gap = Math.min(p75, 100) - out[s];
      if (gap > bestGap) { bestGap = gap; bestStat = s; }
    }
    if (!bestStat) break;
    out[bestStat] += 1;
    pts = pointsSpent(out);
  }

  const raised = [];

  // Phase B (ruling rule 1): every target > 0 stat is at (or past) its p75 but still short of 330 —
  // the archetype's per-stat modal data is too sparse (dump stats vary too much to have a mode). Keep
  // raising the stats the archetype actually invests in, beyond p75 toward 100, largest p75 first
  // (ties: ALL_STATS order).
  if (pts < 330) {
    const order = ALL_STATS
      .map((s, i) => ({ s, i, p75: spread?.[s]?.p75 ?? 0 }))
      .filter(x => out[x.s] > 0)
      .sort((a, b) => b.p75 - a.p75 || a.i - b.i);
    for (const { s } of order) {
      const from = out[s];
      while (pts < 330 && out[s] < 100) { out[s] += 1; pts = pointsSpent(out); }
      if (out[s] > from) raised.push({ stat: s, from, to: out[s], phase: 1 });
      if (pts >= 330) break;
    }
  }

  // Phase C (ruling rule 2): still short with every invested stat at 100 — spill into untouched
  // BASE_STATS (never an attunement or weapon stat: that would change the build's identity), largest
  // p75 first.
  if (pts < 330) {
    const order = BASE_STATS
      .map((s, i) => ({ s, i, p75: spread?.[s]?.p75 ?? 0 }))
      .filter(x => out[x.s] === 0)
      .sort((a, b) => b.p75 - a.p75 || a.i - b.i);
    for (const { s } of order) {
      const from = out[s];
      while (pts < 330 && out[s] < 100) { out[s] += 1; pts = pointsSpent(out); }
      if (out[s] > from) raised.push({ stat: s, from, to: out[s], phase: 2 });
      if (pts >= 330) break;
    }
  }

  if (pts < 330) throw new Error(`cannot fit to 330 points: stuck at ${pts} even after using every base stat`);
  return { final: out, raised };
}

function applyReqs(reqs, target, mustMin) {
  for (const [k, v] of Object.entries(reqs ?? {})) {
    if (IGNORE_REQ_KEYS.has(k)) continue;
    const c = canon(k);
    if (!c) continue;
    const val = Number(v);
    target[c] = Math.max(target[c] ?? 0, val);
    mustMin[c] = Math.max(mustMin[c] ?? 0, val);
  }
}

export function planStats(req, archetype, game) {
  const a = archetype;
  const notes = [];

  // 1. race + racial bonus
  const race = req.race ?? (a.race?.[0]?.[0] ?? "None");
  const multifaceted = !!req.multifaceted;
  const bonus = multifaceted ? {} : (game.races[race] ?? {});

  // 2. seed target/pre from the archetype's modal spreads
  const target = { ...zeroFlat(), ...a.post_shrine_modal };
  const preSeed = { ...zeroFlat(), ...a.pre_shrine_modal };
  const preAllZero = ALL_STATS.every(s => (preSeed[s] ?? 0) === 0);
  let pre = null;
  if (a.shrined_rate < 0.3) notes.push("pre-shrine skipped: shrined_rate below 0.3");
  else if (!req.shrine) notes.push("pre-shrine skipped: shrine disabled by request");
  else if (preAllZero) notes.push("pre-shrine skipped: no pre-shrine data for this archetype");
  else pre = preSeed;

  // 3. excludes / attunementless / includes
  for (const exRaw of req.exclude_attunements) {
    const ex = canon(exRaw) ?? exRaw;
    target[ex] = 0;
    if (pre) pre[ex] = 0;
    notes.push(`${ex} removed`);
  }
  if (req.attunementless) {
    for (const at of ATTUNEMENTS) { target[at] = 0; if (pre) pre[at] = 0; }
    notes.push("attunementless: all attunements removed");
  }
  for (const incRaw of req.include_attunements) {
    const inc = canon(incRaw) ?? incRaw;
    if ((target[inc] ?? 0) < 20) {
      target[inc] = 40;
      if (pre) pre[inc] = Math.max(pre[inc] ?? 0, 1);
      notes.push(`${inc} added at 40`);
    }
  }

  // 4. weapon
  if (req.weapon_type === "none") {
    for (const w of WEAPON_STATS) { target[w] = 0; if (pre) pre[w] = 0; }
    notes.push("weapon removed: all weapon stats zeroed");
  } else if (req.weapon_type) {
    const w = canon(req.weapon_type) ?? req.weapon_type;
    for (const other of WEAPON_STATS) if (other !== w) { target[other] = 0; if (pre) pre[other] = 0; }
    target[w] = Math.max(target[w] ?? 0, 65);
    if (pre) pre[w] = Math.max(pre[w] ?? 0, 1);
    notes.push(`${w} set as weapon (target ${target[w]})`);
  }

  // 5. must-haves (resolve corpus/user spelling before reading game.json)
  const mustMin = zeroFlat();
  for (const tName of req.must_talents) {
    const resolved = resolveTalent(tName, game);
    if (!resolved) { notes.push(`unknown talent ${tName} ignored`); continue; }
    applyReqs(game.talents[resolved]?.reqs, target, mustMin);
  }
  for (const mName of req.must_mantras) {
    const m = game.mantras[mName];
    if (!m) { notes.push(`unknown mantra ${mName} ignored`); continue; }
    applyReqs(m.reqs, target, mustMin);
  }

  // 6. stack minimum + racial bonus floors
  if (pre) pre[a.stack.stat] = Math.max(pre[a.stack.stat] ?? 0, a.stack.min);
  for (const [s, v] of Object.entries(bonus)) {
    if (pre) pre[s] = Math.max(pre[s] ?? 0, v);
    target[s] = Math.max(target[s] ?? 0, v);
  }
  if (pre) for (const s of ALL_STATS) if (target[s] > 0) pre[s] = Math.max(pre[s] ?? 0, 1);

  // 7. shrine: fit pre to the power-budget window, derive shrine base, raise target to meet it
  let shrineBase = null, shrinePower = null;
  if (pre) {
    const budget = pointsForPower(Math.max(8, Math.min(19, a.shrine_power_modal)));
    const floor = {};
    for (const s of ALL_STATS) floor[s] = Math.max(0, bonus[s] ?? 0, target[s] > 0 ? 1 : 0);

    pre = fitPreToBudget(pre, budget, floor, target, a.stack);
    const pts = pointsSpent(pre);
    if (pts > budget + 14) notes.push("pre-shrine points exceed the target power");
    else if (pts < budget) notes.push("pre-shrine points remain under the target power budget");

    shrineBase = shrineOfOrder(pre, bonus).base;
    for (const s of ALL_STATS) target[s] = Math.max(target[s] ?? 0, shrineBase[s] ?? 0);
    shrinePower = powerFor(pre);
  }

  // 8. fit final target to exactly 330 points
  const priority = new Set([a.stack.stat]);
  for (const s of ALL_STATS) if (mustMin[s] > 0) priority.add(s);
  for (const incRaw of req.include_attunements) priority.add(canon(incRaw) ?? incRaw);

  const floor330 = {};
  for (const s of ALL_STATS) {
    const stackFloor = s === a.stack.stat ? Math.min(target[s] ?? 0, a.stack.modal - 25) : 0;
    floor330[s] = Math.max(0, shrineBase?.[s] ?? 0, bonus[s] ?? 0, mustMin[s] ?? 0, stackFloor);
  }

  let fit;
  try {
    fit = fitTo330(target, floor330, priority, a.post_shrine_spread, a.stack.stat);
  } catch (e) {
    throw new Error(`${a.id}: ${e.message}`);
  }
  const final = fit.final;

  // fitTo330 reports exactly which stats it raised under ruling rules 1-2 (beyond p75, or off of 0)
  // to close a gap the archetype's sparse per-stat modal data left in the 330-point budget; record
  // every one, regardless of whether the resulting value happens to cross that stat's own p75.
  for (const r of fit.raised) notes.push(`${r.stat} raised to ${r.to} to reach 330`);

  return { preShrine: pre, shrinePower, shrineBase, final, race, multifaceted, notes };
}
