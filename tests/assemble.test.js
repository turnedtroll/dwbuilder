import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeRequest, selectArchetype, planStats, fitTo330 } from "../engine/assemble.js";
import { pointsSpent, zeroFlat, ATTUNEMENTS, WEAPON_STATS } from "../engine/stats.js";
import { shrineOfOrder } from "../engine/shrine.js";
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
