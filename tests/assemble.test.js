import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeRequest, selectArchetype, planStats, fitTo330, assemble } from "../engine/assemble.js";
import { pointsSpent, zeroFlat, ATTUNEMENTS, WEAPON_STATS, meetsStats } from "../engine/stats.js";
import { shrineOfOrder } from "../engine/shrine.js";
import { validate, talentBudget } from "../engine/validate.js";
const game = JSON.parse(readFileSync(new URL("../data/game.json", import.meta.url)));
const A = JSON.parse(readFileSync(new URL("../data/archetypes.json", import.meta.url))).archetypes;

test("selectArchetype respects role and excludes", () => {
  const { archetype, adapted } = selectArchetype(normalizeRequest({ role: "healer", include_attunements: ["Flamecharm"], exclude_attunements: ["Ironsing"] }), A);
  assert.equal(archetype.role, "healer");
  assert.ok(archetype.post_shrine_modal.Ironsing < 20 || adapted);
});

test("planStats hits 330 and respects shrine base + excludes for every archetype", () => {
  for (const a of A) {
    const req = normalizeRequest({ role: a.role, exclude_attunements: ["Ironsing"] });
    const p = planStats(req, a, game);
    assert.equal(pointsSpent(p.final), 330, a.id);
    assert.equal(p.final.Ironsing, 0, a.id);
    for (const s of Object.keys(p.final)) assert.ok(p.final[s] >= 0 && p.final[s] <= 100, `${a.id} ${s}`);
    if (p.preShrine) {
      const bonus = p.multifaceted ? {} : (game.races[p.race] ?? {});
      const { base } = shrineOfOrder(p.preShrine, bonus);
      for (const s of Object.keys(base)) assert.ok(p.final[s] >= base[s], `${a.id} ${s} final ${p.final[s]} < base ${base[s]}`);
      assert.ok(p.shrinePower >= 8 && p.shrinePower <= 19, `${a.id} shrine power ${p.shrinePower}`);
      assert.ok(p.preShrine[a.stack.stat] >= a.stack.min, `${a.id} stack`);
    }
  }
});

test("weapon none zeroes weapon stats; include adds attunement", () => {
  const a = A.find(x => x.role === "healer");
  const p = planStats(normalizeRequest({ role: "healer", weapon_type: "none", include_attunements: ["Thundercall"] }), a, game);
  for (const w of WEAPON_STATS) assert.equal(p.final[w], 0);
  assert.ok(p.final.Thundercall >= 20);
  assert.equal(pointsSpent(p.final), 330);
});

test("fitTo330 records every raise, even ones that land below the stat's own p75", () => {
  // Only Strength is invested (already at 100, its own p75); everything else starts at 0.
  // Phase B has nothing left to raise (Strength is already capped), so phase C spills into the
  // untouched BASE_STATS by descending p75: Fortitude and Agility fill all the way to 100, and the
  // remaining deficit lands Intelligence at 30 — short of its own p75 of 65. That raise must still
  // be reported.
  const target = zeroFlat();
  target.Strength = 100;
  const floor = zeroFlat();
  const priority = new Set(["Strength"]);
  const spread = Object.fromEntries(Object.keys(zeroFlat()).map(s => [s, { p25: 0, p50: 0, p75: 0 }]));
  spread.Strength.p75 = 100;
  spread.Fortitude.p75 = 100;
  spread.Agility.p75 = 100;
  spread.Intelligence.p75 = 65;
  spread.Willpower.p75 = 50;
  spread.Charisma.p75 = 10;

  const { final, raised } = fitTo330(target, floor, priority, spread, "Strength");
  assert.equal(pointsSpent(final), 330);
  assert.equal(final.Intelligence, 30);

  const touched = raised.find(r => r.stat === "Intelligence");
  assert.ok(touched, "Intelligence's 0 -> 30 raise should be recorded even though 30 < its p75 of 65");

  for (const s of Object.keys(final)) {
    if (final[s] > (target[s] ?? 0)) assert.ok(raised.some(r => r.stat === s), `${s} raised but missing from the raised list`);
  }
});

test("assemble: every archetype's default request is valid; meta score >= 70 for >= 97% and >= 60 for all", () => {
  const invalid = [], low = [], veryLow = [];
  for (const a of A) {
    const b = assemble({ role: a.role, oath: a.oath[0]?.[0] ?? null }, A.filter(x => x.id === a.id), game);
    if (!b.validation.ok) invalid.push({ id: a.id, errors: b.validation.errors.slice(0, 4) });
    if (b.meta_score < 70) low.push({ id: a.id, score: b.meta_score, breakdown: b.score_breakdown });
    if (b.meta_score < 60) veryLow.push({ id: a.id, score: b.meta_score });
  }
  assert.deepEqual(invalid, [], JSON.stringify(invalid, null, 1));
  assert.deepEqual(veryLow, [], JSON.stringify(veryLow, null, 1));
  // spec §7.4 asks for >= 70 everywhere; 3 medoids have pre/post blocks that do not reconcile under Shrine of Order (controller ruling R10)
  assert.ok(low.length <= Math.floor(A.length * 0.03), JSON.stringify(low, null, 1));
});

test("kits are player-sized: every default build respects the talent budget and its archetype's mantra count", () => {
  for (const a of A) {
    const b = assemble({ role: a.role, oath: a.oath[0]?.[0] ?? null }, [a], game);
    const bud = talentBudget(b, game);
    assert.ok(bud.counting <= bud.cap, `${a.id}: ${bud.counting} counting talents > cap ${bud.cap} (mantras ${bud.mantras})`);
    assert.ok(bud.mantras <= Math.max(a.budget.mantras, 1), `${a.id}: ${bud.mantras} Normal mantras > archetype budget ${a.budget.mantras}`);
    assert.ok(b.mantraGroups && Array.isArray(b.mantraGroups.equipped) && Array.isArray(b.mantraGroups.extra), a.id);
    assert.ok(!b.validation.errors.some(e => e.code === "talent_budget"), a.id);
  }
});

test("gear carries real stars and pips; weapons carry stars (DMG%/PEN%) and an enchant", () => {
  const PIPS = new Set(["Health", "Ether", "Physical Armor", "Posture", "Sanity", "Anchor", "Elemental Armor"]);
  for (const a of A) {
    const b = assemble({ role: a.role, oath: a.oath[0]?.[0] ?? null }, [a], game);
    const items = [...Object.entries(b.equipment).filter(([k]) => k !== "Rings").map(([, v]) => v), ...(b.equipment.Rings ?? [])].filter(Boolean);
    for (const it of items) {
      assert.ok([2, 3].includes(it.qualityStars), `${a.id}: ${it.name} stars ${it.qualityStars}`);
      assert.ok(it.pips.length >= 1, `${a.id}: ${it.name} has no pips`);
      for (const p of it.pips) assert.ok(PIPS.has(p.stat) && p.rarity, `${a.id}: ${it.name} pip ${JSON.stringify(p)}`);
      if (it.pips.length >= 3) assert.ok(new Set(it.pips.map(p => p.stat)).size > 1, `${a.id}: ${it.name} has every pip in ${it.pips[0].stat} (builder warns)`);
    }
    if (b.weapon) {
      assert.ok(["DMG%", "PEN%"].includes(b.weaponStars?.mod) && b.weaponStars.count === 3, `${a.id}: weaponStars ${JSON.stringify(b.weaponStars)}`);
      assert.ok(b.enchant, `${a.id}: no enchant for ${b.weapon}`);
      assert.deepEqual(b.draft.weaponStars, b.weaponStars);
    }
  }
});

test("a requested weapon is planned for: its stat and requirements are met and the other weapon stats are zeroed", () => {
  // Duskguard Axe: Heavy Weapon 75, Strength 10 - requested on the light-weapon dps archetype.
  const a = A.find(x => x.id.startsWith("dps-light-") && x.weapons?.length);
  const b = assemble({ role: a.role, weapon: "Duskguard Axe" }, [a], game);
  assert.equal(b.weapon, "Duskguard Axe");
  assert.ok(b.final["Heavy Wep."] >= 75 && b.final.Strength >= 10, JSON.stringify(b.final));
  assert.equal(b.final["Light Wep."], 0); assert.equal(b.final["Medium Wep."], 0);
  assert.ok(!b.validation.errors.some(e => e.code === "weapon_reqs"), JSON.stringify(b.validation.errors));
  assert.ok(b.validation.ok, JSON.stringify(b.validation.errors));
});

test("a requested oath is honoured before the archetype's shrine plan: Visionshaper on the attunementless tank drops the shrine, not the oath", () => {
  const a = A.find(x => x.id.startsWith("tank-none-") && x.oath[0]?.[0] !== "Visionshaper");
  const b = assemble({ role: a.role, oath: "Visionshaper" }, [a], game);
  assert.equal(b.oath, "Visionshaper");
  assert.ok(b.final.Charisma >= 50, `Charisma ${b.final.Charisma}`);
  assert.ok(!b.validation.errors.some(e => e.code === "oath_reqs"), JSON.stringify(b.validation.errors));
  assert.ok(b.notes.includes("Shrine of Order dropped") || b.shrine === false || b.final.Charisma >= 50);
});

test("equipment requirements and trait caps are respected on every default build", () => {
  for (const a of A) {
    const b = assemble({ role: a.role, oath: a.oath[0]?.[0] ?? null }, [a], game);
    const items = [...Object.entries(b.equipment).filter(([k]) => k !== "Rings").map(([, v]) => v), ...(b.equipment.Rings ?? [])].filter(Boolean);
    assert.equal(items.length, 10, `${a.id}: every gear slot filled (${items.length}/10)`);
    for (const it of items) {
      assert.ok(game.equipment[it.name], `${a.id}: ${it.name} is not a current equippable item`);
      assert.ok(meetsStats(b.final, game.equipment[it.name]?.reqs ?? {}), `${a.id}: ${it.name} needs ${JSON.stringify(game.equipment[it.name]?.reqs)}`);
    }
    const tv = Object.values(b.traits);
    assert.ok(tv.every(v => v >= 0 && v <= 6) && tv.reduce((x, y) => x + y, 0) <= 12, `${a.id}: traits ${JSON.stringify(b.traits)}`);
    assert.ok(!b.validation.errors.some(e => e.code === "equipment_reqs" || e.code === "traits"), a.id);
  }
});

test("pips favour Health wherever the slot can roll it, with one pip in the slot's secondary stat", () => {
  const b = assemble({ role: "tank" }, A, game);
  const major = { Head: "Health", Arms: "Health", Legs: "Health", Torso: "Health", Rings: "Health", Face: "Ether", Earrings: "Ether" };
  for (const [slot, item] of Object.entries(b.equipment)) {
    for (const it of (Array.isArray(item) ? item : [item]).filter(Boolean)) {
      const stats = it.pips.map(p => p.stat);
      const n = stats.filter(x => x === major[slot]).length;
      assert.ok(n >= stats.length - 1 && n >= 1, `${slot} ${it.name}: ${stats.join(",")}`);
      if (stats.length >= 3) assert.ok(new Set(stats).size === 2, `${slot} ${it.name}: ${stats.join(",")}`);
    }
  }
});

test("friend's request: heavy Galebreathe weapon + Oathless + must Ghost picks a heavy Galebreathe archetype, keeps its shrine and takes Ghost's chain", () => {
  const b = assemble({ role: "dps", include_attunements: ["Galebreathe"], weapon_type: "heavy", weapon: "Withered Gale Pale", oath: "Oathless", origin: "Lone Warrior", must_talents: ["Ghost"], multifaceted: true }, A, game);
  assert.ok(b.based_on.archetype.startsWith("dps-heavy-galeb"), b.based_on.archetype);
  assert.ok(b.shrine && b.preShrine, "shrine kept");
  assert.ok(b.final["Heavy Wep."] >= 75 && b.final.Galebreathe >= 90, JSON.stringify(b.final));
  for (const t of ["Ghost", "Swift Rebound", "Evasive Expert", "Risky Moves"]) assert.ok(b.talents.includes(t), `${t} missing`);
  assert.ok(b.validation.ok && b.meta_score >= 70, `${b.meta_score} ${JSON.stringify(b.validation.errors)}`);
});

test("or-alternative and pseudo-stat requirements are planned (Silentheart's Agility 25 | Charisma 25; Guiding Star's Mind)", () => {
  const s = assemble({ role: "dps", oath: "Silentheart" }, A, game);
  assert.ok(!s.validation.errors.some(e => e.code === "oath_reqs"), JSON.stringify(s.validation.errors));
  const g = assemble({ role: "dps", weapon: "Guiding Star" }, A, game);
  assert.ok(!g.validation.errors.some(e => e.code === "weapon_reqs"), JSON.stringify(g.validation.errors));
});

test("pre-shrine coherence: a base stat is levelled only as far as the taken talents need before the shrine", () => {
  const b = assemble({ role: "dps", include_attunements: ["Galebreathe"], weapon_type: "heavy", weapon: "Withered Gale Pale", oath: "Oathless", origin: "Lone Warrior", must_talents: ["Ghost"], multifaceted: true }, A, game);
  const needAgi = Math.max(0, ...b.talents.map(t => game.talents[t]?.reqs?.Agility ?? 0));
  // a few points may return to the stat to hold Power 8 (135 points), never the old 91
  assert.ok(b.preShrine.Agility <= needAgi + 10, `pre Agility ${b.preShrine.Agility} but the kit's top Agility threshold is ${needAgi}`);
  assert.ok(b.preShrine.Agility >= needAgi, "still reaches every taken Agility talent");
  assert.ok(b.validation.ok && b.meta_score >= 85, `${b.meta_score}`);
});

test("a 100-attunement build with weak weapon investment arms the matching Hero's Blade (attunement rounded up from 95-99)", () => {
  const a = A.find(x => x.id === "bossraid-none-frost-oathless");
  const b = assemble({ role: a.role, oath: a.oath[0][0] }, [a], game);
  assert.equal(b.final.Frostdraw, 100, `Frostdraw ${b.final.Frostdraw}`);
  assert.equal(b.weapon, "Hero's Blade of Frost");
  assert.ok(b.validation.ok, JSON.stringify(b.validation.errors));
  // a Heavy 100 / Galebreathe 100 build keeps its heavy weapon: Hero's Blades don't scale with the weapon stat
  const h = assemble({ role: "dps", include_attunements: ["Galebreathe"], weapon_type: "heavy" }, A, game);
  assert.ok(!h.weapon.startsWith("Hero's Blade"), h.weapon);
});

test("R7: fitTo330 relaxes a truly unfit floor instead of throwing, and says so", () => {
  // Five Unbounded talents at 75 each = 375 points: impossible, so the planner degrades with a
  // "could not fit" note instead of crashing, and validation reports what is unmet.
  const a = A.find(x => x.id.startsWith("tank-none-"));
  const req = normalizeRequest({ role: a.role, must_talents: ["Fortitude Unbounded", "Willpower Unbounded", "Agility Unbounded", "Intelligence Unbounded", "Charisma Unbounded"] });
  let p;
  assert.doesNotThrow(() => { p = planStats(req, a, game); });
  assert.equal(pointsSpent(p.final), 330);
  assert.ok(p.notes.some(n => n.includes("could not fit")), JSON.stringify(p.notes, null, 1));
});

test("assemble: attunement include/exclude and weapon types stay valid", () => {
  const combos = [];
  for (const role of ["healer", "dps", "tank", "mage"]) for (const att of ATTUNEMENTS) combos.push({ role, include_attunements: [att] }, { role, exclude_attunements: [att] });
  for (const wt of ["light", "medium", "heavy", "none"]) combos.push({ role: "dps", weapon_type: wt }, { role: "tank", weapon_type: wt });
  combos.push({ role: "healer", shrine: false }, { role: "dps", shrine: false, weapon_type: "heavy" });
  const bad = [];
  for (const c of combos) { const b = assemble(c, A, game); if (!b.validation.ok) bad.push({ c, errors: b.validation.errors.slice(0, 3) }); }
  assert.deepEqual(bad, [], JSON.stringify(bad, null, 1));
});

test("must/avoid are honoured or reported", () => {
  const b = assemble({ role: "healer", must_talents: ["Command: Live"], avoid_mantras: ["Flame of Denial"], avoid_talents: ["Flame of Denial"] }, A, game);
  assert.ok(b.talents.includes("Command: Live") || b.validation.warnings.some(w => w.msg.includes("Command: Live")));
  assert.ok(!b.mantras.includes("Flame of Denial")); assert.ok(!b.talents.includes("Flame of Denial"));
  assert.ok(b.final.Charisma >= 75);
});

test("guide and draft are populated", () => {
  const b = assemble({ role: "dps" }, A, game);
  assert.ok(b.guide.length >= 3);
  assert.ok(b.guide.some(g => g.phase === "shrine"));
  assert.equal(b.draft.version, 3);
  assert.equal(b.draft.stats.buildName, b.name);
});

test("guide post-phase order: only requested stats jump the queue", () => {
  const b1 = assemble({ role: "mage" }, A, game);
  const steps1 = b1.guide.filter(g => g.phase === "post").map(g => g.step);
  const vals1 = steps1.map(s => b1.final[s.split(" →")[0]]);
  for (let i = 1; i < vals1.length; i++) {
    assert.ok(vals1[i] <= vals1[i - 1], JSON.stringify({ steps: steps1, vals: vals1 }));
  }

  const b2 = assemble({ role: "mage", include_attunements: ["Frostdraw"] }, A, game);
  const steps2 = b2.guide.filter(g => g.phase === "post").map(g => g.step);
  const frostdrawGrew = steps2.some(s => s.startsWith("Frostdraw →"));
  if (frostdrawGrew) assert.ok(steps2[0].startsWith("Frostdraw →"), JSON.stringify(steps2));
});
