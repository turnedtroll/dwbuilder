import { canon, zeroFlat, pointsSpent, powerFor, pointsForPower, meetsStats, ALL_STATS, BASE_STATS, ATTUNEMENTS, WEAPON_STATS } from "./stats.js";
import { shrineOfOrder } from "./shrine.js";
import { resolveTalent, talentObtainable, mantraUsage, mantraLoadout, talentBudget, isCountingMantra, mantraPathWhy, WARDER_CATEGORY, validate } from "./validate.js";
import { scoreBuild } from "./score.js";
import { toDraft } from "./convert.js";

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
  // An explicitly requested oath is a strong identity signal, not a minor tiebreaker: the oath
  // brings its own must-have mantras/talents (e.g. Linkstrider's healer kit), so it should outweigh
  // a single include-attunement match (+20) or the weapon-type match (+15). Weighted at +30 so a
  // requested oath's archetype wins over a same-role archetype that only matches attunement/weapon.
  if (req.oath && a.oath?.[0]?.[0] === req.oath) score += 30;
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

// Weighted round-robin (highest-averages / Jefferson apportionment): repeatedly grants the next unit
// to whichever eligible stat maximizes weight[s] / (1 + unitsGrantedSoFar[s]). This is a standard,
// well-behaved deterministic way to split a fixed number of discrete increments across stats in
// proportion to `weight`, without overshooting any cap. Mutates `out` in place; returns the deficit
// still unpaid once every eligible stat has reached its cap (or the deficit hits 0).
function proportionalRaise(out, weight, capOf, deficit) {
  const granted = {};
  for (const s of Object.keys(weight)) granted[s] = 0;
  let guard = 200000;
  while (deficit > 0 && guard-- > 0) {
    let bestStat = null, bestScore = -Infinity;
    for (const s of Object.keys(weight)) {
      if (out[s] >= capOf(s)) continue;
      const score = weight[s] / (1 + granted[s]);
      if (score > bestScore) { bestScore = score; bestStat = s; }
    }
    if (!bestStat) break;
    const before = pointsSpent(out);
    out[bestStat] += 1;
    granted[bestStat] += 1;
    deficit -= (pointsSpent(out) - before);
  }
  return deficit;
}

// Raise pre-shrine points up toward `budget` per R8 rule 3:
// (a) stats with pre[s] > 1 (already invested, not excluded/zeroed), proportionally to their current
//     pre value, capped at 100 (the stack stat) or min(100, target[s]) (every other stat);
// (b) if still under, every other stat with target[s] > 0, proportionally toward target[s];
// (c) if still under, the stack stat up toward 100.
// Pure: returns a new object, never mutates `pre`.
function raiseTowardBudget(pre, budget, target, stack) {
  const out = { ...pre };
  let deficit = budget - pointsSpent(out);
  if (deficit <= 0) return out;

  const weightA = {};
  for (const s of ALL_STATS) if (out[s] > 1) weightA[s] = out[s];
  const capA = s => (s === stack.stat ? 100 : Math.min(100, target[s] ?? 0));
  deficit = proportionalRaise(out, weightA, capA, deficit);

  if (deficit > 0) {
    const weightB = {};
    for (const s of ALL_STATS) if (s !== stack.stat && (target[s] ?? 0) > 0) weightB[s] = target[s];
    const capB = s => Math.min(100, target[s] ?? 0);
    deficit = proportionalRaise(out, weightB, capB, deficit);
  }

  if (deficit > 0) {
    let pts = pointsSpent(out);
    let guard = 100000;
    while (deficit > 0 && out[stack.stat] < 100 && guard-- > 0) {
      out[stack.stat] += 1;
      const newPts = pointsSpent(out);
      deficit -= (newPts - pts);
      pts = newPts;
    }
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
    const before = target[inc] ?? 0;
    // An explicitly requested attunement is a build feature the user wants front and center, not
    // just "not excluded" — 40 is the floor for it regardless of whether the archetype's own modal
    // happens to already sit a little above 0 (e.g. 21-39): a barely-invested archetype value isn't
    // evidence the user wants less than the requested-attunement floor.
    if (before < 40) {
      target[inc] = 40;
      if (pre) pre[inc] = Math.max(pre[inc] ?? 0, 1);
      notes.push(`${inc} added at 40`);
    }
  }

  // 4. weapon. A weapon the request names decides the weapon type and its own requirements are
  // hard floors (planned exactly like the oath's), so the build always meets the weapon it wields.
  const reqWeapon = req.weapon ? game.weapons[req.weapon] : null;
  if (reqWeapon && !req.weapon_type && reqWeapon.wtype) req = { ...req, weapon_type: reqWeapon.wtype };
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
  // R7: kept as three separate per-source floors (rather than one combined mustMin) so a
  // budget-infeasible combination can be relaxed one source at a time in step 8 instead of throwing.
  const mustMinMantras = zeroFlat();
  const mustMinTalents = zeroFlat();
  const mustMinOath = zeroFlat();
  for (const tName of req.must_talents) {
    const resolved = resolveTalent(tName, game);
    if (!resolved) { notes.push(`unknown talent ${tName} ignored`); continue; }
    applyReqs(game.talents[resolved]?.reqs, target, mustMinTalents);
  }
  for (const mName of req.must_mantras) {
    const m = game.mantras[mName];
    if (!m) { notes.push(`unknown mantra ${mName} ignored`); continue; }
    applyReqs(m.reqs, target, mustMinMantras);
  }
  // R2: the resolved oath (see resolveOath in assemble()) is a must-have exactly like a must talent -
  // its own stat reqs must raise target/mustMin so the plan actually reaches them, not just the
  // prerequisite talents pickTalents prioritizes for it below.
  if (req.oath && req.oath !== "None") applyReqs(game.talents[`Oath: ${req.oath}`]?.reqs, target, mustMinOath);
  const mustMinWeapon = zeroFlat();
  if (reqWeapon) {
    applyReqs(reqWeapon.reqs, target, mustMinWeapon);
    if (reqWeapon.wtype) { // the weapon's own stat carries the build's damage: at least the weapon's req, and 65 like weapon_type
      const w = canon(reqWeapon.wtype) ?? reqWeapon.wtype;
      target[w] = Math.max(target[w] ?? 0, 65);
    }
    notes.push(`planned for ${req.weapon}: ${Object.entries(reqWeapon.reqs ?? {}).map(([k, v]) => `${k} ${v}`).join(", ") || "no requirements"}`);
  }
  const mustMin = zeroFlat();
  for (const s of ALL_STATS) mustMin[s] = Math.max(mustMinMantras[s] ?? 0, mustMinTalents[s] ?? 0, mustMinOath[s] ?? 0, mustMinWeapon[s] ?? 0);

  // 6. stack minimum + racial bonus floors
  if (pre) pre[a.stack.stat] = Math.max(pre[a.stack.stat] ?? 0, a.stack.min);
  for (const [s, v] of Object.entries(bonus)) {
    if (pre) pre[s] = Math.max(pre[s] ?? 0, v);
    target[s] = Math.max(target[s] ?? 0, v);
  }
  if (pre) for (const s of ALL_STATS) if (target[s] > 0) pre[s] = Math.max(pre[s] ?? 0, 1);

  // 7. shrine: fit pre to the power-budget window, derive shrine base, raise target to meet it
  const targetNoShrine = { ...target }; // kept so the shrine can be dropped in step 8 if it can't fit the request
  let shrineBase = null, shrinePower = null;
  if (pre) {
    // R8: the budget power comes from the archetype's OWN pre-shrine block, not the cluster's modal
    // shrine power (which can be well above what this particular pre allocation actually reaches).
    const bpow = Math.max(8, Math.min(19, powerFor({ ...zeroFlat(), ...a.pre_shrine_modal })));
    const budget = pointsForPower(bpow);
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

  // Relief order when the floors can't fit in 330 points (R7, amended): first give up the
  // archetype's own preferences - the stack floor, then the Shrine of Order plan (its base floors
  // are what usually leaves no room) - before any must-list, and relax the oath / weapon the
  // request named only as a last resort, with a "could not fit" note. Race-bonus floors never move.
  const sources = [
    { label: "must_mantras", src: mustMinMantras },
    { label: "must_talents", src: mustMinTalents },
    { label: "oath", src: mustMinOath },
    { label: "weapon", src: mustMinWeapon },
  ].filter(({ src }) => ALL_STATS.some(st => (src[st] ?? 0) > 0)); // only sources that actually add a floor
  let useStackFloor = true, relaxedCount = 0;
  const floor330For = () => {
    const floor330 = {};
    for (const st of ALL_STATS) {
      const stackFloor = useStackFloor && st === a.stack.stat ? Math.min(target[st] ?? 0, a.stack.modal - 25) : 0;
      let mustFloor = 0;
      for (let i = relaxedCount; i < sources.length; i++) mustFloor = Math.max(mustFloor, sources[i].src[st] ?? 0);
      floor330[st] = Math.max(0, shrineBase?.[st] ?? 0, bonus[st] ?? 0, mustFloor, stackFloor);
    }
    return floor330;
  };
  const dropShrine = () => {
    pre = null; shrineBase = null; shrinePower = null;
    for (const st of ALL_STATS) target[st] = targetNoShrine[st];
    for (const [st, v] of Object.entries(bonus)) target[st] = Math.max(target[st] ?? 0, v);
    for (const st of ALL_STATS) target[st] = Math.max(target[st] ?? 0, mustMin[st] ?? 0);
  };

  let fit;
  for (;;) {
    try {
      fit = fitTo330(target, floor330For(), priority, a.post_shrine_spread, a.stack.stat);
      break;
    } catch (e) {
      if (useStackFloor) { useStackFloor = false; notes.push(`${a.stack.stat} stack floor dropped to fit the request`); continue; }
      if (pre) { dropShrine(); notes.push("Shrine of Order dropped: the request's requirements don't fit under this archetype's shrine plan"); continue; }
      if (relaxedCount >= sources.length) throw new Error(`${a.id}: ${e.message}`);
      notes.push(`could not fit ${sources[relaxedCount].label}'s requirements in 330 points`);
      relaxedCount++;
    }
  }
  const final = fit.final;

  // fitTo330 reports exactly which stats it raised under ruling rules 1-2 (beyond p75, or off of 0)
  // to close a gap the archetype's sparse per-stat modal data left in the 330-point budget; record
  // every one, regardless of whether the resulting value happens to cross that stat's own p75.
  for (const r of fit.raised) notes.push(`${r.stat} raised to ${r.to} to reach 330`);

  return { preShrine: pre, shrinePower, shrineBase, final, race, multifaceted, notes };
}

// §Task 10.1: pick talents for `archetype` under `req`, given a BuildCore-shaped `coreDraft` whose
// `talents` starts at []. Candidates = must_talents (resolved) then talent_freq names (desc), minus
// avoid_talents; resolved to canonical game.json keys so duplicates/aliases collapse. Runs the
// candidate list to a fixed point (a later candidate can become obtainable once an earlier one is
// taken), then a second pass fills in any *missing* prerequisite of an already-taken talent that is
// itself obtainable (this only matters for talents reachable via an `or` alternative whose own pre/reqs
// are empty even though the talent's primary `pre` lists something not yet held). Warder Techniques
// (excluding Justicar's Gift) are capped at the first 4 in candidate order; the rest are moved out of
// the taken list into `groups.choose["Warder path (pick 4)"]` so validate()'s warder_cap never trips.
// How many obtained Normal mantras this build will hold (decided before talents are picked, since
// every one of them costs two talent picks in the builder's shared budget): the archetype's typical
// count, or more if the request insists on more must-have mantras than that.
export function plannedMantraCount(req, archetype, game) {
  const must = req.must_mantras.filter(m => isCountingMantra(m, game)).length;
  return Math.max(archetype.budget?.mantras ?? 8, must);
}

export function pickTalents(req, archetype, coreDraft, game) {
  const resolve = n => resolveTalent(n, game) ?? n;
  const avoidSet = new Set(req.avoid_talents.map(resolve));
  // Builder rule: counting talents <= 52 + (12 - obtained Normal mantras) * 2. Real kits sit just
  // under it (corpus median 57 talents with 8 mantras), so the archetype's own typical talent count
  // is the target and the rule is the hard ceiling.
  const cap = 52 + (12 - plannedMantraCount(req, archetype, game)) * 2;
  const target = Math.min(cap, archetype.budget?.talents ?? cap);
  const counts = n => { const g = game.talents[resolve(n)]; return !!g?.counts && !(coreDraft.oath === "Soulbreaker" && ["Ardour Scream", "Spotter"].includes(resolve(n))); };

  const dropped = [];
  const mustResolved = [];
  for (const name of req.must_talents) {
    const r = resolveTalent(name, game);
    if (!r) { dropped.push({ name, why: "unknown talent" }); continue; }
    mustResolved.push(r);
  }
  const mustSet = new Set(mustResolved);

  // R2: the resolved oath's own prerequisite talents go to the very front of the candidate list -
  // ahead of must_talents - so they're taken first when obtainable. Filter out path entries (a
  // prerequisite that is itself "Oath: "/"Murmur: ", e.g. Oath: Contractor's self-reference) since
  // those are never real, pickable talents.
  const oathTalent = req.oath && req.oath !== "None" ? game.talents[`Oath: ${req.oath}`] : null;
  const oathPre = (oathTalent?.pre ?? []).filter(p => !p.startsWith("Oath: ") && !p.startsWith("Murmur: "));

  const seen = new Set();
  const candidates = [];
  for (const n of [...oathPre, ...mustResolved, ...archetype.talent_freq.map(([x]) => x)]) {
    const r = resolve(n);
    if (seen.has(r) || avoidSet.has(r)) continue;
    seen.add(r);
    candidates.push(r);
  }

  // Two talents are mutually exclusive when either lists the other in `exclusive` (the data isn't
  // guaranteed symmetric), so check both directions before taking a candidate.
  const excludesTaken = name => {
    const g = game.talents[resolve(name)];
    if ((g?.exclusive ?? []).some(x => takenSet.has(resolve(x)))) return true;
    for (const t of takenSet) if ((game.talents[resolve(t)]?.exclusive ?? []).includes(name)) return true;
    return false;
  };

  const takenSet = new Set();
  const taken = [];
  let countingTaken = 0;
  // A talent's not-yet-taken prerequisite chain has to fit alongside it (chains are added whole in
  // the pass below), so reserve room for it when deciding whether the talent still fits.
  const chainCost = name => {
    const need = new Set(); const stack = [name];
    while (stack.length) {
      const n = stack.pop();
      for (const p of game.talents[resolve(n)]?.pre ?? []) {
        const rp = resolve(p);
        if (takenSet.has(rp) || need.has(rp) || !game.talents[rp] || rp.startsWith("Oath: ") || rp.startsWith("Murmur: ")) continue;
        need.add(rp); stack.push(rp);
      }
    }
    return [...need].filter(counts).length;
  };
  let changed = true;
  let guard = candidates.length * candidates.length + 10;
  while (changed && guard-- > 0) {
    changed = false;
    for (const name of candidates) {
      if (takenSet.has(name) || excludesTaken(name)) continue;
      const cost = (counts(name) ? 1 : 0) + chainCost(name);
      if (cost && countingTaken + cost > (mustSet.has(name) ? cap : target)) continue;
      if (talentObtainable(name, { ...coreDraft, talents: taken }, game).ok) {
        takenSet.add(name); taken.push(name); changed = true;
        if (counts(name)) countingTaken++;
      }
    }
  }

  // prerequisite auto-add: fill in missing pres of already-taken talents when the pre itself is
  // now obtainable (see function doc above for why this can happen).
  changed = true;
  guard = taken.length * taken.length + 10;
  while (changed && guard-- > 0) {
    changed = false;
    for (const name of [...taken]) {
      const g = game.talents[resolve(name)];
      for (const p of g?.pre ?? []) {
        const rp = resolve(p);
        if (takenSet.has(rp) || excludesTaken(rp)) continue;
        if (talentObtainable(rp, { ...coreDraft, talents: taken }, game).ok) {
          takenSet.add(rp); taken.push(rp); changed = true;
          if (counts(rp)) countingTaken++;
        }
      }
    }
  }

  // Hard ceiling: if prerequisite auto-adds pushed the count past the builder's cap, drop the
  // least-frequent counting leaves (talents nothing else depends on) until it fits.
  const dependedOn = n => taken.some(t => t !== n && (game.talents[resolve(t)]?.pre ?? []).map(resolve).includes(n));
  const freqOf = new Map(archetype.talent_freq);
  while (countingTaken > cap) {
    const leaves = taken.filter(n => counts(n) && !mustSet.has(n) && !oathPre.includes(n) && !dependedOn(n));
    if (!leaves.length) break;
    const drop = leaves.sort((a, b) => (freqOf.get(a) ?? 0) - (freqOf.get(b) ?? 0))[0];
    taken.splice(taken.indexOf(drop), 1); takenSet.delete(drop); countingTaken--;
  }

  // Warder cap, ordered by candidate order first (prereq-auto-adds that aren't candidates sort after,
  // in the order they were added).
  const orderIndex = new Map(candidates.map((c, i) => [c, i]));
  const addedIndex = new Map(taken.map((c, i) => [c, i]));
  const orderedTaken = [...taken].sort((a, b) => {
    const ai = orderIndex.has(a) ? orderIndex.get(a) : candidates.length + addedIndex.get(a);
    const bi = orderIndex.has(b) ? orderIndex.get(b) : candidates.length + addedIndex.get(b);
    return ai - bi;
  });
  const isWarder = n => { const g = game.talents[resolve(n)]; return !!g && g.category === WARDER_CATEGORY && resolve(n) !== "Justicar's Gift"; };
  const warders = orderedTaken.filter(isWarder);
  const excess = new Set(warders.slice(4));
  const finalTalents = orderedTaken.filter(n => !excess.has(n));

  const freqMap = new Map(archetype.talent_freq);
  const groups = { core: [], recommended: [], choose: {} };
  for (const n of finalTalents) {
    if (mustSet.has(n) || (freqMap.get(n) ?? 0) >= 0.5) groups.core.push(n);
    else groups.recommended.push(n);
  }
  if (excess.size) groups.choose["Warder path (pick 4)"] = [...excess];

  for (const name of mustResolved) {
    if (!takenSet.has(name)) {
      const r = talentObtainable(name, { ...coreDraft, talents: taken }, game);
      dropped.push({ name, why: r.why.join("; ") || "unobtainable" });
    }
  }

  return { talents: finalTalents, groups, dropped };
}

// §Task 10.2: pick mantras for `archetype` under `req`, given a BuildCore-shaped `coreDraft` whose
// `mantras` starts at [] but whose `talents`/`oath`/`final` are already settled. Candidates =
// must_mantras then mantra_freq names then every mantra granted by the chosen oath (all categories),
// minus avoid_mantras. A candidate is taken when it exists in game.mantras, its reqs are met by
// `final`, its attunement (if any) is present (> 0) in `final`, and adding it keeps mantraUsage's
// overflow at 0 — mantraUsage already treats non-"Normal" mantras (Oath/Origin/Monster/...) as
// slot-free, so oath mantras of those types never block on slots.
export function pickMantras(req, archetype, coreDraft, game) {
  const avoidSet = new Set(req.avoid_mantras);
  const oathMantras = Object.values(game.oaths[coreDraft.oath]?.mantras ?? {}).flat();
  const poolSize = plannedMantraCount(req, archetype, game);

  const seen = new Set();
  const candidates = [];
  for (const n of [...req.must_mantras, ...archetype.mantra_freq.map(([x]) => x), ...oathMantras]) {
    if (seen.has(n) || avoidSet.has(n)) continue;
    seen.add(n);
    candidates.push(n);
  }
  const usable = name => {
    const m = game.mantras[name];
    if (!m || !meetsStats(coreDraft.final, m.reqs)) return false;
    if (mantraPathWhy(name, coreDraft, game)) return false; // another oath's / origin's mantra
    const attn = canon(m.attunement);
    return !(attn && !((coreDraft.final[attn] ?? 0) > 0));
  };

  // Pass 1 - the equipped loadout: Normal mantras that fit an open slot, in frequency order, plus
  // every free (oath/monster/origin) mantra. Pass 2 - the swap pool: more Normal mantras, still
  // in frequency order, until the archetype's typical obtained count. Each obtained Normal mantra
  // costs two talent picks, which pickTalents already budgeted for.
  const taken = [];
  let normal = 0;
  for (const name of candidates) {
    if (!usable(name)) continue;
    if (!isCountingMantra(name, game)) { taken.push(name); continue; }
    if (normal >= poolSize) continue;
    if (mantraUsage({ ...coreDraft, mantras: [...taken, name] }, game).overflow > 0) continue;
    taken.push(name); normal++;
  }
  for (const name of candidates) {
    if (normal >= poolSize) break;
    if (taken.includes(name) || !usable(name) || !isCountingMantra(name, game)) continue;
    taken.push(name); normal++;
  }

  const dropped = [];
  for (const name of req.must_mantras) {
    if (taken.includes(name)) continue;
    let why = "unknown mantra";
    if (avoidSet.has(name)) why = "avoided (conflicts with avoid_mantras)";
    else {
      const m = game.mantras[name];
      if (m) {
        if (!meetsStats(coreDraft.final, m.reqs)) why = `needs ${JSON.stringify(m.reqs)}`;
        else if (mantraPathWhy(name, coreDraft, game)) why = mantraPathWhy(name, coreDraft, game);
        else if (canon(m.attunement) && !((coreDraft.final[canon(m.attunement)] ?? 0) > 0)) why = `needs ${canon(m.attunement)}`;
        else why = "mantra pool full";
      }
    }
    dropped.push({ name, why });
  }

  const mantraMods = {};
  for (const name of taken) {
    const gems = archetype.gem_freq?.[name];
    mantraMods[name] = { gem: gems?.[0]?.[0] ?? "None", spark: "None" };
  }

  return { mantras: taken, mantraMods, dropped };
}

const EQUIP_SLOTS = ["Head", "Arms", "Legs", "Torso", "Face", "Earrings"];

function dominantWtype(final) {
  const map = { "Heavy Wep.": "heavy", "Medium Wep.": "medium", "Light Wep.": "light" };
  let best = null, bestVal = 0;
  for (const w of WEAPON_STATS) {
    const v = final[w] ?? 0;
    if (v > bestVal) { bestVal = v; best = w; }
  }
  return best ? map[best] : null;
}

function pickWeapon(req, archetype, final, game) {
  if (req.weapon) return req.weapon;
  if (req.weapon_type === "none") return "";
  const wantType = dominantWtype(final);
  const list = archetype.weapons ?? [];
  for (const [name] of list) {
    const w = game.weapons[name];
    if (w && wantType && w.wtype === wantType && meetsStats(final, w.reqs)) return name;
  }
  for (const [name] of list) {
    const w = game.weapons[name];
    if (w && meetsStats(final, w.reqs)) return name;
  }
  return "";
}

function pickOutfit(archetype, origin, final, game) {
  for (const [name] of archetype.outfits ?? []) {
    const o = game.outfits[name];
    if (!o) continue;
    if (o.origin && o.origin !== origin) continue;
    if (!meetsStats(final, o.reqs)) continue;
    return name;
  }
  return "None";
}

// Pips: Health on every slot that can roll it (the player's rule), with one pip in the slot's
// secondary stat so the builder's "put at least one pip into a different stat" rule holds; face
// and earrings can't roll Health (Ether, then Sanity). Pip count, stars and rarities come from the
// archetype's mined signature for the slot (gear_pips), falling back to a 3-star, 3-pip roll.
const PIP_PLAN = {
  Head: ["Health", "Physical Armor"], Arms: ["Health", "Physical Armor"], Legs: ["Health", "Ether"], Torso: ["Health", "Ether"],
  Rings: ["Health", "Posture"], Face: ["Ether", "Sanity"], Earrings: ["Ether", "Sanity"],
};
function itemFor(name, slot, archetype) {
  const sig = archetype.gear_pips?.[slot];
  const rarities = (sig?.pips ?? [["Health", "Rare"], ["Health", "Rare"], ["Health", "Rare"]]).map(([, r]) => r);
  const [major, minor] = PIP_PLAN[slot] ?? ["Health", "Ether"];
  const pips = rarities.map((rarity, i) => ({ stat: rarities.length >= 3 && i === rarities.length - 1 ? minor : major, rarity }));
  return { name, qualityStars: sig?.stars ?? 3, pips, enchant: "" };
}
function pickEquipment(archetype, final, game) {
  const okItem = name => name && meetsStats(final, game.equipment[name]?.reqs ?? {});
  const equipment = {};
  for (const slot of EQUIP_SLOTS) {
    const top = (archetype.equipment?.[slot] ?? []).map(([n]) => n).find(okItem);
    equipment[slot] = top ? itemFor(top, slot, archetype) : null;
  }
  const rings = (archetype.equipment?.Rings ?? []).map(([n]) => n).filter(okItem);
  equipment.Rings = [0, 1, 2, 3].map(i => rings[i] ? itemFor(rings[i], "Rings", archetype) : null);
  return equipment;
}

// Builder caps: 6 points per trait, 12 in total. The archetype's per-trait modes can add up to more.
export function clampTraits(traits) {
  const t = {};
  for (const k of ["Vitality", "Erudition", "Proficiency", "Songchant"]) t[k] = Math.max(0, Math.min(6, Number(traits?.[k] ?? 0)));
  let total = Object.values(t).reduce((x, y) => x + y, 0);
  while (total > 12) { // shave the smallest non-zero first (it's the least deliberate)
    const k = Object.keys(t).filter(x => t[x] > 0).sort((x, y) => t[x] - t[y])[0];
    t[k]--; total--;
  }
  return t;
}

// §Task 10.3: pick gear (origin/oath/murmur/bell/boons/flaws/traits/outfit/weapon/enchant/equipment)
// for `archetype` under `req`. `coreDraft.final` is the only part of the BuildCore this reads.
export function pickGear(req, archetype, coreDraft, game) {
  const oath = req.oath ?? archetype.oath?.[0]?.[0] ?? "None";
  const origin = req.origin ?? archetype.origin?.[0]?.[0] ?? "Castaway";
  const murmur = archetype.murmur?.[0]?.[0] ?? "None";
  const bell = archetype.bell?.[0]?.[0] ?? "None";
  const boonNames = (archetype.boons ?? []).map(([n]) => n).filter(n => n !== "None");
  const boons = [boonNames[0] ?? "None", boonNames[1] ?? "None"];
  const flawNames = (archetype.flaws ?? []).map(([n]) => n);
  const flaws = [flawNames[0] ?? "None", flawNames[1] ?? "None", flawNames[2] ?? "None"];
  const traits = clampTraits(archetype.traits_modal);
  const final = coreDraft.final;
  const outfit = pickOutfit(archetype, origin, final, game);
  const weapon = pickWeapon(req, archetype, final, game);
  const enchant = weapon ? (archetype.enchants?.[0]?.[0] || "Astral") : "";
  // Weapon stars: 3 of the mod the archetype's members roll (DMG% or PEN%).
  const weaponStars = weapon ? { count: 3, mod: archetype.weapon_stars?.mod ?? "DMG%" } : { count: 0, mod: "" };
  const equipment = pickEquipment(archetype, final, game);
  return { outfit, weapon, enchant, weaponStars, equipment, boons, flaws, traits, murmur, bell, origin, oath };
}

function talentUnlocks(build, game, before, after) {
  const names = [];
  for (const t of build.talents ?? []) {
    const resolved = resolveTalent(t, game);
    const g = resolved ? game.talents[resolved] : null;
    if (!g) continue;
    if (!meetsStats(before, g.reqs) && meetsStats(after, g.reqs)) names.push(t);
  }
  return names;
}

function mantraUnlocks(build, game, before, after) {
  const names = [];
  for (const m of build.mantras ?? []) {
    const g = game.mantras[m];
    if (!g) continue;
    if (!meetsStats(before, g.reqs) && meetsStats(after, g.reqs)) names.push(`${m} (mantra)`);
  }
  return names;
}

function orderedInvested(flat) {
  return ALL_STATS
    .filter(s => (flat[s] ?? 0) > 0)
    .sort((a, b) => (flat[b] - flat[a]) || (ALL_STATS.indexOf(a) - ALL_STATS.indexOf(b)));
}

// Put `stack` (the archetype's stack stat, if invested) at the front; keep everything else in its
// existing (descending-value) order. A no-op when `stack` is absent or wasn't invested pre-shrine.
function stackFirst(order, stack) {
  if (!stack || !order.includes(stack)) return order;
  return [stack, ...order.filter(s => s !== stack)];
}

// The set of stats buildGuide's post phase should let jump the queue ahead of plain final-value-desc
// ordering: attunements the request explicitly asked to include, plus every stat named in a reqs
// block of a must_talent/must_mantra the request asked for (canon'd, same resolution as planStats
// step 5's applyReqs) — i.e. only stats the request actually asked for, never "every attunement"
// just because it happens to be one.
function priorityStats(req, game) {
  const set = new Set();
  for (const raw of req.include_attunements) set.add(canon(raw) ?? raw);
  const addReqs = reqs => {
    for (const k of Object.keys(reqs ?? {})) {
      if (IGNORE_REQ_KEYS.has(k)) continue;
      const c = canon(k);
      if (c) set.add(c);
    }
  };
  for (const name of req.must_talents) {
    const resolved = resolveTalent(name, game);
    if (resolved) addReqs(game.talents[resolved]?.reqs);
  }
  for (const name of req.must_mantras) addReqs(game.mantras[name]?.reqs);
  return set;
}

// §Task 10.4: build the step-by-step levelling guide for an already-assembled BuildCore-ish `build`
// ({shrine, preShrine, final, race, multifaceted, talents, mantras, stack, priority}). Steps raise
// one stat at a time; the pre-shrine phase leads with the archetype's stack stat (`build.stack`, when
// it was actually invested pre-shrine), then the remaining invested pre stats by descending value.
// The post phase leads with whatever's in `build.priority` (a Set from `priorityStats`: attunements
// the request explicitly included, plus stats a must_talent/must_mantra actually needs) by descending
// final value, then every other grown stat by descending final value — NOT "every attunement first":
// an attunement the request never asked for sorts on its value like any base/weapon stat. `unlocks`
// lists talents (and, in the post/no-shrine phases, mantras) whose reqs newly become met by that
// step, simulated by comparing meetsStats() against the cumulative flat stats just before vs. after.
export function buildGuide(build, game) {
  const guide = [];
  const zero = zeroFlat();

  if (build.shrine && build.preShrine) {
    let cum = { ...zero };
    for (const s of stackFirst(orderedInvested(build.preShrine), build.stack)) {
      const before = { ...cum };
      cum = { ...cum, [s]: build.preShrine[s] };
      guide.push({ phase: "pre", step: `${s} → ${cum[s]}`, unlocks: talentUnlocks(build, game, before, cum) });
    }

    const bonus = build.multifaceted ? {} : (game.races[build.race] ?? {});
    const { base } = shrineOfOrder(build.preShrine, bonus);
    const power = powerFor(build.preShrine);
    const detail = ALL_STATS.filter(s => base[s] > 0).map(s => `${s} ${base[s]}`).join(", ");
    guide.push({ phase: "shrine", step: `Shrine of Order at Power ${power}`, unlocks: [], detail });

    const grew = ALL_STATS.filter(s => (build.final[s] ?? 0) > (base[s] ?? 0));
    const priority = build.priority ?? new Set();
    const jumps = grew.filter(s => priority.has(s));
    const rest = grew.filter(s => !priority.has(s));
    const byFinalDesc = arr => [...arr].sort((a, b) => (build.final[b] - build.final[a]) || (ALL_STATS.indexOf(a) - ALL_STATS.indexOf(b)));
    const order = [...byFinalDesc(jumps), ...byFinalDesc(rest)];

    let cumPost = { ...base };
    for (const s of order) {
      const before = { ...cumPost };
      cumPost = { ...cumPost, [s]: build.final[s] };
      const unlocks = [...talentUnlocks(build, game, before, cumPost), ...mantraUnlocks(build, game, before, cumPost)];
      guide.push({ phase: "post", step: `${s} → ${cumPost[s]}`, unlocks });
    }
  } else {
    let cum = { ...zero };
    for (const s of orderedInvested(build.final)) {
      const before = { ...cum };
      cum = { ...cum, [s]: build.final[s] };
      const unlocks = [...talentUnlocks(build, game, before, cum), ...mantraUnlocks(build, game, before, cum)];
      guide.push({ phase: "pre", step: `${s} → ${cum[s]}`, unlocks });
    }
  }

  return guide;
}

// §Task 10.5: assemble a full Build from a partial request. Runs the Task 9 pipeline (normalize ->
// select archetype -> plan stats) then this task's pickers in the order each needs the last: gear
// first (only needs `final`), then talents (needs origin/oath/outfit/weapon/equipment for
// talentObtainable's origin/oath/aspect checks and grantedTalents), then mantras (needs the settled
// talent list for mantraSlots' Neuroplasticity/Will o' Wisp/Chorus of Souls bonuses).
// R2/R3: resolve the oath the build will actually use before planStats runs, so planStats can plan
// stats for its requirements and pickGear/pickTalents see the exact same value (previously pickGear
// alone resolved `req.oath ?? archetype.oath[0]?.[0] ?? "None"`, so nothing upstream ever knew what
// oath the build would end up with). An explicit req.oath is always honoured as-is - validate() will
// report oath_reqs if it's unsatisfiable, and that's the user's call. Only the archetype-default case
// falls through the archetype's oath list past any oath whose own stat reqs touch an excluded (or,
// under attunementless, any) attunement.
function resolveOath(req, archetype, game) {
  if (req.oath) return { oath: req.oath, note: null };
  const candidates = (archetype.oath ?? []).map(([name]) => name);
  if (!candidates.length) return { oath: "None", note: null };
  const conflictStat = name => {
    const reqs = game.talents[`Oath: ${name}`]?.reqs ?? {};
    for (const k of Object.keys(reqs)) {
      const c = canon(k);
      if (!c || !ATTUNEMENTS.includes(c)) continue;
      if (req.attunementless) return c;
      if (req.exclude_attunements.some(ex => (canon(ex) ?? ex) === c)) return c;
    }
    return null;
  };
  const top = candidates[0];
  const topConflict = conflictStat(top);
  if (!topConflict) return { oath: top, note: null };
  const fallback = candidates.slice(1).find(name => !conflictStat(name));
  const oath = fallback ?? "None";
  return { oath, note: `oath ${top} replaced by ${oath} (requires excluded ${topConflict})` };
}

export function assemble(partialRequest, archetypes, game) {
  const req = normalizeRequest(partialRequest);
  const { archetype, adapted } = selectArchetype(req, archetypes);
  const { oath: resolvedOath, note: oathNote } = resolveOath(req, archetype, game);
  req.oath = resolvedOath;
  const plan = planStats(req, archetype, game);
  if (oathNote) plan.notes.push(oathNote);

  const shrine = !!plan.preShrine;
  const baseDraft = { final: plan.final, preShrine: plan.preShrine, shrine, race: plan.race, multifaceted: plan.multifaceted };

  const gear = pickGear(req, archetype, baseDraft, game);

  const talentDraft = { ...baseDraft, origin: gear.origin, oath: gear.oath, outfit: gear.outfit, weapon: gear.weapon, equipment: gear.equipment, talents: [] };
  const talentsResult = pickTalents(req, archetype, talentDraft, game);

  const mantraDraft = { ...talentDraft, talents: talentsResult.talents, mantras: [] };
  const mantrasResult = pickMantras(req, archetype, mantraDraft, game);

  const topStats = ALL_STATS.filter(s => plan.final[s] > 0).sort((a, b) => plan.final[b] - plan.final[a]).slice(0, 3);
  const name = adapted ? `Custom ${req.role}` : archetype.label;
  const ROLE_WORD = { dps: "DPS", healer: "healer", tank: "tank", mage: "mage", hybrid: "hybrid", bossraid: "boss-raid", chime: "Chime" };
  const description = `A ${archetype.stack.stat}-focused ${ROLE_WORD[req.role] ?? req.role} build`
    + (plan.shrinePower != null ? ` shrining at Power ${plan.shrinePower}` : "")
    + (topStats.length ? `, built around ${topStats.join(", ")}.` : ".");
  const notes = plan.notes.join("; ");

  const core = {
    name, description, notes,
    origin: gear.origin, oath: gear.oath, race: plan.race, murmur: gear.murmur, bell: gear.bell,
    outfit: gear.outfit, weapon: gear.weapon, enchant: gear.enchant, weaponStars: gear.weaponStars,
    boons: gear.boons, flaws: gear.flaws, traits: gear.traits,
    multifaceted: plan.multifaceted, shrine, preShrine: plan.preShrine, final: plan.final,
    talents: talentsResult.talents, mantras: mantrasResult.mantras, mantraMods: mantrasResult.mantraMods,
    equipment: gear.equipment,
  };

  const validation = validate(core, game);
  for (const d of [...talentsResult.dropped, ...mantrasResult.dropped]) {
    validation.warnings.push({ code: "must_dropped", msg: `${d.name}: ${d.why}` });
  }

  const { score, breakdown } = scoreBuild(core, archetype, game);
  const guide = buildGuide({ ...core, stack: archetype.stack.stat, priority: priorityStats(req, game) }, game);
  const draft = toDraft(core);

  const loadout = mantraLoadout(core, game);
  return {
    ...core,
    shrinePower: plan.shrinePower,
    talentGroups: talentsResult.groups,
    mantraGroups: { equipped: loadout.equipped, extra: loadout.extra, free: loadout.free, slots: loadout.slots },
    budget: talentBudget(core, game),
    validation,
    meta_score: score,
    score_breakdown: breakdown,
    based_on: { archetype: archetype.id, label: archetype.label, members: archetype.members, examples: archetype.example_ids, adapted },
    guide,
    draft,
  };
}
