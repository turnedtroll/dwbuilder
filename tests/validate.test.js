import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validate, mantraSlots, mantraUsage, talentObtainable, resolveTalent } from "../engine/validate.js";
import { fromFeedBuild, fromSpec } from "../engine/convert.js";
import { pointsSpent } from "../engine/stats.js";

const game = JSON.parse(readFileSync(new URL("../data/game.json", import.meta.url)));
const real = JSON.parse(readFileSync(new URL("./fixtures/real_builds.json", import.meta.url)));
const healer = fromSpec(JSON.parse(readFileSync(new URL("./fixtures/spec_healer_final.json", import.meta.url))));
const feeds = [...JSON.parse(readFileSync(new URL("../data/raw/feed_top.json", import.meta.url))), ...JSON.parse(readFileSync(new URL("../data/raw/feed_popular.json", import.meta.url)))];
const codes = r => r.errors.map(e => e.code);

test("healer fixture has no hard errors beyond its known inconsistencies", () => {
  // fixture is the user's reference build: 328 points, Frostdraw 20 (< shrine base 24), 11 mantras for 9 slots, 6 Warder talents
  const KNOWN = ["points", "warder_cap", "mantra_slots"];
  const r = validate(healer, game);
  assert.deepEqual(codes(r).filter(c => !KNOWN.includes(c)), [], JSON.stringify(r.errors));
  assert.ok(r.warnings.some(w => w.code === "shrine_base" && w.msg.startsWith("Frostdraw")), JSON.stringify(r.warnings));
});

test("points error when total != 330", () => {
  const c = structuredClone(healer); c.final.Agility += 5;
  assert.ok(codes(validate(c, game)).includes("points"));
});

test("talent_reqs when a stat is too low for a talent", () => {
  const c = structuredClone(healer); c.preShrine.Charisma = 60; c.final.Charisma = 60; c.final.Agility += 5; // keep 330
  const r = validate(c, game);
  assert.ok(r.errors.some(e => e.code === "talent_reqs" && e.msg.includes("Command: Live")), JSON.stringify(r.errors));
});

test("missing prerequisite is an error", () => {
  const c = structuredClone(healer); c.talents = c.talents.filter(t => t !== "Vow of Mastery");
  assert.ok(validate(c, game).errors.some(e => e.code === "talent_reqs" && e.msg.includes("Command: Live")));
});

test("unknown names", () => {
  const c = structuredClone(healer); c.talents.push("Karita Aid"); c.mantras.push("Not A Mantra");
  const cs = codes(validate(c, game));
  assert.ok(cs.includes("unknown_talent")); assert.ok(cs.includes("unknown_mantra"));
});

test("warder cap", () => {
  const r = validate(healer, game);
  const warders = healer.talents.filter(t => game.talents[t]?.category === "Warder Techniques" && t !== "Justicar's Gift");
  assert.equal(codes(r).includes("warder_cap"), warders.length > 4);
});

test("mantra slots: base + oath", () => {
  const s = mantraSlots(healer, game);
  assert.equal(s.Combat, 3 + (game.oaths.Linkstrider.slots.Combat ?? 0));
  assert.equal(s.Support, 1 + (game.oaths.Linkstrider.slots.Support ?? 0));
  // 8 Normal-type mantras (5 Support, 2 Mobility, 1 Wisp) against Support 3 + Mobility 1 + Wildcard 2 usable slots
  assert.equal(mantraUsage(healer, game).overflow, 2);
});

test("resolveTalent strips variant suffix and ignores case", () => {
  assert.equal(resolveTalent("Wyvern's Claw [LHT]", game), "Wyvern's Claw");
  assert.equal(resolveTalent("To the Finish", game), "To The Finish");
  assert.equal(resolveTalent("Reinforced Armor", game), "Reinforced Armor");
  assert.equal(resolveTalent("Definitely Not A Talent", game), null);
});

test("top 30 corpus builds by views validate with (almost) zero hard errors", () => {
  // stored pointSpent is stale for ~8% of the feed; require our own formula to agree so we test the validator, not the feed
  const top = feeds.filter(b => b.stats.pointSpent === 330 && b.talents.length && pointsSpent(fromFeedBuild(b).final) === 330)
    .sort((a, b) => b.meta.views - a.meta.views).slice(0, 30);
  const SOFT = ["warder_cap", "mantra_slots", "unknown_talent", "unknown_mantra", "weapon_reqs", "outfit_reqs"];
  const bad = [], unresolved = new Set(), unknownMantras = new Set();
  for (const b of top) {
    const r = validate(fromFeedBuild(b), game);
    for (const e of r.errors) { if (e.code === "unknown_talent") unresolved.add(e.msg); if (e.code === "unknown_mantra") unknownMantras.add(e.msg); }
    const hard = r.errors.filter(e => !SOFT.includes(e.code));
    if (hard.length) bad.push({ id: b.id, errors: hard.slice(0, 3) });
  }
  // published builds can be genuinely inconsistent (K6tHCbzu has Conditioned Runner without its prerequisite Scaredy Cat); tolerate 2 of 30
  assert.ok(bad.length <= 2, JSON.stringify(bad, null, 1));
  assert.ok(unresolved.size <= 5, `unresolved talents: ${[...unresolved]}`);
  assert.ok(unknownMantras.size <= 2, `unknown mantras: ${[...unknownMantras]}`);
});
