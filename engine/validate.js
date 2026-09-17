import { pointsSpent, meetsStats, powerFor, ALL_STATS, ATTUNEMENTS, TOTAL_POINTS, canon } from "./stats.js";
import { shrineOfOrder } from "./shrine.js";
export const WARDER_CATEGORY = "Warder Techniques";
const BASE_SLOTS = { Combat: 3, Mobility: 1, Support: 1, Wisp: 0, Wildcard: 1 };
const isPath = t => t.startsWith("Oath: ") || t.startsWith("Murmur: ");

const VARIANT_SUFFIX = / \[[A-Z]{3,4}\]$/;
const lowerIndexCache = new WeakMap();

function lowerIndex(game) {
  let idx = lowerIndexCache.get(game);
  if (!idx) {
    idx = new Map();
    for (const k of Object.keys(game.talents)) idx.set(k.toLowerCase(), k);
    lowerIndexCache.set(game, idx);
  }
  return idx;
}

export function resolveTalent(name, game) {
  if (name in game.talents) return name;
  const base = name.replace(VARIANT_SUFFIX, "");
  if (base in game.talents) return base;
  const lower = base.toLowerCase();
  return lowerIndex(game).get(lower) ?? null;
}

export function grantedTalents(core, game) {
  const g = new Set();
  for (const t of game.outfits[core.outfit]?.talents ?? []) g.add(t);
  for (const t of game.weapons[core.weapon]?.talents ?? []) g.add(t);
  for (const item of [...Object.values(core.equipment ?? {})].flat()) if (item?.name) for (const t of game.equipment[item.name]?.talents ?? []) g.add(t);
  return g;
}

function phaseOk(reqs, core) {
  const phases = core.shrine && core.preShrine ? [core.preShrine, core.final] : [core.final];
  return phases.some(f => meetsStats(f, reqs));
}

// The builder treats a talent's weaponType as a hard requirement (equipped weapon's type, or
// wtype for the "Light/Medium/Heavy Weapon" class entries, must be in the comma-separated list;
// no weapon at all -> never obtainable). "Fists" is the only vocabulary mismatch against
// weapons[*].type ("Fist"), normalised below.
export function weaponTypeOk(talent, core, game) {
  if (!talent.weaponType) return true;
  const w = game.weapons[core.weapon];
  if (!w) return false;
  return talent.weaponType.split(", ").some(want => {
    if (want === "Light Weapon") return w.wtype === "light";
    if (want === "Medium Weapon") return w.wtype === "medium";
    if (want === "Heavy Weapon") return w.wtype === "heavy";
    if (want === "Fists") return w.type === "Fist";
    return w.type === want;
  });
}

// Attunement tier talents ("Adept/Expert/Master <X>", "<X> Unbounded", and the bare
// "Flamecharmer"/"Ironsinger"/... entries) are not picked in the builder - it adds and removes
// them itself from the FINAL attunement stats alone (pre-shrine values don't count, unlike
// every other talent). Mirrors the builder's Tb(): name pattern + attunement req + doesn't
// count toward the talent total.
const TIER_NAME = /^(Adept |Expert |Master )| Unbounded$/;
const TIER_BASE = new Set(["Flamecharmer", "Frostdrawer", "Thundercaller", "Galebreather", "Shadowcaster", "Ironsinger", "Bloodrender"]);
export function isAutoTier(name, game) {
  const t = game.talents[name];
  if (!t || t.counts) return false;
  if (!(TIER_NAME.test(name) || TIER_BASE.has(name))) return false;
  return Object.keys(t.reqs ?? {}).some(k => ATTUNEMENTS.includes(canon(k) ?? k));
}
export function autoTierGranted(name, core, game) {
  const t = game.talents[name];
  return Object.entries(t.reqs ?? {}).every(([k, v]) => {
    const s = canon(k) ?? k;
    return ATTUNEMENTS.includes(s) && (core.final[s] ?? 0) >= Number(v);
  });
}

const tierCache = new WeakMap(); // keyed by core.final, which pickers never mutate mid-pick
function grantedTierTalents(core, game) {
  let set = tierCache.get(core.final);
  if (!set) {
    set = new Set();
    for (const n of Object.keys(game.talents)) if (isAutoTier(n, game) && autoTierGranted(n, core, game)) set.add(n);
    tierCache.set(core.final, set);
  }
  return set;
}

// Everything the build "has" for prerequisite purposes: listed talents (tier talents only if the
// final stats actually grant them - the builder drops the rest on load), gear-granted talents,
// auto-granted tier talents, and the build's own Oath:/Murmur: path entries (Oath: Contractor
// lists itself as a prerequisite).
export function haveTalents(core, game) {
  const have = new Set();
  for (const x of core.talents) {
    const r = resolveTalent(x, game) ?? x;
    if (!isAutoTier(r, game)) have.add(r);
  }
  for (const g of grantedTalents(core, game)) have.add(g);
  for (const g of grantedTierTalents(core, game)) have.add(g);
  have.add(`Oath: ${core.oath}`); have.add(`Murmur: ${core.murmur}`);
  return have;
}

// Requirement semantics, mirroring the builder's evaluator (tr()/Jw() in its bundle):
//  - a requirement block is stats AND prerequisite talents AND origin AND weaponType AND, when an
//    `or` list exists, at least one alternative block (evaluated with the same rules). The
//    top-level block is NOT itself an alternative: Potion Quaffer = Int 30 AND (Fort 15 OR Will 15).
//  - a talent is obtainable if the whole block holds against the post-shrine stats, where a
//    prerequisite may instead have been obtained pre-shrine; or if the whole block (prerequisites
//    included, no fallback) holds against the pre-shrine stats. Magical Resolve (Will 40 + Battle
//    Tendency) with pre Will 40 / Fort 1 and post Will 30 / Fort 90 is obtainable in neither.
//  - tier talents are granted purely from the final attunement stats (see isAutoTier).
function evalBlock(block, phase, core, game, have, stack) {
  const stats = phase === "pre" ? core.preShrine : core.final;
  if (!meetsStats(stats, block.reqs ?? {})) return false;
  if (!weaponTypeOk({ weaponType: block.weaponType }, core, game)) return false;
  if (block.origin && block.origin !== core.origin) return false;
  for (const p of block.pre ?? []) {
    if (!have.has(p)) return false;
    if (!prereqObtainable(p, phase, core, game, have, stack)) return false;
  }
  if (block.or?.length && !block.or.some(a => evalBlock(a, phase, core, game, have, stack))) return false;
  return true;
}
function prereqObtainable(p, phase, core, game, have, stack) {
  if (isPath(p) || !game.talents[p] || stack.has(p)) return true; // own oath/murmur; unknown name; cycle
  stack.add(p);
  const ok = obtainableIn(p, phase, core, game, have, stack) ||
    (phase === "post" && hasPreShrine(core) && obtainableIn(p, "pre", core, game, have, stack));
  stack.delete(p);
  return ok;
}
function obtainableIn(name, phase, core, game, have, stack) {
  if (isAutoTier(name, game)) return autoTierGranted(name, core, game);
  return evalBlock(game.talents[name], phase, core, game, have, stack);
}
const hasPreShrine = core => !!(core.shrine && core.preShrine);

export function talentObtainable(name, core, game, _depth = 0) {
  const resolved = resolveTalent(name, game);
  const t = resolved ? game.talents[resolved] : null;
  if (!t) return { ok: false, why: ["unknown talent"] };
  const have = haveTalents(core, game);
  const anyAlt = obtainableIn(resolved, "post", core, game, have, new Set()) ||
    (hasPreShrine(core) && obtainableIn(resolved, "pre", core, game, have, new Set()));
  const raceOk = !t.aspect || t.aspect === core.race;
  const oathOk = t.rarity !== "Oath" || t.category === core.oath;
  const why = [];
  if (!anyAlt) {
    // Best-effort diagnostics; `ok` is derived from anyAlt, never from why. Weapon-type reasons keep
    // the words "needs weapon type" so validate() can file them under talent_weapon_type.
    const fmt = reqs => Object.entries(reqs ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
    if (isAutoTier(resolved, game)) why.push(`auto-granted only at final ${fmt(t.reqs)}`);
    else if (Object.keys(t.reqs ?? {}).length && !phaseOk(t.reqs, core)) why.push(`needs ${fmt(t.reqs)}`);
    for (const p of t.pre ?? []) {
      if (!have.has(p)) { why.push(`needs talent ${p}`); continue; }
      const preOk = prereqObtainable(p, "post", core, game, have, new Set()) || (hasPreShrine(core) && prereqObtainable(p, "pre", core, game, have, new Set()));
      if (!preOk) {
        // Same phrasing as the builder ("Turtle Shell: Knight's Rally: Requires Weapon Type: Shield").
        const sub = _depth < 3 && game.talents[p] ? talentObtainable(p, core, game, _depth + 1).why : ["requirements not met"];
        why.push(`${p}: ${sub.join("; ")}`);
      }
    }
    if (t.origin && t.origin !== core.origin) why.push(`needs origin ${t.origin}`);
    const wtBlocks = [t, ...(t.or ?? [])].filter(b => b.weaponType);
    if (wtBlocks.length && !wtBlocks.some(b => weaponTypeOk({ weaponType: b.weaponType }, core, game))) {
      why.push(`needs weapon type ${[...new Set(wtBlocks.map(b => b.weaponType))].join(" or ")}`);
    }
    if (t.or?.length && !why.length) why.push(`needs one of ${t.or.map(a => fmt(a.reqs) || a.origin || a.weaponType || "?").join(" / ")}`);
    if (!why.length) why.push("requirements not met");
  }
  if (!raceOk) why.push(`needs race ${t.aspect}`);
  if (!oathOk) why.push(`needs oath ${t.category}`);
  return { ok: anyAlt && raceOk && oathOk, why };
}

export function mantraSlots(core, game) {
  const s = { ...(game.slots ?? BASE_SLOTS) };
  const o = game.oaths[core.oath]?.slots ?? {};
  for (const k of ["Combat", "Mobility", "Support", "Wildcard"]) s[k] += o[k] ?? 0;
  if (core.talents.includes("Neuroplasticity")) s.Wildcard++;
  if (core.talents.some(t => t.includes("Will o' Wisp"))) s.Wisp++;
  if (core.talents.some(t => t.includes("Chorus of Souls"))) s.Wisp++;
  return s;
}

const POOL_CATEGORIES = new Set(["Combat", "Mobility", "Support", "Wisp"]);
// Obtained mantras that cost talent picks in the builder: type Normal (Oath/Monster/Origin/Event
// mantras are free) in the four slot categories.
export function isCountingMantra(name, game) {
  const m = game.mantras[name];
  return !!m && (m.type ?? "Normal") === "Normal" && POOL_CATEGORIES.has(m.category);
}

// The builder's shared card budget (its Talents tab shows "N / cap"): at Power 20 you get 76
// picks; every obtained Normal mantra spends two, so cap = 52 + (12 - mantras) * 2. Counting
// talents are those with countTowardsTalentTotal (game.json `counts`) that aren't gear-granted;
// Soulbreaker's Ardour Scream / Spotter are free.
export function talentBudget(core, game) {
  const granted = grantedTalents(core, game);
  let counting = 0;
  const seen = new Set();
  for (const t of core.talents) {
    const r = resolveTalent(t, game);
    if (!r || seen.has(r) || isPath(r)) continue;
    seen.add(r);
    const g = game.talents[r];
    if (!g?.counts || granted.has(r)) continue;
    if (core.oath === "Soulbreaker" && (r === "Ardour Scream" || r === "Spotter")) continue;
    counting++;
  }
  const mantras = core.mantras.filter(m => isCountingMantra(m, game)).length;
  const cap = 52 + (12 - mantras) * 2;
  return { counting, mantras, cap, room: cap - counting };
}

// Which obtained mantras are actually equipped: Normal mantras fill their category's slots in list
// order (Wisp may take a Support slot, anything may take a Wildcard slot); the rest are `extra` -
// still obtained, swapped in at will. Non-Normal mantras (oath/monster/origin) are `free`.
export function mantraLoadout(core, game) {
  const slots = mantraSlots(core, game);
  const used = { Combat: 0, Mobility: 0, Support: 0, Wisp: 0, Wildcard: 0 };
  const equipped = [], extra = [], free = [];
  for (const name of core.mantras) {
    const m = game.mantras[name];
    if (!m) continue;
    if ((m.type ?? "Normal") !== "Normal" || !POOL_CATEGORIES.has(m.category)) { free.push(name); continue; }
    const cat = m.category;
    let slot = null;
    if (used[cat] < slots[cat]) slot = cat;
    else if (cat === "Wisp" && used.Support < slots.Support) slot = "Support";
    else if (used.Wildcard < slots.Wildcard) slot = "Wildcard";
    if (slot) { used[slot]++; equipped.push({ name, slot }); } else extra.push(name);
  }
  return { equipped, extra, free, slots };
}

// An oath's mantras ("attunement": "Oath: X") belong to that oath, an origin's to that origin;
// the builder only lists them under the matching path. Returns why it's not allowed, or null.
export function mantraPathWhy(name, core, game) {
  const m = game.mantras[name];
  const a = m?.attunement ?? "";
  if (a.startsWith("Oath: ") && a.slice(6) !== core.oath) return `needs oath ${a.slice(6)}`;
  if (a.startsWith("Origin: ") && a.slice(8) !== core.origin) return `needs origin ${a.slice(8)}`;
  return null;
}

export function mantraUsage(core, game) {
  const slots = mantraSlots(core, game);
  const counts = { Combat: 0, Mobility: 0, Support: 0, Wisp: 0, Wildcard: 0 };
  let overflow = 0;
  for (const name of core.mantras) {
    const m = game.mantras[name]; if (!m || m.type !== "Normal") continue;
    const cat = m.category; if (!(cat in counts) || cat === "Wildcard") continue;
    let use;
    if (counts[cat] < slots[cat]) use = cat;
    else if (cat === "Wisp" && counts.Support < slots.Support) use = "Support";
    else if (counts.Wildcard < slots.Wildcard) use = "Wildcard";
    else { use = cat; overflow++; }
    counts[use]++;
  }
  return { counts, slots, overflow };
}

export function validate(core, game) {
  const errors = [], warnings = [];
  const err = (code, msg) => errors.push({ code, msg }), warn = (code, msg) => warnings.push({ code, msg });
  const pts = pointsSpent(core.final);
  if (pts !== TOTAL_POINTS) err("points", `${pts} points spent, need ${TOTAL_POINTS}`);
  for (const s of ALL_STATS) if (core.final[s] > 100 || core.final[s] < 0) err("stat_max", `${s} = ${core.final[s]}`);
  const bonus = core.multifaceted ? {} : (game.races[core.race] ?? {});
  for (const [s, v] of Object.entries(bonus)) if ((core.final[s] ?? 0) < v) err("race_bonus", `${s} below racial bonus ${v}`);
  if (core.shrine) {
    if (!core.preShrine) err("shrine", "shrine enabled but no pre-shrine stats");
    else {
      if (pointsSpent(core.preShrine) > TOTAL_POINTS) err("shrine", "pre-shrine exceeds 330 points");
      const { base } = shrineOfOrder(core.preShrine, bonus);
      for (const s of ALL_STATS) if (core.final[s] < base[s]) warn("shrine_base", `${s}: final ${core.final[s]} < shrine base ${base[s]}`);
      if (powerFor(core.preShrine) < 8) warn("shrine_power_low", `shrining at power ${powerFor(core.preShrine)}`);
    }
  }
  // "Oath: <name>" is itself a talent entry (rarity Oath) with real reqs/pre in game.json (e.g. Oath:
  // Blindseer needs Willpower 40 + 3 prerequisite talents), but the per-talent loop below skips every
  // "Oath: "/"Murmur: " path entry outright (isPath) - so nothing ever checked the oath's own
  // requirements. Reuse talentObtainable directly; its rarity==="Oath" category check is a no-op here
  // since core.oath is by definition the requested oath's own category.
  if (core.oath && core.oath !== "None" && game.talents[`Oath: ${core.oath}`]) {
    const r = talentObtainable(`Oath: ${core.oath}`, core, game);
    if (!r.ok) err("oath_reqs", `${core.oath}: ${r.why.join("; ")}`);
  }
  const seen = new Set();
  const seenResolved = new Set();
  let warders = 0;
  for (const t of core.talents) {
    if (isPath(t)) continue;
    if (seen.has(t)) err("dup_talent", t); seen.add(t);
    const resolved = resolveTalent(t, game);
    if (!resolved) { err("unknown_talent", t); continue; }
    const g = game.talents[resolved];
    if (g.category === WARDER_CATEGORY && resolved !== "Justicar's Gift") warders++;
    if (isAutoTier(resolved, game)) {
      // The builder owns these: it removes a listed tier talent whose final attunement is short
      // (and everything that depended on it then fails), and adds qualifying ones by itself.
      // Listing one the final stats don't grant is harmless to the builder (it silently drops it,
      // and published builds do this constantly) - warn, and let dependents fail via haveTalents.
      if (!autoTierGranted(resolved, core, game)) warn("talent_auto_tier", `${t}: auto-granted only at final ${Object.entries(g.reqs).map(([k, v]) => `${k} ${v}`).join(", ")}; the builder removes it`);
      seenResolved.add(resolved);
      continue;
    }
    const r = talentObtainable(t, core, game);
    const weaponWhy = r.why.filter(w => w.includes("needs weapon type"));
    const otherWhy = r.why.filter(w => !w.includes("needs weapon type"));
    if (otherWhy.length) err("talent_reqs", `${t}: ${otherWhy.join("; ")}`);
    if (weaponWhy.length) err("talent_weapon_type", `${t}: ${weaponWhy.join("; ")}`);
    if (g.outfit && g.outfit !== core.outfit) warn("talent_soft", `${t} wants outfit ${g.outfit}`);
    for (const m of g.mantras ?? []) if (!core.mantras.includes(m)) warn("talent_soft", `${t} wants mantra ${m}`);
    for (const x of g.exclusive ?? []) if (seenResolved.has(x)) err("exclusive", `${t} excludes ${x}`);
    seenResolved.add(resolved);
  }
  if (warders > 4) err("warder_cap", `${warders} Warder talents, max 4`);
  for (const m of core.mantras) {
    const g = game.mantras[m];
    if (!g) { err("unknown_mantra", m); continue; }
    if (!phaseOk(g.reqs, core)) err("mantra_reqs", `${m} needs ${JSON.stringify(g.reqs)}`);
    const pathWhy = mantraPathWhy(m, core, game);
    if (pathWhy) err("mantra_reqs", `${m} ${pathWhy}`);
    const attn = canon(g.attunement);
    if (attn && !phaseOk({ [attn]: 1 }, core)) err("mantra_reqs", `${m} needs ${attn}`);
  }
  // Obtained mantras beyond the equip slots are the swap pool, not an error (the builder doesn't
  // flag them either); what the builder does enforce is the shared talent/mantra card budget.
  const usage = mantraUsage(core, game);
  if (usage.overflow > 0) warn("mantra_slots", `${usage.overflow} obtained mantra(s) beyond the ${Object.values(usage.slots).reduce((x, y) => x + y, 0)} equip slots - swap them in as needed`);
  const budget = talentBudget(core, game);
  if (budget.counting > budget.cap) err("talent_budget", `${budget.counting} talents, but only ${budget.cap} fit with ${budget.mantras} obtained mantras (52 + (12 - mantras) * 2)`);
  if (core.outfit && core.outfit !== "None") {
    const o = game.outfits[core.outfit];
    if (!o) err("unknown_outfit", core.outfit);
    else { if (!meetsStats(core.final, o.reqs)) err("outfit_reqs", core.outfit); if (o.origin && o.origin !== core.origin) err("outfit_reqs", `${core.outfit} needs origin ${o.origin}`); }
  }
  for (const [slot, item] of Object.entries(core.equipment ?? {})) {
    for (const it of (Array.isArray(item) ? item : [item])) {
      if (!it?.name) continue;
      const e = game.equipment[it.name];
      if (!e) { err("unknown_equipment", `${slot}: ${it.name} is not a current item (the builder won't save it)`); continue; }
      if (!meetsStats(core.final, e.reqs ?? {})) err("equipment_reqs", `${slot}: ${it.name} needs ${Object.entries(e.reqs).map(([k, v]) => `${k} ${v}`).join(", ")}`);
      // the builder's server rejects a save whose pip rarities don't follow innate pips + star pips
      const STAR = { 0: [], 1: ["Rare"], 2: ["Rare", "Rare"], 3: ["Rare", "Rare", "Legendary"] };
      const want = [...(e.innate_pips ?? []), ...(STAR[it.qualityStars] ?? [])];
      const got = (it.pips ?? []).map(p => p.rarity);
      if (want.length && got.join() !== want.join()) err("gear_pips", `${slot}: ${it.name}: pip rarities ${got.join("/") || "none"} should be ${want.join("/")}`);
    }
  }
  const tv = Object.values(core.traits ?? {}).map(Number);
  if (tv.some(v => v < 0 || v > 6)) err("traits", `a trait is over 6 (${JSON.stringify(core.traits)})`);
  if (tv.reduce((x, y) => x + y, 0) > 12) err("traits", `${tv.reduce((x, y) => x + y, 0)} trait points, max 12`);
  // Builder rule: an item with 3+ pips all in one stat gets "put at least one pip into a different stat".
  for (const [slot, item] of Object.entries(core.equipment ?? {})) {
    for (const it of (Array.isArray(item) ? item : [item])) {
      const pips = it?.pips ?? [];
      if (it?.name && pips.length >= 3 && pips.every(p => p.stat) && pips.every(p => p.stat === pips[0].stat)) err("gear_pips", `${slot}: ${it.name}: all ${pips.length} pips in ${pips[0].stat} - put at least one into a different stat`);
    }
  }
  if (core.weapon) {
    const w = game.weapons[core.weapon];
    if (!w) err("unknown_weapon", core.weapon); else if (!meetsStats(core.final, w.reqs)) err("weapon_reqs", core.weapon);
  } else warn("no_weapon", "no weapon selected");
  return { ok: errors.length === 0, errors, warnings };
}
