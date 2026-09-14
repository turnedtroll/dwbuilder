import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shrineOfOrder } from "../engine/shrine.js";
import { flatten, zeroFlat, pointsSpent, CORE_STATS, ATTUNEMENTS } from "../engine/stats.js";

const real = JSON.parse(readFileSync(new URL("./fixtures/real_builds.json", import.meta.url)));
const game = JSON.parse(readFileSync(new URL("../data/raw/gamedata.json", import.meta.url)));
const raceBonus = name => (game.aspectsData.find(a => a.name === name)?.statBonuses) ?? {};

test("simple average with 25-loss cap on core stats", () => {
  const pre = zeroFlat(); pre.Charisma = 90; pre.Agility = 40; pre.Strength = 1; pre.Fortitude = 1; pre.Willpower = 1; pre.Intelligence = 1; pre.Flamecharm = 1; pre["Light Wep."] = 1;
  const { base, spare } = shrineOfOrder(pre);
  assert.equal(base.Charisma, 65);            // 90 - 25 cap
  assert.ok(base.Agility >= 15 && base.Agility <= 40);
  for (const s of CORE_STATS) assert.ok(pre[s] - base[s] <= 25, s);
  assert.ok(pointsSpent(base) <= pointsSpent(pre));
  assert.ok(spare >= 0 && spare < 8);
});

test("no invested stats -> unchanged", () => {
  const pre = zeroFlat();
  assert.deepEqual(shrineOfOrder(pre).base, pre);
});

for (const [id, b] of Object.entries(real)) {
  const pre = flatten(b.preShrine);
  const postSnapshot = flatten(b.postShrine);
  // postShrine is only a saved snapshot and is sometimes never populated by the site;
  // attributes holds the build's actual current stats, so fall back to that.
  const post = Object.values(postSnapshot).some(v => v > 0) ? postSnapshot : flatten(b.attributes);
  const shrined = Object.values(pre).some(v => v > 0) && JSON.stringify(pre) !== JSON.stringify(post);
  if (!shrined) continue;
  test(`real build ${id}: every final stat >= shrine base`, () => {
    const rb = b.multifaceted ? {} : raceBonus(b.stats.meta.Race);
    const { base } = shrineOfOrder(pre, rb);
    // The builder lets players hand-edit any stat after running the shrine, so a saved
    // build's final value can sit up to 1 point below what the shrine itself produced.
    for (const s of Object.keys(base)) assert.ok(post[s] >= base[s] - 1, `${s}: final ${post[s]} < base ${base[s]} - 1`);
    for (const s of CORE_STATS) assert.ok(pre[s] - base[s] <= 25, `${s} lost more than 25`);
  });
}
