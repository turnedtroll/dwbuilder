import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scoreBuild } from "../engine/score.js";
import { fromFeedBuild } from "../engine/convert.js";
const A = JSON.parse(readFileSync(new URL("../data/archetypes.json", import.meta.url))).archetypes;
const game = JSON.parse(readFileSync(new URL("../data/game.json", import.meta.url)));
const feeds = [...JSON.parse(readFileSync(new URL("../data/raw/feed_top.json", import.meta.url))), ...JSON.parse(readFileSync(new URL("../data/raw/feed_popular.json", import.meta.url)))];

test("example builds score higher against their own archetype than against the rest", () => {
  let strong = 0;
  for (const a of A) {
    const b = fromFeedBuild(feeds.find(f => f.id === a.example_ids[0]));
    const own = scoreBuild(b, a, game).score;
    const others = A.filter(o => o !== a).map(o => scoreBuild(b, o, game).score).sort((x, y) => x - y);
    const median = others[Math.floor(others.length / 2)], p90 = others[Math.floor(others.length * 0.9)];
    assert.ok(own > median, `${a.id}: own ${own} <= median-of-others ${median}`);
    if (own >= p90) strong++;
  }
  assert.ok(strong >= Math.floor(A.length * 0.9), `only ${strong}/${A.length} examples beat the 90th percentile of other archetypes`);
});

test("empty build scores low", () => {
  const core = fromFeedBuild(feeds[0]); core.talents = []; core.mantras = []; for (const k in core.final) core.final[k] = 0;
  assert.ok(scoreBuild(core, A[0], game).score < 40);
});
