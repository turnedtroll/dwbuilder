import { flatten, nest, zeroFlat, canon, BASE_STATS, WEAPON_STATS, ATTUNEMENTS } from "./stats.js";
const TRAITS = ["Vitality", "Erudition", "Proficiency", "Songchant"];
const zeroAttrs = () => nest(zeroFlat());
const emptyEquip = () => ({ Head: null, Arms: null, Legs: null, Torso: null, Face: null, Earrings: null, Rings: [null, null, null, null] });

export function defaultDraft() {
  return {
    version: 3, createdAt: "", updatedAt: "",
    author: { id: "", verifiedId: "", name: "" },
    stats: { buildName: "", buildDescription: "", buildAuthor: "", power: 0, points: 330, pointSpent: 0, pointsUntilNextPower: 0,
      traits: Object.fromEntries(TRAITS.map(t => [t, 0])), traitsPoints: 12,
      meta: { Race: "None", Oath: "None", Murmur: "None", Origin: "Castaway", Bell: "None", Outfit: "None" },
      boon1: "None", boon2: "None", flaw1: "None", flaw2: "None", flaw3: "None" },
    attributes: zeroAttrs(), content: { notes: "", mantraModifications: {} },
    meta: { visibility: "public", private: false, tags: [], votes: { up: 0, down: 0, voters: {} }, views: 0, saved: 0, comments: { count: 0, lastActivity: null } },
    talents: [], weapons: "", enchant: "", motif: "", weaponStars: { count: 0, mod: "" }, multifaceted: false,
    mantras: [], preShrine: zeroAttrs(), postShrine: zeroAttrs(), preMastery: {}, postMastery: {}, favoritedTalents: [], equipment: emptyEquip(),
  };
}

const hasPoints = flat => Object.values(flat).some(v => v > 0);

export function fromFeedBuild(b) {
  const pre = flatten(b.preShrine), post = flatten(b.postShrine), attrs = flatten(b.attributes);
  const shrine = hasPoints(pre) && JSON.stringify(pre) !== JSON.stringify(hasPoints(post) ? post : attrs);
  const m = b.stats?.meta ?? {};
  return {
    name: b.stats?.buildName ?? "", description: b.stats?.buildDescription ?? "", notes: b.content?.notes ?? "",
    origin: m.Origin ?? "Castaway", oath: m.Oath ?? "None", race: m.Race ?? "None", murmur: m.Murmur ?? "None", bell: m.Bell ?? "None",
    outfit: m.Outfit ?? "None", weapon: b.weapons ?? "", enchant: b.enchant ?? "",
    boons: [b.stats?.boon1 ?? "None", b.stats?.boon2 ?? "None"], flaws: [b.stats?.flaw1 ?? "None", b.stats?.flaw2 ?? "None", b.stats?.flaw3 ?? "None"],
    traits: { ...Object.fromEntries(TRAITS.map(t => [t, 0])), ...(b.stats?.traits ?? {}) },
    multifaceted: !!b.multifaceted, shrine, preShrine: shrine ? pre : null, final: attrs,
    talents: [...(b.talents ?? [])], mantras: [...(b.mantras ?? [])],
    mantraMods: JSON.parse(JSON.stringify(b.content?.mantraModifications ?? {})),
    equipment: { ...emptyEquip(), ...(b.equipment ?? {}) },
  };
}

function parseBlock(block) {
  const f = zeroFlat();
  for (const [k, v] of Object.entries(block ?? {})) { const c = canon(k); if (c) f[c] = Number(v) || 0; }
  return f;
}

export function fromSpec(spec) {
  const shrine = !!(spec.shrineOfOrder ?? spec.shrine);
  const pre = parseBlock(spec.preShrine ?? spec.stats), post = spec.postShrine ? parseBlock(spec.postShrine) : null;
  const boons = [...(spec.boons ?? [])], flaws = [...(spec.flaws ?? [])];
  return {
    name: spec.name ?? "", description: spec.description ?? "", notes: spec.notes ?? "",
    origin: spec.origin ?? "Castaway", oath: spec.oath ?? "None", race: spec.race ?? "None", murmur: spec.murmur ?? "None", bell: spec.bell ?? "None",
    outfit: spec.outfit ?? "None", weapon: spec.weapon ?? "", enchant: spec.enchant ?? "",
    boons: [boons[0] || "None", boons[1] || "None"], flaws: [flaws[0] || "None", flaws[1] || "None", flaws[2] || "None"],
    traits: { ...Object.fromEntries(TRAITS.map(t => [t, 0])), ...(spec.traits ?? {}) },
    multifaceted: !!spec.multifaceted, shrine, preShrine: shrine ? pre : null, final: shrine && post ? post : pre,
    talents: [...(spec.talents ?? [])], mantras: [...(spec.mantras ?? [])],
    mantraMods: JSON.parse(JSON.stringify(spec.mantraModifications ?? {})),
    equipment: { ...emptyEquip(), ...(spec.equipment ?? {}) },
  };
}

export function toDraft(core) {
  const d = defaultDraft();
  const s = d.stats;
  s.buildName = core.name; s.buildDescription = core.description; d.content.notes = core.notes;
  Object.assign(s.meta, { Origin: core.origin || "Castaway", Oath: core.oath || "None", Race: core.race || "None", Murmur: core.murmur || "None", Bell: core.bell || "None", Outfit: core.outfit || "None" });
  d.weapons = core.weapon || ""; d.enchant = core.enchant || ""; d.multifaceted = !!core.multifaceted;
  if (core.weaponStars) d.weaponStars = { count: Number(core.weaponStars.count ?? 0), mod: core.weaponStars.mod ?? "" };
  [s.boon1, s.boon2] = [core.boons?.[0] || "None", core.boons?.[1] || "None"];
  [s.flaw1, s.flaw2, s.flaw3] = [core.flaws?.[0] || "None", core.flaws?.[1] || "None", core.flaws?.[2] || "None"];
  for (const t of TRAITS) s.traits[t] = Number(core.traits?.[t] ?? 0);
  d.attributes = nest(core.final);
  if (core.shrine && core.preShrine) { d.preShrine = nest(core.preShrine); d.postShrine = nest(core.final); }
  d.mantras = [...core.mantras];
  d.content.mantraModifications = Object.fromEntries(d.mantras.map(m => [m, { ...(core.mantraMods?.[m] ?? {}) }]));
  const talents = [...core.talents];
  for (const [key, prefix] of [["Oath", "Oath: "], ["Murmur", "Murmur: "]]) {
    const v = s.meta[key]; if (v && v !== "None" && !talents.includes(prefix + v)) talents.push(prefix + v);
  }
  d.talents = talents;
  d.equipment = { ...emptyEquip(), ...JSON.parse(JSON.stringify(core.equipment ?? {})) };
  return d;
}

export function draftEnvelope(core) {
  return { version: 1, build: toDraft(core), phase: core.shrine ? "post" : "pre", baseline: "" };
}
