export const BASE_STATS = ["Strength", "Fortitude", "Agility", "Intelligence", "Willpower", "Charisma"];
export const WEAPON_STATS = ["Heavy Wep.", "Medium Wep.", "Light Wep."];
export const ATTUNEMENTS = ["Flamecharm", "Frostdraw", "Thundercall", "Galebreathe", "Shadowcast", "Ironsing", "Bloodrend"];
export const CORE_STATS = [...BASE_STATS, ...WEAPON_STATS];
export const ALL_STATS = [...BASE_STATS, ...WEAPON_STATS, ...ATTUNEMENTS];
export const TOTAL_POINTS = 330;

const ALIASES = {
  str: "Strength", strength: "Strength",
  ftd: "Fortitude", frt: "Fortitude", fort: "Fortitude", fortitude: "Fortitude",
  agl: "Agility", agi: "Agility", agility: "Agility",
  int: "Intelligence", intel: "Intelligence", intelligence: "Intelligence",
  wil: "Willpower", wll: "Willpower", will: "Willpower", willpower: "Willpower",
  cha: "Charisma", chr: "Charisma", charisma: "Charisma",
  heavy: "Heavy Wep.", hvy: "Heavy Wep.", "heavy wep": "Heavy Wep.", "heavy wep.": "Heavy Wep.", "heavy weapon": "Heavy Wep.", "heavy weapons": "Heavy Wep.",
  medium: "Medium Wep.", med: "Medium Wep.", "medium wep": "Medium Wep.", "medium wep.": "Medium Wep.", "medium weapon": "Medium Wep.", "medium weapons": "Medium Wep.",
  light: "Light Wep.", lht: "Light Wep.", "light wep": "Light Wep.", "light wep.": "Light Wep.", "light weapon": "Light Wep.", "light weapons": "Light Wep.",
  flame: "Flamecharm", flamecharm: "Flamecharm", fire: "Flamecharm",
  frost: "Frostdraw", frostdraw: "Frostdraw", ice: "Frostdraw",
  thunder: "Thundercall", thundercall: "Thundercall", lightning: "Thundercall",
  gale: "Galebreathe", galebreathe: "Galebreathe", wind: "Galebreathe",
  shadow: "Shadowcast", shadowcast: "Shadowcast",
  iron: "Ironsing", ironsing: "Ironsing", metal: "Ironsing",
  blood: "Bloodrend", bloodrend: "Bloodrend",
};

export function canon(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  return ALIASES[key] ?? (ALL_STATS.find(s => s.toLowerCase() === key) ?? null);
}

export function zeroFlat() {
  const f = {};
  for (const s of ALL_STATS) f[s] = 0;
  return f;
}

export function flatten(nested) {
  const f = zeroFlat();
  for (const grp of ["base", "weapon", "attunement"])
    for (const [k, v] of Object.entries(nested?.[grp] ?? {})) if (k in f) f[k] = Number(v) || 0;
  return f;
}

export function nest(flat) {
  const pick = names => Object.fromEntries(names.map(n => [n, flat[n] ?? 0]));
  return { base: pick(BASE_STATS), weapon: pick(WEAPON_STATS), attunement: pick(ATTUNEMENTS) };
}

// Port of the builder's Pn(): sum of everything, minus 1 for every attunement after the first with points.
export function pointsSpent(flat) {
  let t = 0;
  for (const s of ALL_STATS) t += flat[s] ?? 0;
  let seen = false;
  for (const a of ATTUNEMENTS) {
    const v = flat[a] ?? 0;
    if (seen && v > 0) t--;
    if (v >= 1) seen = true;
  }
  return t;
}

// Port of Kn(): floor((points - 30 + 15) / 15) clamped to [0, 20].
export function powerFor(flat) {
  const n = Math.floor((pointsSpent(flat) - 30 + 15) / 15);
  return Math.max(0, Math.min(20, n));
}

export function pointsForPower(p) {
  return p <= 0 ? 0 : 15 * p + 15;
}

export function reqValue(flat, reqName) {
  switch (reqName) {
    case "Power": return powerFor(flat);
    case "Body": return Math.max(flat.Strength, flat.Agility, flat.Fortitude);
    case "Mind": return Math.max(flat.Intelligence, flat.Willpower, flat.Charisma);
    case "Weapon": case "Weapons": return Math.max(...WEAPON_STATS.map(s => flat[s]));
    case "Attunement": return Math.max(...ATTUNEMENTS.map(s => flat[s]));
    default: {
      const c = canon(reqName);
      return c ? (flat[c] ?? 0) : 0;
    }
  }
}

export function meetsStats(flat, reqs) {
  for (const [k, v] of Object.entries(reqs ?? {})) if (reqValue(flat, k) < Number(v)) return false;
  return true;
}
