import test from "node:test";
import assert from "node:assert/strict";
import { canon, zeroFlat, flatten, nest, pointsSpent, powerFor, pointsForPower, reqValue, meetsStats } from "../engine/stats.js";

test("canon aliases", () => {
  assert.equal(canon("cha"), "Charisma");
  assert.equal(canon("Light Weapon"), "Light Wep.");
  assert.equal(canon("medium wep"), "Medium Wep.");
  assert.equal(canon("flame"), "Flamecharm");
  assert.equal(canon("Power"), null);
});

test("pointsSpent: first point of each extra attunement is free", () => {
  const f = zeroFlat();
  f.Charisma = 90; f.Flamecharm = 1; f.Thundercall = 1; f.Frostdraw = 1;
  assert.equal(pointsSpent(f), 90 + 3 - 2);
  f.Flamecharm = 50;
  assert.equal(pointsSpent(f), 90 + 52 - 2);
});

test("powerFor / pointsForPower follow the builder", () => {
  const f = zeroFlat();
  f.Strength = 30; assert.equal(powerFor(f), 1);
  f.Strength = 44; assert.equal(powerFor(f), 1);
  f.Strength = 45; assert.equal(powerFor(f), 2);
  f.Strength = 100; f.Fortitude = 100; f.Agility = 100; f.Intelligence = 30; assert.equal(powerFor(f), 20);
  assert.equal(pointsForPower(1), 30);
  assert.equal(pointsForPower(15), 240);
  assert.equal(pointsForPower(20), 315);
  assert.equal(pointsForPower(0), 0);
});

test("flatten/nest round trip", () => {
  const f = zeroFlat(); f["Light Wep."] = 65; f.Bloodrend = 80;
  assert.deepEqual(flatten(nest(f)), f);
  assert.equal(nest(f).weapon["Light Wep."], 65);
});

test("reqValue pseudo stats", () => {
  const f = zeroFlat(); f.Strength = 40; f.Agility = 55; f.Charisma = 70; f["Medium Wep."] = 65; f.Galebreathe = 60; f.Fortitude = 100; f.Intelligence = 30;
  assert.equal(reqValue(f, "Body"), 100);
  assert.equal(reqValue(f, "Mind"), 70);
  assert.equal(reqValue(f, "Weapon"), 65);
  assert.equal(reqValue(f, "Attunement"), 60);
  assert.equal(reqValue(f, "Medium Weapon"), 65);
  assert.equal(reqValue(f, "Power"), powerFor(f));
  assert.equal(meetsStats(f, { Charisma: 75 }), false);
  assert.equal(meetsStats(f, { Charisma: 70, Power: 10 }), true);
});
