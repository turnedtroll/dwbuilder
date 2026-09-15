import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assemble, fromSpec, WARDER_CATEGORY } from "../engine/index.js";
const game = JSON.parse(readFileSync(new URL("../data/game.json", import.meta.url)));
const A = JSON.parse(readFileSync(new URL("../data/archetypes.json", import.meta.url))).archetypes;
const ref = fromSpec(JSON.parse(readFileSync(new URL("./fixtures/spec_healer_final.json", import.meta.url))));

test("healer request reproduces the shape of spec_healer_final", () => {
  const b = assemble({ role: "healer", include_attunements: ["Flamecharm"], exclude_attunements: ["Ironsing"], origin: "Justicar", oath: "Linkstrider", weapon_type: "none", multifaceted: true, must_mantras: ["Graceful Flame", "Symbiotic Sustain", "Reinforce"] }, A, game);
  assert.ok(b.validation.ok, JSON.stringify(b.validation.errors));
  for (const s of ["Charisma", "Fortitude", "Willpower", "Flamecharm"]) assert.ok(Math.abs(b.final[s] - ref.final[s]) <= 15, `${s}: got ${b.final[s]} ref ${ref.final[s]}`);
  assert.equal(b.final.Ironsing, 0);
  for (const m of ["Graceful Flame", "Symbiotic Sustain", "Reinforce"]) assert.ok(b.mantras.includes(m), m);
  assert.ok(b.talents.includes("Undying Flame"));
  const warders = b.talents.filter(t => game.talents[t]?.category === WARDER_CATEGORY && t !== "Justicar's Gift");
  assert.ok(warders.length <= 4);
  assert.ok(b.meta_score >= 70, `score ${b.meta_score}`);
  assert.ok(b.preShrine && b.preShrine.Charisma >= 85, "Charisma should be stacked pre-shrine");
});
