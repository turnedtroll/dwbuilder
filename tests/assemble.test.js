import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeRequest, selectArchetype, planStats, fitTo330, assemble } from "../engine/assemble.js";
import { pointsSpent, zeroFlat, ATTUNEMENTS, WEAPON_STATS } from "../engine/stats.js";
import { shrineOfOrder } from "../engine/shrine.js";
import { validate } from "../engine/validate.js";
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
