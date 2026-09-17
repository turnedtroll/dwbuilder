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

test("talent_weapon_type: Shield-requiring talent with no weapon is a hard error; with a matching Shield weapon it isn't", () => {
  const noWeapon = structuredClone(healer);
  noWeapon.talents.push("Knight's Rally");
  const rNoWeapon = validate(noWeapon, game);
  assert.ok(rNoWeapon.errors.some(e => e.code === "talent_weapon_type" && e.msg.includes("Knight's Rally")), JSON.stringify(rNoWeapon.errors));

  const withShield = structuredClone(healer);
  withShield.talents.push("Knight's Rally");
  withShield.weapon = "Kite Shield"; // no reqs; healer's Fortitude 80 / Willpower 40 already meet Knight's Rally's own reqs
  const rWithShield = validate(withShield, game);
  assert.ok(!rWithShield.errors.some(e => e.code === "talent_weapon_type"), JSON.stringify(rWithShield.errors));
});

test("talent_weapon_type: per-alternative weaponType (Armor Piercing: Greatcannon/Pistol/Rifle) is enforced, not just the top-level field", () => {
  // Armor Piercing has no top-level weaponType - each `or` alternative carries its own (data/raw/gamedata.json).
  // Real build dps-heavy-jetstriker (out/builds) surfaced this live: our validator missed it because slimdata.py's
  // or_block() dropped per-alternative weaponType, so talentObtainable never saw it.
  const dagger = structuredClone(healer);
  dagger.talents.push("Armor Piercing");
  dagger.weapon = "Formless Shard"; // Dagger, not Greatcannon/Pistol/Rifle
  dagger.final["Light Wep."] = 30; dagger.final.Willpower -= 30; // keep 330, meet Armor Piercing's "Weapon: 30"
  const rDagger = validate(dagger, game);
  assert.ok(rDagger.errors.some(e => e.code === "talent_weapon_type" && e.msg.includes("Armor Piercing")), JSON.stringify(rDagger.errors));

  const pistol = structuredClone(healer);
  pistol.talents.push("Armor Piercing");
  pistol.weapon = "Silversix"; // Pistol - one of the three allowed alternatives
  pistol.final["Light Wep."] = 30; pistol.final.Willpower -= 30;
  const rPistol = validate(pistol, game);
  assert.ok(!rPistol.errors.some(e => e.code === "talent_weapon_type"), JSON.stringify(rPistol.errors));
});

test("oath_reqs: the requested oath's own stat/prerequisite requirements are enforced", () => {
  // "Oath: <name>" is itself a talent entry (rarity Oath) with real reqs/pre in game.json, but validate()'s
  // per-talent loop skips every "Oath: "/"Murmur: " entry outright (isPath), so nothing ever checked it.
  // Real build dps-heavy-blindseer (out/builds) surfaced this live: Willpower 37 final / 7 pre-shrine, both
  // below Oath: Blindseer's own Willpower 40 requirement, even though its 3 prerequisite talents were present.
  const c = structuredClone(healer);
  c.oath = "Blindseer";
  c.talents = c.talents.filter(t => !t.startsWith("Oath: ")).concat(["Oath: Blindseer", "Breathing Exercise", "Conquer your Fears", "Disbelief"]);
  c.final.Willpower = 30; c.preShrine.Willpower = 7; c.final.Charisma += 10; // keep 330, drop Willpower below 40 in both phases
  const r = validate(c, game);
  assert.ok(r.errors.some(e => e.code === "oath_reqs" && e.msg.includes("Blindseer")), JSON.stringify(r.errors));

  const ok = structuredClone(c);
  ok.final.Willpower = 40; ok.final.Charisma -= 10;
  const rOk = validate(ok, game);
  assert.ok(!rOk.errors.some(e => e.code === "oath_reqs"), JSON.stringify(rOk.errors));
});

test("oath_reqs: Oath: Contractor lists itself as a prerequisite, which must not read as unmet", () => {
  // data quirk in game.json - Oath: Contractor's own `pre` is ["Oath: Contractor"]. Since path entries
  // are never in core.talents, this self-reference must be satisfied some other way (see talentObtainable's
  // `have` set), or every Contractor build would wrongly fail oath_reqs.
  const c = structuredClone(healer);
  c.oath = "Contractor";
  c.talents = c.talents.filter(t => !t.startsWith("Oath: ")).concat(["Oath: Contractor"]);
  const r = validate(c, game);
  assert.ok(!r.errors.some(e => e.code === "oath_reqs"), JSON.stringify(r.errors));
});

test("Jus Karita: nested origin requirement (data/raw's or[1].or[0].origin) is honoured", () => {
  const wrongOrigin = structuredClone(healer);
  wrongOrigin.origin = "Castaway"; // healer fixture's own origin is Justicar, so pick a different one
  const rWrong = talentObtainable("Jus Karita", wrongOrigin, game);
  assert.ok(!rWrong.ok, JSON.stringify(rWrong));

  const justicar = structuredClone(healer); // fixture origin is already Justicar
  const rJusticar = talentObtainable("Jus Karita", justicar, game);
  assert.ok(rJusticar.ok, JSON.stringify(rJusticar));
});

// A bare 330-point core with no shrine, for tests that need full control over the stat block.
function bareCore(final, talents, extra = {}) {
  const c = structuredClone(healer);
  for (const k of Object.keys(c.final)) c.final[k] = 0;
  Object.assign(c.final, final);
  c.preShrine = null; c.shrine = false;
  c.race = "None"; c.oath = "None"; c.weapon = ""; c.outfit = "None"; c.equipment = {};
  c.talents = talents; c.mantras = [];
  return Object.assign(c, extra);
}

test("prerequisite chain must be satisfiable in one phase (builder: pre-shrine talents cannot lean on post-shrine prereqs)", () => {
  // Live sweep, dps-heavy-jetstriker-2: Magical Resolve (Willpower 40 + Battle Tendency) with pre-shrine
  // Willpower 40 / Fortitude 1 and post-shrine Willpower 30 / Fortitude 90. Magical Resolve is only met
  // pre-shrine, but Battle Tendency (Fortitude 15) is only met post-shrine - the builder evaluates the
  // whole chain per phase (post may fall back to pre for prereqs, pre may not) and says
  // "Requirements no longer satisfied".
  const c = structuredClone(healer);
  c.preShrine.Willpower = 40; c.preShrine.Fortitude = 1;
  c.final.Willpower = 30; c.final.Agility += 10; // keep 330
  c.talents.push("Battle Tendency", "Magical Resolve");
  const r = validate(c, game);
  assert.ok(r.errors.some(e => e.code === "talent_reqs" && e.msg.startsWith("Magical Resolve")), JSON.stringify(r.errors));

  const ok = structuredClone(c); ok.preShrine.Fortitude = 15; // chain now holds pre-shrine
  assert.ok(!validate(ok, game).errors.some(e => e.msg.startsWith("Magical Resolve")), JSON.stringify(validate(ok, game).errors));
});

test("`or` alternatives are mandatory on top of the top-level requirements (builder semantics)", () => {
  // Live sweep, dps-medium-irons-bladeharper: Potion Quaffer = Intelligence 30 AND (Fortitude 15 OR
  // Willpower 15). We used to treat the top-level block as a free-standing alternative, so Int 30 alone passed.
  const bad = bareCore({ Intelligence: 100, Charisma: 100, Strength: 100, Agility: 30 }, ["Potion Quaffer"]);
  const r = validate(bad, game);
  assert.ok(r.errors.some(e => e.code === "talent_reqs" && e.msg.startsWith("Potion Quaffer")), JSON.stringify(r.errors));

  const good = bareCore({ Intelligence: 100, Charisma: 100, Strength: 100, Agility: 15, Willpower: 15 }, ["Potion Quaffer"]);
  assert.ok(!validate(good, game).errors.some(e => e.msg.startsWith("Potion Quaffer")), JSON.stringify(validate(good, game).errors));
});

test("attunement tier talents (Adept/Expert/Master X, X Unbounded) follow FINAL attunement stats and are auto-granted", () => {
  // Live sweep, dps-light-bladeharper: the builder removed Master/Expert Ironsinger on load (final Ironsing
  // below their reqs; the pre-shrine value doesn't count for these) and then flagged
  // "Rending Needle: Impaler: Requires talent: Master Ironsinger".
  const listed = bareCore({ Ironsing: 40, Intelligence: 100, Charisma: 100, Strength: 90 }, ["Master Ironsinger"],
    { shrine: true, preShrine: { ...structuredClone(healer).final, Ironsing: 75 } });
  const r = validate(listed, game);
  assert.ok(r.warnings.some(e => e.code === "talent_auto_tier" && e.msg.startsWith("Master Ironsinger")), JSON.stringify(r.warnings));
  assert.ok(!r.errors.some(e => e.msg.startsWith("Master Ironsinger")), JSON.stringify(r.errors)); // the builder only drops it silently

  const dependent = bareCore({ Ironsing: 40, Intelligence: 100, Charisma: 100, Strength: 90 }, ["Master Ironsinger", "Rending Needle: Impaler"],
    { shrine: true, preShrine: { ...structuredClone(healer).final, Ironsing: 75 } });
  const r2 = validate(dependent, game);
  assert.ok(r2.errors.some(e => e.code === "talent_reqs" && e.msg.startsWith("Rending Needle: Impaler")), JSON.stringify(r2.errors));

  // Qualifying tier talents count as had even when not listed - the builder adds them itself.
  const granted = bareCore({ Ironsing: 75, Intelligence: 100, Charisma: 100, Strength: 55 }, ["Rending Needle: Impaler"]);
  assert.ok(talentObtainable("Rending Needle: Impaler", granted, game).ok, JSON.stringify(talentObtainable("Rending Needle: Impaler", granted, game)));
  assert.deepEqual(validate(granted, game).errors.filter(e => e.msg.includes("Rending Needle")), []);
});

test("resolveTalent strips variant suffix and ignores case", () => {
  assert.equal(resolveTalent("Wyvern's Claw [LHT]", game), "Wyvern's Claw");
  assert.equal(resolveTalent("To the Finish", game), "To The Finish");
  assert.equal(resolveTalent("Reinforced Armor", game), "Reinforced Armor");
  assert.equal(resolveTalent("Definitely Not A Talent", game), null);
});

test("top 30 corpus builds by views validate with (almost) zero hard errors", () => {
  // stored pointSpent is stale for ~8% of the feed; require our own formula to agree so we test the validator, not the feed
  const seen = new Set();
  const top = feeds.filter(b => b.stats.pointSpent === 330 && b.talents.length && pointsSpent(fromFeedBuild(b).final) === 330)
    .sort((a, b) => b.meta.views - a.meta.views)
    .filter(b => !seen.has(b.id) && seen.add(b.id))
    .slice(0, 30);
  // talent_weapon_type: real players keep Shield-only talents (Turtle Shell, Knight's Rally, ...) while
  // wielding an unrelated weapon at a nontrivial rate in this corpus (5 of the top 16 unique builds here) -
  // corpus noise like the other SOFT codes, not a validator gap (see the real-builder-verified rule in validate.js).
  const SOFT = ["warder_cap", "mantra_slots", "unknown_talent", "unknown_mantra", "weapon_reqs", "outfit_reqs", "talent_weapon_type"];
  const bad = [], unresolved = new Set(), unknownMantras = new Set();
  for (const b of top) {
    const r = validate(fromFeedBuild(b), game);
    for (const e of r.errors) { if (e.code === "unknown_talent") unresolved.add(e.msg); if (e.code === "unknown_mantra") unknownMantras.add(e.msg); }
    const hard = r.errors.filter(e => !SOFT.includes(e.code));
    if (hard.length) bad.push({ id: b.id, errors: hard.slice(0, 3) });
  }
  // published builds with genuine inconsistencies (prereq/stat/race violations the builder itself would flag); a NEW id here is a validator regression
  const KNOWN_INCONSISTENT = new Set(["K6tHCbzu", "HpX7upTq", "SPkeXytO", "sTWc9aJe", "K1sdDhdj"]);
  assert.ok(bad.every(b => KNOWN_INCONSISTENT.has(b.id)), JSON.stringify(bad.filter(b => !KNOWN_INCONSISTENT.has(b.id)), null, 1));
  assert.ok(unresolved.size <= 5, `unresolved talents: ${[...unresolved]}`);
  assert.ok(unknownMantras.size <= 2, `unknown mantras: ${[...unknownMantras]}`);
});
