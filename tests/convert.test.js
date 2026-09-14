import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fromFeedBuild, fromSpec, toDraft, draftEnvelope } from "../engine/convert.js";

const real = JSON.parse(readFileSync(new URL("./fixtures/real_builds.json", import.meta.url)));
const spec = JSON.parse(readFileSync(new URL("./fixtures/spec_healer_final.json", import.meta.url)));
const anyReal = Object.values(real)[0];

test("fromFeedBuild maps stats, meta, talents", () => {
  const c = fromFeedBuild(anyReal);
  assert.equal(c.oath, anyReal.stats.meta.Oath);
  assert.equal(c.final.Strength, anyReal.attributes.base.Strength);
  assert.deepEqual(c.talents, anyReal.talents);
  assert.equal(typeof c.shrine, "boolean");
});

test("fromSpec reads the healer fixture", () => {
  const c = fromSpec(spec);
  assert.equal(c.origin, "Justicar"); assert.equal(c.shrine, true);
  assert.equal(c.preShrine.Charisma, 90); assert.equal(c.final.Flamecharm, 50);
  assert.equal(c.multifaceted, true);
  assert.equal(c.mantraMods["Graceful Flame"].gem, "Blue");
});

test("toDraft produces the builder's store shape", () => {
  const d = toDraft(fromSpec(spec));
  assert.equal(d.version, 3);
  assert.equal(d.stats.buildName, spec.name);
  assert.equal(d.attributes.base.Charisma, 65);
  assert.equal(d.preShrine.base.Charisma, 90);
  assert.equal(d.postShrine.attunement.Flamecharm, 50);
  assert.ok(d.talents.includes("Oath: Linkstrider"));
  assert.equal(d.stats.meta.Oath, "Linkstrider");
  assert.deepEqual(Object.keys(d.equipment), ["Head", "Arms", "Legs", "Torso", "Face", "Earrings", "Rings"]);
  assert.equal(d.content.mantraModifications["Graceful Flame"].gem, "Blue");
  const env = draftEnvelope(fromSpec(spec));
  assert.equal(env.version, 1); assert.equal(env.phase, "post"); assert.equal(env.baseline, "");
});

test("feed -> core -> draft keeps stats identical", () => {
  const d = toDraft(fromFeedBuild(anyReal));
  assert.deepEqual(d.attributes, anyReal.attributes);
});
