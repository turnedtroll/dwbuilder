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

export function talentObtainable(name, core, game) {
  const resolved = resolveTalent(name, game);
  const t = resolved ? game.talents[resolved] : null;
  if (!t) return { ok: false, why: ["unknown"] };
  // Path entries ("Oath: X" / "Murmur: X") are never in core.talents (they're not pickable
  // mantras/talents in the usual sense), but Oath: Contractor lists itself as a prerequisite -
  // treat the build's own oath/murmur as "had" so that self-reference resolves instead of
  // permanently failing.
  const have = new Set([...core.talents.map(x => resolveTalent(x, game) ?? x), ...grantedTalents(core, game), `Oath: ${core.oath}`, `Murmur: ${core.murmur}`]);
  const why = [];
  // Most weaponType requirements are a single blanket field (t.weaponType) that applies no matter
  // which `or` alternative is used. One talent (Armor Piercing: Greatcannon/Pistol/Rifle) instead
  // carries a *different* weaponType per alternative and no blanket one - so weaponType is checked
  // per-alt here (falling back to the blanket t.weaponType when an alt doesn't specify its own),
  // not as a separate unconditional check.
  const or = t.or ?? [];
  // The top-level fields are themselves a genuine, independent alternative (see Execution: Light
  // Weapon 90 + Pistol is one of 3 equally-valid paths) UNLESS they contribute nothing that
  // distinguishes them from the `or` list, in which case including them would silently create an
  // unintended free pass: either the top level is completely empty (Jus Karita - the whole
  // requirement lives in `or`, there is no talent-wide default), or every `or` alternative carries
  // its own weaponType while the top level has none (Armor Piercing - the top-level reqs merge into
  // every alternative already via slimdata.py's or_block, so keeping a weaponType-free "primary"
  // around would wrongly accept any weapon type).
  const primaryEmpty = !Object.keys(t.reqs ?? {}).length && !(t.pre ?? []).length && !t.origin && !t.outfit;
  const primaryUnconstrainedWeapon = !t.weaponType && or.some(a => a.weaponType);
  const skipPrimary = or.length > 0 && (primaryEmpty || primaryUnconstrainedWeapon);
  const alt = skipPrimary ? [...or] : [{ reqs: t.reqs, pre: t.pre, origin: t.origin, outfit: t.outfit, alt: t.alt, weaponType: t.weaponType }, ...or];
  const altWeaponOk = a => weaponTypeOk({ weaponType: a.weaponType ?? t.weaponType }, core, game);
  const anyAlt = alt.some(a => phaseOk(a.reqs ?? {}, core) && altWeaponOk(a) && (a.alt || ((a.pre ?? []).every(p => have.has(p)) && (!a.origin || a.origin === core.origin))));
  const raceOk = !t.aspect || t.aspect === core.race;
  const oathOk = t.rarity !== "Oath" || t.category === core.oath;
  if (!anyAlt) {
    // Best-effort diagnostic text from the top-level fields; when skipPrimary is true (the real
    // requirement lives entirely in `or`, e.g. Jus Karita's per-alt origin) these are uninformative,
    // so `ok` below is derived from anyAlt directly rather than from why.length - a talent must never
    // read as obtainable just because we couldn't articulate which alternative it failed.
    if (Object.keys(t.reqs ?? {}).length && !phaseOk(t.reqs, core)) why.push(`needs ${Object.entries(t.reqs).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    for (const p of t.pre ?? []) if (!have.has(p)) why.push(`needs talent ${p}`);
    if (t.origin && t.origin !== core.origin) why.push(`needs origin ${t.origin}`);
    if (!alt.some(altWeaponOk)) {
      const wanted = [...new Set(alt.map(a => a.weaponType ?? t.weaponType).filter(Boolean))];
      if (wanted.length) why.push(`needs weapon type ${wanted.join(" or ")}`);
    }
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
    const r = talentObtainable(t, core, game);
    const weaponWhy = r.why.filter(w => w.startsWith("needs weapon type"));
    const otherWhy = r.why.filter(w => !w.startsWith("needs weapon type"));
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
    const attn = canon(g.attunement);
    if (attn && !phaseOk({ [attn]: 1 }, core)) err("mantra_reqs", `${m} needs ${attn}`);
  }
  const usage = mantraUsage(core, game);
  if (usage.overflow > 0) err("mantra_slots", `${usage.overflow} mantra(s) over slot limit ${JSON.stringify(usage.slots)}`);
  if (core.outfit && core.outfit !== "None") {
    const o = game.outfits[core.outfit];
    if (!o) err("unknown_outfit", core.outfit);
    else { if (!meetsStats(core.final, o.reqs)) err("outfit_reqs", core.outfit); if (o.origin && o.origin !== core.origin) err("outfit_reqs", `${core.outfit} needs origin ${o.origin}`); }
  }
  if (core.weapon) {
    const w = game.weapons[core.weapon];
    if (!w) err("unknown_weapon", core.weapon); else if (!meetsStats(core.final, w.reqs)) err("weapon_reqs", core.weapon);
  } else warn("no_weapon", "no weapon selected");
  return { ok: errors.length === 0, errors, warnings };
}
