# dwbuilder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A published, shareable web page that turns dropdown choices into a verified, high-quality Deepwoken build (stats, shrine plan, talents, mantras, gear, guide) with one-click import into the deepwoken.co builder.

**Architecture:** A Python pipeline mines ~880 high-view deepwoken.co builds into `data/archetypes.json` and trims the builder's game data into `data/game.json`. A dependency-free JavaScript engine (ES modules, run identically by `node --test` and the browser) selects an archetype, plans pre-shrine → shrine → post-shrine stats using a direct port of the builder's own shrine and points math, picks talents/mantras/gear, validates everything against game data, and scores similarity to the corpus. A single-page artifact loads the engine + data and offers Copy code / bookmarklet import / optional Claude refine / shared library.

**Tech Stack:** Python 3 (stdlib only for pipeline; Playwright for the builder check), Node ≥ 20 (`node --test`, ESM), vanilla HTML/CSS/JS, claude.ai Artifact with `sample` + `db` capabilities.

**Spec:** `docs/superpowers/specs/2026-09-13-dwbuilder-design.md`

## Global Constraints

- Repo root: `C:\Users\G-Force\Downloads\dwbuilder` (git initialised; commit after every task).
- Engine files are plain ES modules with **no imports from node_modules** and no Node-only APIs (must run in a browser unchanged). Tests may use `node:fs`, `node:test`, `node:assert`.
- Raw inputs live in `data/raw/` (git-ignored): `feed_top.json`, `feed_popular.json`, `gamedata.json`, copied from `C:\Users\G-Force\AppData\Local\Temp\claude\`.
- Stat names are the builder's: base `Strength, Fortitude, Agility, Intelligence, Willpower, Charisma`; weapon `Heavy Wep., Medium Wep., Light Wep.`; attunements `Flamecharm, Frostdraw, Thundercall, Galebreathe, Shadowcast, Ironsing, Bloodrend`. Game-data requirements use `Light Weapon / Medium Weapon / Heavy Weapon` and pseudo-stats `Power, Body, Mind, Weapon, Attunement` — alias them, never rename the builder's keys.
- Total build points = 330. Points spent = sum of all stats minus one per attunement *after the first* that has > 0 points (the builder's `Pn`). Power = clamp(⌊(points − 15) / 15⌋, 0, 20).
- Shrine of Order = **direct port** of the builder's `$b` (given in Task 3), not the older `shrine_sim.py` approximation.
- Race stat bonuses are added into `base` stats (and count toward the 330) unless `multifaceted` is true — this is how the builder and every corpus build store them.
- Mantra slots: base `{Combat:3, Mobility:1, Support:1, Wisp:0, Wildcard:1}` + oath `slots`; `Neuroplasticity` talent +1 Wildcard; talents containing `Will o' Wisp` or `Chorus of Souls` +1 Wisp each. Only mantras with `type === "Normal"` consume slots; overflow order Wisp→Support→Wildcard.
- Warder Techniques (talent category `"Warder Techniques"`, excluding the outfit-granted `Justicar's Gift`) are capped at 4.
- Workers: implementation on **Sonnet**, mechanical verification on **Haiku**. Never Opus.
- Windows: the shell hook mangles `grep` with regex braces — do text searches in Python or with the Grep tool. Use `python` (3.x) and `node` from PATH.
- Commit message trailer on every commit:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01NHhY9JsqJRrPhffAchV3bY
  ```

---

## File map

| Path | Responsibility |
|---|---|
| `package.json` | `"type":"module"`, `npm test` → `node --test tests/` |
| `data/raw/*` | untracked inputs |
| `data/game.json`, `data/game.js` | trimmed game data (json for tests, `export default` js for the page) |
| `data/archetypes.json`, `data/archetypes.js` | mined archetype library |
| `pipeline/slimdata.py` | gamedata.json → game.json/js |
| `pipeline/mine.py` | feed json → archetypes.json/js |
| `pipeline/dwfill.py` | copied as-is from temp dir (builder loader) |
| `pipeline/verify_builder.py` | engine build → real builder → report |
| `pipeline/test_slimdata.py`, `pipeline/test_mine.py` | unittest for pipeline |
| `engine/stats.js` | stat names, aliases, points/power math |
| `engine/shrine.js` | Shrine of Order port |
| `engine/convert.js` | feed build ⇄ BuildCore ⇄ builder draft object |
| `engine/validate.js` | requirement/slot/point validation |
| `engine/score.js` | meta score vs archetype |
| `engine/assemble.js` | request + archetypes + game → Build |
| `engine/index.js` | re-exports |
| `tests/*.test.js`, `tests/fixtures/*` | engine tests |
| `page/index.html` | the artifact page |
| `README.md` | how to refresh data and republish |

### Shared types (used by every engine task)

```js
// Flat: every one of the 16 stat names present, integer ≥ 0.
// Nested (builder shape): {base:{6}, weapon:{3}, attunement:{7}}.

// BuildCore — what validate/score/convert operate on
{
  name: string, description: string, notes: string,
  origin: string, oath: string, race: string, murmur: string, bell: string,
  outfit: string, weapon: string, enchant: string,
  boons: [string, string], flaws: [string, string, string],
  traits: {Vitality, Erudition, Proficiency, Songchant},
  multifaceted: boolean,
  shrine: boolean,
  preShrine: Flat | null,     // null when shrine === false
  final: Flat,                // stats at Power 20 (includes race bonus unless multifaceted)
  talents: string[],
  mantras: string[],
  mantraMods: { [mantra]: {gem: string, spark: string} },
  equipment: { Head, Arms, Legs, Torso, Face, Earrings: object|null, Rings: [4 × object|null] }
}

// Build — assemble() output = BuildCore plus:
{
  archetype_id, adapted: boolean, meta_score: number,
  based_on: {members: number, examples: string[]},
  shrine_power: number|null, shrine_base: Flat|null,
  talent_groups: {core: string[], recommended: string[], choose: {[label]: string[]}},
  guide: [{phase: "pre"|"shrine"|"post", step: string, unlocks: string[]}],
  validation: {ok, errors: [{code, msg}], warnings: [{code, msg}]},
  draft: object   // builder store-shaped build (convert.toDraft)
}
```

---

### Task 1: Repo scaffold, raw data, fixtures

**Files:**
- Create: `package.json`, `README.md` (stub), `data/raw/` (copied), `pipeline/dwfill.py` (copied), `tests/fixtures/spec_healer_final.json`, `tests/fixtures/real_builds.json`
- Modify: `.gitignore`

- [ ] **Step 1: package.json**

```json
{
  "name": "dwbuilder",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/",
    "pipeline": "python pipeline/slimdata.py && python pipeline/mine.py",
    "pytest": "python -m unittest discover -s pipeline -p \"test_*.py\""
  }
}
```

- [ ] **Step 2: copy raw inputs and dwfill**

```powershell
New-Item -ItemType Directory -Force data\raw, pipeline, tests\fixtures, engine, page | Out-Null
$t = "$env:LOCALAPPDATA\Temp\claude"
Copy-Item "$t\feed_top.json","$t\feed_popular.json","$t\gamedata.json" data\raw\
Copy-Item "$t\dwfill.py" pipeline\dwfill.py
Copy-Item "$t\spec_healer_final.json" tests\fixtures\spec_healer_final.json
```

- [ ] **Step 3: real-build fixture** — write `pipeline/make_fixture.py` and run it:

```python
"""Extract 6 known real builds (full feed records) into tests/fixtures/real_builds.json."""
import json
IDS = ["OQMQnXmo", "4S7J6sgE", "6K7mUdpm", "HG4L474U", "PB7C3oJn", "NZe5i03G"]
builds = {}
for f in ("data/raw/feed_top.json", "data/raw/feed_popular.json"):
    for b in json.load(open(f, encoding="utf-8")):
        if b["id"] in IDS:
            builds[b["id"]] = b
missing = [i for i in IDS if i not in builds]
print("found", sorted(builds), "missing", missing)
json.dump(builds, open("tests/fixtures/real_builds.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
```

Run: `python pipeline/make_fixture.py`. Expected: at least 4 of the 6 ids found (missing ones are simply absent from the feed; note them in the commit message).

- [ ] **Step 4: .gitignore additions** — ensure it contains `data/raw/`, `node_modules/`, `pipeline/chrome-profile/`, `*.png`, `__pycache__/`.

- [ ] **Step 5: verify `npm test` runs (no tests yet)**

Run: `npm test`. Expected: exit 0, "tests 0".

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold dwbuilder repo, fixtures, raw data copy script"
```

---

### Task 2: `engine/stats.js` — names, aliases, points and power

**Files:**
- Create: `engine/stats.js`, `tests/stats.test.js`

**Interfaces — Produces:**
```js
export const BASE_STATS, WEAPON_STATS, ATTUNEMENTS, CORE_STATS /* base+weapon */, ALL_STATS;
export function canon(name) -> string|null            // "cha"→"Charisma", "Light Weapon"→"Light Wep.", "Power"→null
export function zeroFlat() -> Flat
export function flatten(nested) -> Flat
export function nest(flat) -> nested
export function pointsSpent(flat) -> number           // builder Pn
export function powerFor(flat) -> number              // builder Kn
export function pointsForPower(p) -> number           // 15*p + 15 (p ≥ 1); 0 for p = 0
export function reqValue(flat, reqName) -> number     // resolves Power/Body/Mind/Weapon/Attunement/aliases
export function meetsStats(flat, reqs) -> boolean     // every reqs[k] <= reqValue(flat,k)
```

- [ ] **Step 1: failing tests** — `tests/stats.test.js`

```js
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
```

- [ ] **Step 2: run, expect failure** — `npm test` → fails "Cannot find module '../engine/stats.js'".

- [ ] **Step 3: implement `engine/stats.js`**

```js
export const BASE_STATS = ["Strength", "Fortitude", "Agility", "Intelligence", "Willpower", "Charisma"];
export const WEAPON_STATS = ["Heavy Wep.", "Medium Wep.", "Light Wep."];
export const ATTUNEMENTS = ["Flamecharm", "Frostdraw", "Thundercall", "Galebreathe", "Shadowcast", "Ironsing", "Bloodrend"];
export const CORE_STATS = [...BASE_STATS, ...WEAPON_STATS];
export const ALL_STATS = [...BASE_STATS, ...WEAPON_STATS, ...ATTUNEMENTS];
export const TOTAL_POINTS = 330;

const ALIASES = {
  str: "Strength", strength: "Strength",
  ftd: "Fortitude", frt: "Fortitude", fort: "Fortitude", fortitude: "Fortitude",
  agl: "Agility", agi: "Agility", agility: "Agility",
  int: "Intelligence", intel: "Intelligence", intelligence: "Intelligence",
  wil: "Willpower", wll: "Willpower", will: "Willpower", willpower: "Willpower",
  cha: "Charisma", chr: "Charisma", charisma: "Charisma",
  heavy: "Heavy Wep.", hvy: "Heavy Wep.", "heavy wep": "Heavy Wep.", "heavy wep.": "Heavy Wep.", "heavy weapon": "Heavy Wep.", "heavy weapons": "Heavy Wep.",
  medium: "Medium Wep.", med: "Medium Wep.", "medium wep": "Medium Wep.", "medium wep.": "Medium Wep.", "medium weapon": "Medium Wep.", "medium weapons": "Medium Wep.",
  light: "Light Wep.", lht: "Light Wep.", "light wep": "Light Wep.", "light wep.": "Light Wep.", "light weapon": "Light Wep.", "light weapons": "Light Wep.",
  flame: "Flamecharm", flamecharm: "Flamecharm", fire: "Flamecharm",
  frost: "Frostdraw", frostdraw: "Frostdraw", ice: "Frostdraw",
  thunder: "Thundercall", thundercall: "Thundercall", lightning: "Thundercall",
  gale: "Galebreathe", galebreathe: "Galebreathe", wind: "Galebreathe",
  shadow: "Shadowcast", shadowcast: "Shadowcast",
  iron: "Ironsing", ironsing: "Ironsing", metal: "Ironsing",
  blood: "Bloodrend", bloodrend: "Bloodrend",
};

export function canon(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  return ALIASES[key] ?? (ALL_STATS.find(s => s.toLowerCase() === key) ?? null);
}

export function zeroFlat() {
  const f = {};
  for (const s of ALL_STATS) f[s] = 0;
  return f;
}

export function flatten(nested) {
  const f = zeroFlat();
  for (const grp of ["base", "weapon", "attunement"])
    for (const [k, v] of Object.entries(nested?.[grp] ?? {})) if (k in f) f[k] = Number(v) || 0;
  return f;
}

export function nest(flat) {
  const pick = names => Object.fromEntries(names.map(n => [n, flat[n] ?? 0]));
  return { base: pick(BASE_STATS), weapon: pick(WEAPON_STATS), attunement: pick(ATTUNEMENTS) };
}

// Port of the builder's Pn(): sum of everything, minus 1 for every attunement after the first with points.
export function pointsSpent(flat) {
  let t = 0;
  for (const s of ALL_STATS) t += flat[s] ?? 0;
  let seen = false;
  for (const a of ATTUNEMENTS) {
    const v = flat[a] ?? 0;
    if (seen && v > 0) t--;
    if (v >= 1) seen = true;
  }
  return t;
}

// Port of Kn(): floor((points - 30 + 15) / 15) clamped to [0, 20].
export function powerFor(flat) {
  const n = Math.floor((pointsSpent(flat) - 30 + 15) / 15);
  return Math.max(0, Math.min(20, n));
}

export function pointsForPower(p) {
  return p <= 0 ? 0 : 15 * p + 15;
}

export function reqValue(flat, reqName) {
  switch (reqName) {
    case "Power": return powerFor(flat);
    case "Body": return Math.max(flat.Strength, flat.Agility, flat.Fortitude);
    case "Mind": return Math.max(flat.Intelligence, flat.Willpower, flat.Charisma);
    case "Weapon": case "Weapons": return Math.max(...WEAPON_STATS.map(s => flat[s]));
    case "Attunement": return Math.max(...ATTUNEMENTS.map(s => flat[s]));
    default: {
      const c = canon(reqName);
      return c ? (flat[c] ?? 0) : 0;
    }
  }
}

export function meetsStats(flat, reqs) {
  for (const [k, v] of Object.entries(reqs ?? {})) if (reqValue(flat, k) < Number(v)) return false;
  return true;
}
```

- [ ] **Step 4: run, expect pass** — `npm test` → 5 pass.

- [ ] **Step 5: Commit** — `git add engine/stats.js tests/stats.test.js && git commit -m "feat(engine): stat names, aliases, builder points/power math"`

---

### Task 3: `engine/shrine.js` — Shrine of Order port

**Files:**
- Create: `engine/shrine.js`, `tests/shrine.test.js`

**Interfaces:**
- Consumes: `flatten, nest, pointsSpent, CORE_STATS, ATTUNEMENTS` from `stats.js`.
- Produces: `export function shrineOfOrder(preFlat, raceBonus = {}) -> {base: Flat, spare: number}`

Reference — the builder's actual function (Go = 25, Db = 100, `ws` = deep clone, `t` = race stat bonuses keyed by base stat):

```js
function $b(e,t={}){const n=ws(e),r=[];for(const p of["base","weapon","attunement"])for(const y of Object.keys(n[p]))r.push({type:p,name:y});
const s=p=>n[p.type][p.name]??0,o=(p,y)=>{n[p.type][p.name]=y},i=p=>p.type==="base"?t[p.name]??0:0,a=ws(n),l=p=>a[p.type][p.name]??0,
u=r.filter(p=>s(p)-i(p)>0);if(u.length===0)return n;let c=0;for(const p of u)c+=s(p);const f=c/u.length;for(const p of u)o(p,f);
const h=new Set;let d=ws(n),m=!0,g=32;for(;m&&g-- >0;){m=!1;let p=0;for(const _ of u){if(_.type==="attunement"||h.has(_))continue;
const R=d[_.type][_.name],O=l(_),x=s(_);if(O-x>Go){const A=O-Go;o(_,A),p+=A-R,h.add(_)}}const y=u.length-h.size;
if(y>0&&p!==0){const _=p/y;for(const R of u)h.has(R)||(o(R,s(R)-_),R.type!=="attunement"&&l(R)-s(R)>Go&&(m=!0))}d=ws(n)}
for(const p of u)o(p,Math.floor(s(p)));let T=0;for(const p of u)T+=s(p);const S=c-T,b=u.filter(p=>!h.has(p));
if(b.length>0){let p=S;for(;p>=b.length&&!b.some(y=>s(y)+1>Db);){for(const y of b)o(y,s(y)+1);p-=b.length}}return n}
```
`sparePoints = Pn(pre) - Pn(result)`.

- [ ] **Step 1: failing tests** — `tests/shrine.test.js`

```js
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
  const pre = flatten(b.preShrine), post = flatten(b.postShrine);
  const shrined = Object.values(pre).some(v => v > 0) && JSON.stringify(pre) !== JSON.stringify(post);
  if (!shrined) continue;
  test(`real build ${id}: every final stat >= shrine base`, () => {
    const rb = b.multifaceted ? {} : raceBonus(b.stats.meta.Race);
    const { base } = shrineOfOrder(pre, rb);
    for (const s of Object.keys(base)) assert.ok(post[s] >= base[s], `${s}: final ${post[s]} < base ${base[s]}`);
    for (const s of CORE_STATS) assert.ok(pre[s] - base[s] <= 25, `${s} lost more than 25`);
  });
}
```

- [ ] **Step 2: run, expect failure** — module missing.

- [ ] **Step 3: implement `engine/shrine.js`** — a faithful port operating on the nested shape internally:

```js
import { flatten, nest, pointsSpent } from "./stats.js";
const LOSS_CAP = 25, STAT_MAX = 100;
const clone = o => JSON.parse(JSON.stringify(o));

export function shrineOfOrder(preFlat, raceBonus = {}) {
  const n = nest(preFlat);
  const entries = [];
  for (const type of ["base", "weapon", "attunement"]) for (const name of Object.keys(n[type])) entries.push({ type, name });
  const get = p => n[p.type][p.name] ?? 0;
  const set = (p, v) => { n[p.type][p.name] = v; };
  const bonus = p => (p.type === "base" ? raceBonus[p.name] ?? 0 : 0);
  const orig = clone(n);
  const origOf = p => orig[p.type][p.name] ?? 0;
  const invested = entries.filter(p => get(p) - bonus(p) > 0);
  if (invested.length === 0) return { base: flatten(n), spare: 0 };
  let total = 0; for (const p of invested) total += get(p);
  const avg = total / invested.length;
  for (const p of invested) set(p, avg);
  const locked = new Set();
  let snap = clone(n), again = true, guard = 32;
  while (again && guard-- > 0) {
    again = false;
    let excess = 0;
    for (const p of invested) {
      if (p.type === "attunement" || locked.has(p)) continue;
      const prev = snap[p.type][p.name], o = origOf(p), cur = get(p);
      if (o - cur > LOSS_CAP) { const v = o - LOSS_CAP; set(p, v); excess += v - prev; locked.add(p); }
    }
    const free = invested.length - locked.size;
    if (free > 0 && excess !== 0) {
      const share = excess / free;
      for (const p of invested) if (!locked.has(p)) { set(p, get(p) - share); if (p.type !== "attunement" && origOf(p) - get(p) > LOSS_CAP) again = true; }
    }
    snap = clone(n);
  }
  for (const p of invested) set(p, Math.floor(get(p)));
  let after = 0; for (const p of invested) after += get(p);
  const leftover = total - after;
  const unlocked = invested.filter(p => !locked.has(p));
  if (unlocked.length > 0) {
    let rem = leftover;
    while (rem >= unlocked.length && !unlocked.some(p => get(p) + 1 > STAT_MAX)) { for (const p of unlocked) set(p, get(p) + 1); rem -= unlocked.length; }
  }
  const base = flatten(n);
  return { base, spare: Math.max(0, pointsSpent(preFlat) - pointsSpent(base)) };
}
```

- [ ] **Step 4: run, expect pass** — `npm test`. If a real-build test fails, print `pre`, `base`, `post` for that id and check the race bonus handling first (the builder subtracts race bonus only when deciding whether a base stat is "invested").

- [ ] **Step 5: Commit** — `git commit -am "feat(engine): faithful Shrine of Order port" ` (add new files first).

---

### Task 4: `pipeline/slimdata.py` → `data/game.json` + `data/game.js`

**Files:**
- Create: `pipeline/slimdata.py`, `pipeline/test_slimdata.py`, outputs `data/game.json`, `data/game.js`

**Interfaces — Produces `game.json`:**
```json
{
  "meta": {"generated": "ISO", "talents": N, "mantras": N},
  "talents": {"<name>": {"reqs": {"Charisma": 75}, "pre": ["Vow of Mastery"], "or": [ {...same shape...} ],
               "category": "Vow of Mastery", "rarity": "Common", "desc": "…≤160", 
               "origin": "Justicar"|null, "outfit": "…"|null, "aspect": "…"|null, "weaponType": "…"|null,
               "mantras": ["…"], "exclusive": ["…"], "counts": true}},
  "mantras": {"<name>": {"attunement": "Flamecharm"|null, "reqs": {}, "category": "Combat|Support|Mobility|Wisp",
               "type": "Normal|Oath|Origin|Monster|Event", "desc": "…", "modifiers": ["Cloudstone", ...]}},
  "weapons": {"<name>": {"type": "Sword", "wtype": "light|medium|heavy|null", "reqs": {}, "talents": []}},
  "outfits": {"<name>": {"reqs": {}, "origin": "…"|null, "talents": ["Justicar's Gift"]}},
  "equipment": {"<name>": {"slot": "Head|Arms|Legs|Torso|Face|Earrings|Rings", "talents": [], "reqs": {}}},
  "enchants": ["Astral", ...],
  "oaths": {"<name>": {"slots": {"Combat": 1}, "mantras": {"Combat": ["…"]}}},
  "races": {"<name>": {"Intelligence": 3, "Willpower": 2}},
  "origins": ["Castaway", "Deepbound", "Justicar", ...],   "murmurs": [...], "bells": [...],
  "boons": [...], "flaws": [...],
  "slots": {"Combat": 3, "Mobility": 1, "Support": 1, "Wisp": 0, "Wildcard": 1}
}
```
Requirement stat keys are copied **verbatim** from gamedata (e.g. `"Light Weapon"`, `"Power"`); the engine aliases them.

- [ ] **Step 1: failing test** — `pipeline/test_slimdata.py`

```python
import json, os, unittest, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

class SlimData(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.check_call([sys.executable, os.path.join(ROOT, "pipeline", "slimdata.py")], cwd=ROOT)
        cls.g = json.load(open(os.path.join(ROOT, "data", "game.json"), encoding="utf-8"))

    def test_sizes(self):
        self.assertLess(os.path.getsize(os.path.join(ROOT, "data", "game.json")), 400_000)
        self.assertGreater(len(self.g["talents"]), 1000)
        self.assertGreater(len(self.g["mantras"]), 250)

    def test_known_entries(self):
        t = self.g["talents"]["Command: Live"]
        self.assertEqual(t["reqs"], {"Charisma": 75}); self.assertEqual(t["pre"], ["Vow of Mastery"])
        self.assertEqual(self.g["talents"]["Reinforced Armor"]["reqs"], {"Fortitude": 90})
        m = self.g["mantras"]["Graceful Flame"]
        self.assertEqual(m["attunement"], "Flamecharm"); self.assertEqual(m["category"], "Support"); self.assertEqual(m["type"], "Normal")
        self.assertEqual(self.g["outfits"]["Warder's Attire"]["origin"], "Justicar")
        self.assertIn("Justicar's Gift", self.g["outfits"]["Warder's Attire"]["talents"])
        self.assertEqual(self.g["weapons"]["Fool's Tankard"]["wtype"], "light")
        self.assertEqual(self.g["races"]["Capra"], {"Intelligence": 3, "Willpower": 2})
        self.assertEqual(self.g["oaths"]["Linkstrider"]["slots"].__class__, dict)
        self.assertIn("Justicar", self.g["origins"]); self.assertIn("Rhythm", self.g["murmurs"])
        self.assertEqual(self.g["slots"]["Combat"], 3)

    def test_js_twin(self):
        js = open(os.path.join(ROOT, "data", "game.js"), encoding="utf-8").read()
        self.assertTrue(js.startswith("export default "))
```

- [ ] **Step 2: run, expect failure** — `npm run pytest` → FileNotFoundError for slimdata.py.

- [ ] **Step 3: implement `pipeline/slimdata.py`**

```python
"""Trim data/raw/gamedata.json into data/game.json and data/game.js for the engine."""
import json, os, datetime
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT_JSON = os.path.join(ROOT, "data", "game.json")
OUT_JS = os.path.join(ROOT, "data", "game.js")
SLOTS = {"Combat": 3, "Mobility": 1, "Support": 1, "Wisp": 0, "Wildcard": 1}

def short(s, n=160):
    s = (s or "").strip().replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"

def reqs_of(obj):
    r = (obj.get("requirements") or {})
    return {k: int(v) for k, v in (r.get("stats") or {}).items() if isinstance(v, (int, float))}

def or_block(req):
    out = []
    for alt in (req or {}).get("or") or []:
        out.append({"reqs": {k: int(v) for k, v in (alt.get("stats") or {}).items()}, "pre": list(alt.get("talents") or []),
                    "origin": alt.get("origin"), "outfit": alt.get("outfit")})
    return out

def wtype(w):
    keys = set((w.get("scaling") or {}).keys()) | set((w.get("requirements") or {}).get("stats", {}).keys())
    for k, t in (("Light Weapon", "light"), ("Medium Weapon", "medium"), ("Heavy Weapon", "heavy")):
        if k in keys: return t
    return None

def main():
    g = json.load(open(os.path.join(RAW, "gamedata.json"), encoding="utf-8"))
    D = g["data"]
    talents = {}
    for t in D["talents"]:
        r = t.get("requirements") or {}
        talents[t["name"]] = {
            "reqs": reqs_of(t), "pre": list(r.get("talents") or []), "or": or_block(r),
            "category": t.get("category"), "rarity": t.get("rarity"), "desc": short(t.get("description")),
            "origin": r.get("origin"), "outfit": r.get("outfit"), "aspect": r.get("aspect"),
            "weaponType": r.get("weaponType"), "mantras": list(r.get("mantras") or []),
            "exclusive": list(t.get("mutualExclusives") or []), "counts": bool(t.get("countTowardsTalentTotal", True)),
        }
    mantras = {}
    for m in D["mantras"]:
        attrs = m.get("attributes") or []
        mantras[m["name"]] = {"attunement": attrs[0] if attrs else None, "reqs": reqs_of(m), "category": m.get("category"),
                              "type": m.get("type") or "Normal", "desc": short(m.get("description")), "modifiers": list(m.get("modifiers") or [])}
    weapons = {w["name"]: {"type": w.get("type"), "wtype": wtype(w), "reqs": reqs_of(w), "talents": list(w.get("grantedTalents") or [])} for w in D["weapons"]}
    outfits = {o["name"]: {"reqs": reqs_of(o), "origin": (o.get("requirements") or {}).get("origin"), "talents": list(o.get("grantedTalents") or [])} for o in D["outfits"]}
    equipment = {e["name"]: {"slot": e.get("type"), "talents": list(e.get("innateTalents") or []), "reqs": reqs_of(e)} for e in g["equipmentData"]}
    oaths = {o["name"]: {"slots": o.get("slots") or {}, "mantras": o.get("mantras") or {}} for o in g["oathsData"]}
    races = {a["name"]: a.get("statBonuses") or {} for a in g["aspectsData"]}
    # enumerations come from the build corpus (the builder keeps them in UI code, not game data)
    seen = {"Origin": set(), "Murmur": set(), "Bell": set()}
    for f in ("feed_top.json", "feed_popular.json"):
        for b in json.load(open(os.path.join(RAW, f), encoding="utf-8")):
            for k in seen: 
                v = (b.get("stats", {}).get("meta") or {}).get(k)
                if v: seen[k].add(v)
    out = {
        "meta": {"generated": datetime.datetime.utcnow().isoformat() + "Z", "talents": len(talents), "mantras": len(mantras)},
        "talents": talents, "mantras": mantras, "weapons": weapons, "outfits": outfits, "equipment": equipment,
        "enchants": [e["name"] for e in D["enchants"]], "oaths": oaths, "races": races,
        "origins": sorted(seen["Origin"]), "murmurs": sorted(seen["Murmur"]), "bells": sorted(seen["Bell"]),
        "boons": [b["name"] for b in g["boonsData"]], "flaws": [f["name"] for f in g["flawsData"]], "slots": SLOTS,
    }
    json.dump(out, open(OUT_JSON, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    open(OUT_JS, "w", encoding="utf-8").write("export default " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n")
    print(f"game.json: {os.path.getsize(OUT_JSON)/1024:.0f} KB, {len(talents)} talents, {len(mantras)} mantras")

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: run, expect pass** — `npm run pytest`. If `game.json` > 400 KB, drop `desc` for talents with rarity `Equipment`/`Weapon`/`Memento` (they're never chosen by the engine) until under.

- [ ] **Step 5: Commit** — `git add pipeline/slimdata.py pipeline/test_slimdata.py data/game.json data/game.js && git commit -m "feat(pipeline): slimdata -> game.json"`

---

### Task 5: `engine/convert.js` — feed build ⇄ BuildCore ⇄ builder draft

**Files:**
- Create: `engine/convert.js`, `tests/convert.test.js`

**Interfaces:**
- Consumes: `flatten, nest, zeroFlat` from `stats.js`.
- Produces:
```js
export function fromFeedBuild(feed) -> BuildCore      // feed record from feed_*.json
export function fromSpec(spec) -> BuildCore           // dwfill-style spec (tests/fixtures/spec_healer_final.json)
export function toDraft(core) -> object               // builder store-shaped build (version 3), talents include "Oath: X"/"Murmur: X"
export function draftEnvelope(core) -> {version:1, build, phase:"pre"|"post", baseline:""}   // what the bookmarklet writes
export function defaultDraft() -> object
```

- [ ] **Step 1: failing tests**

```js
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
```

- [ ] **Step 2: run, expect failure.**

- [ ] **Step 3: implement `engine/convert.js`** (mirror `dwfill.default_build()` exactly — every key and JS type must match or the builder rejects the draft):

```js
import { flatten, nest, zeroFlat, canon, BASE_STATS, WEAPON_STATS, ATTUNEMENTS } from "./stats.js";
const TRAITS = ["Vitality", "Erudition", "Proficiency", "Songchant"];
const zeroAttrs = () => nest(zeroFlat());
const emptyEquip = () => ({ Head: null, Arms: null, Legs: null, Torso: null, Face: null, Earrings: null, Rings: [null, null, null, null] });

export function defaultDraft() {
  return {
    version: 3, createdAt: "", updatedAt: "",
    author: { id: "", verifiedId: "", name: "" },
    stats: { buildName: "", buildDescription: "", buildAuthor: "", power: 0, points: 330, pointSpent: 0, pointsUntilNextPower: 0,
      traits: Object.fromEntries(TRAITS.map(t => [t, 0])), traitsPoints: 12,
      meta: { Race: "None", Oath: "None", Murmur: "None", Origin: "Castaway", Bell: "None", Outfit: "None" },
      boon1: "None", boon2: "None", flaw1: "None", flaw2: "None", flaw3: "None" },
    attributes: zeroAttrs(), content: { notes: "", mantraModifications: {} },
    meta: { visibility: "public", private: false, tags: [], votes: { up: 0, down: 0, voters: {} }, views: 0, saved: 0, comments: { count: 0, lastActivity: null } },
    talents: [], weapons: "", enchant: "", motif: "", weaponStars: { count: 0, mod: "" }, multifaceted: false,
    mantras: [], preShrine: zeroAttrs(), postShrine: zeroAttrs(), preMastery: {}, postMastery: {}, favoritedTalents: [], equipment: emptyEquip(),
  };
}

const hasPoints = flat => Object.values(flat).some(v => v > 0);

export function fromFeedBuild(b) {
  const pre = flatten(b.preShrine), post = flatten(b.postShrine), attrs = flatten(b.attributes);
  const shrine = hasPoints(pre) && JSON.stringify(pre) !== JSON.stringify(hasPoints(post) ? post : attrs);
  const m = b.stats?.meta ?? {};
  return {
    name: b.stats?.buildName ?? "", description: b.stats?.buildDescription ?? "", notes: b.content?.notes ?? "",
    origin: m.Origin ?? "Castaway", oath: m.Oath ?? "None", race: m.Race ?? "None", murmur: m.Murmur ?? "None", bell: m.Bell ?? "None",
    outfit: m.Outfit ?? "None", weapon: b.weapons ?? "", enchant: b.enchant ?? "",
    boons: [b.stats?.boon1 ?? "None", b.stats?.boon2 ?? "None"], flaws: [b.stats?.flaw1 ?? "None", b.stats?.flaw2 ?? "None", b.stats?.flaw3 ?? "None"],
    traits: { ...Object.fromEntries(TRAITS.map(t => [t, 0])), ...(b.stats?.traits ?? {}) },
    multifaceted: !!b.multifaceted, shrine, preShrine: shrine ? pre : null, final: attrs,
    talents: [...(b.talents ?? [])], mantras: [...(b.mantras ?? [])],
    mantraMods: JSON.parse(JSON.stringify(b.content?.mantraModifications ?? {})),
    equipment: { ...emptyEquip(), ...(b.equipment ?? {}) },
  };
}

function parseBlock(block) {
  const f = zeroFlat();
  for (const [k, v] of Object.entries(block ?? {})) { const c = canon(k); if (c) f[c] = Number(v) || 0; }
  return f;
}

export function fromSpec(spec) {
  const shrine = !!(spec.shrineOfOrder ?? spec.shrine);
  const pre = parseBlock(spec.preShrine ?? spec.stats), post = spec.postShrine ? parseBlock(spec.postShrine) : null;
  const boons = [...(spec.boons ?? [])], flaws = [...(spec.flaws ?? [])];
  return {
    name: spec.name ?? "", description: spec.description ?? "", notes: spec.notes ?? "",
    origin: spec.origin ?? "Castaway", oath: spec.oath ?? "None", race: spec.race ?? "None", murmur: spec.murmur ?? "None", bell: spec.bell ?? "None",
    outfit: spec.outfit ?? "None", weapon: spec.weapon ?? "", enchant: spec.enchant ?? "",
    boons: [boons[0] || "None", boons[1] || "None"], flaws: [flaws[0] || "None", flaws[1] || "None", flaws[2] || "None"],
    traits: { ...Object.fromEntries(TRAITS.map(t => [t, 0])), ...(spec.traits ?? {}) },
    multifaceted: !!spec.multifaceted, shrine, preShrine: shrine ? pre : null, final: shrine && post ? post : pre,
    talents: [...(spec.talents ?? [])], mantras: [...(spec.mantras ?? [])],
    mantraMods: JSON.parse(JSON.stringify(spec.mantraModifications ?? {})),
    equipment: { ...emptyEquip(), ...(spec.equipment ?? {}) },
  };
}

export function toDraft(core) {
  const d = defaultDraft();
  const s = d.stats;
  s.buildName = core.name; s.buildDescription = core.description; d.content.notes = core.notes;
  Object.assign(s.meta, { Origin: core.origin || "Castaway", Oath: core.oath || "None", Race: core.race || "None", Murmur: core.murmur || "None", Bell: core.bell || "None", Outfit: core.outfit || "None" });
  d.weapons = core.weapon || ""; d.enchant = core.enchant || ""; d.multifaceted = !!core.multifaceted;
  [s.boon1, s.boon2] = [core.boons?.[0] || "None", core.boons?.[1] || "None"];
  [s.flaw1, s.flaw2, s.flaw3] = [core.flaws?.[0] || "None", core.flaws?.[1] || "None", core.flaws?.[2] || "None"];
  for (const t of TRAITS) s.traits[t] = Number(core.traits?.[t] ?? 0);
  d.attributes = nest(core.final);
  if (core.shrine && core.preShrine) { d.preShrine = nest(core.preShrine); d.postShrine = nest(core.final); }
  d.mantras = [...core.mantras];
  d.content.mantraModifications = Object.fromEntries(d.mantras.map(m => [m, { ...(core.mantraMods?.[m] ?? {}) }]));
  const talents = [...core.talents];
  for (const [key, prefix] of [["Oath", "Oath: "], ["Murmur", "Murmur: "]]) {
    const v = s.meta[key]; if (v && v !== "None" && !talents.includes(prefix + v)) talents.push(prefix + v);
  }
  d.talents = talents;
  d.equipment = { ...emptyEquip(), ...JSON.parse(JSON.stringify(core.equipment ?? {})) };
  return d;
}

export function draftEnvelope(core) {
  return { version: 1, build: toDraft(core), phase: core.shrine ? "post" : "pre", baseline: "" };
}
```

- [ ] **Step 4: run, expect pass.**
- [ ] **Step 5: Commit** — `git add engine/convert.js tests/convert.test.js && git commit -m "feat(engine): feed/spec/draft conversions"`

---

### Task 6: `engine/validate.js`

**Files:**
- Create: `engine/validate.js`, `tests/validate.test.js`

**Interfaces:**
- Consumes: `stats.js` (`pointsSpent, meetsStats, reqValue, ATTUNEMENTS, CORE_STATS, TOTAL_POINTS`), `shrine.js`, `convert.fromFeedBuild`.
- Produces:
```js
export function validate(core, game) -> {ok: boolean, errors: [{code, msg}], warnings: [{code, msg}]}
export function talentObtainable(name, core, game) -> {ok: boolean, why: string[]}   // used by assemble
export function mantraSlots(core, game) -> {Combat, Mobility, Support, Wisp, Wildcard}
export function mantraUsage(core, game) -> {counts, overflow: number}                // port of builder Qw
export const WARDER_CATEGORY = "Warder Techniques";
```

Rules (error codes):
- `points`: `pointsSpent(final) !== 330`.
- `stat_max`: any stat > 100 or < 0.
- `race_bonus`: not multifaceted and `final[s] < game.races[race][s]` for any bonus stat.
- `shrine`: `shrine === true` and (`preShrine` null, or `pointsSpent(preShrine) > 330`, or any `final[s] < shrineOfOrder(preShrine, bonus).base[s]`).
- `unknown_talent` / `unknown_mantra` / `unknown_outfit` / `unknown_weapon`: name not in game (skip talents starting with `"Oath: "` / `"Murmur: "`).
- `talent_reqs`: `talentObtainable` false. Obtainable = stats reqs met at `preShrine` **or** at `final` (each phase evaluated as a whole, including `or` alternatives), AND every `pre` talent is in `core.talents` (or granted by outfit/weapon/equipment), AND `origin` (if set) equals `core.origin`, AND `aspect` (if set) equals `core.race`, AND rarity `Oath` ⇒ `category === core.oath`. `outfit`/`weaponType`/`mantras` mismatches are **warnings** (`talent_soft`), not errors.
- `dup_talent`, `exclusive` (mutual exclusives both present).
- `warder_cap`: > 4 talents with `category === WARDER_CATEGORY` excluding `Justicar's Gift`.
- `mantra_reqs`: mantra reqs unmet at final, or `attunement` set and `final[attunement] === 0`.
- `mantra_slots`: `mantraUsage(...).overflow > 0`.
- `outfit_reqs`, `weapon_reqs`: reqs unmet at final; outfit `origin` mismatch.
Warnings: `shrine_power_low` (preShrine power < 8), `talent_soft`, `no_weapon`.

- [ ] **Step 1: failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validate, mantraSlots, mantraUsage, talentObtainable } from "../engine/validate.js";
import { fromFeedBuild, fromSpec } from "../engine/convert.js";

const game = JSON.parse(readFileSync(new URL("../data/game.json", import.meta.url)));
const real = JSON.parse(readFileSync(new URL("./fixtures/real_builds.json", import.meta.url)));
const healer = fromSpec(JSON.parse(readFileSync(new URL("./fixtures/spec_healer_final.json", import.meta.url))));
const feeds = [...JSON.parse(readFileSync(new URL("../data/raw/feed_top.json", import.meta.url))), ...JSON.parse(readFileSync(new URL("../data/raw/feed_popular.json", import.meta.url)))];
const codes = r => r.errors.map(e => e.code);

test("healer fixture has no hard errors", () => {
  const r = validate(healer, game);
  assert.deepEqual(codes(r).filter(c => c !== "warder_cap"), [], JSON.stringify(r.errors));
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
  assert.ok(mantraUsage(healer, game).overflow === 0);
});

test("top 30 corpus builds by views validate with zero hard errors", () => {
  const top = feeds.filter(b => b.stats.pointSpent === 330 && b.talents.length).sort((a, b) => b.meta.views - a.meta.views).slice(0, 30);
  const bad = [];
  for (const b of top) {
    const r = validate(fromFeedBuild(b), game);
    const hard = r.errors.filter(e => !["warder_cap", "mantra_slots"].includes(e.code));
    if (hard.length) bad.push({ id: b.id, errors: hard.slice(0, 3) });
  }
  assert.deepEqual(bad, [], JSON.stringify(bad, null, 1));
});
```

- [ ] **Step 2: run, expect failure.**

- [ ] **Step 3: implement `engine/validate.js`**

```js
import { pointsSpent, meetsStats, powerFor, ALL_STATS, ATTUNEMENTS, TOTAL_POINTS, canon } from "./stats.js";
import { shrineOfOrder } from "./shrine.js";
export const WARDER_CATEGORY = "Warder Techniques";
const BASE_SLOTS = { Combat: 3, Mobility: 1, Support: 1, Wisp: 0, Wildcard: 1 };
const isPath = t => t.startsWith("Oath: ") || t.startsWith("Murmur: ");

export function grantedTalents(core, game) {
  const g = new Set();
  for (const t of game.outfits[core.outfit]?.talents ?? []) g.add(t);
  for (const t of game.weapons[core.weapon]?.talents ?? []) g.add(t);
  for (const item of [...Object.values(core.equipment ?? {})].flat()) if (item?.name) for (const t of game.equipment[item.name]?.talents ?? []) g.add(t);
  return g;
}

function phaseOk(reqs, core) {
  const phases = core.shrine && core.preShrine ? [core.preShrine, core.final] : [core.final];
  return phases.some(f => meetsStats(f, reqs));
}

export function talentObtainable(name, core, game) {
  const t = game.talents[name];
  if (!t) return { ok: false, why: ["unknown"] };
  const have = new Set([...core.talents, ...grantedTalents(core, game)]);
  const why = [];
  const alt = [{ reqs: t.reqs, pre: t.pre, origin: t.origin, outfit: t.outfit }, ...(t.or ?? [])];
  const anyAlt = alt.some(a => phaseOk(a.reqs ?? {}, core) && (a.pre ?? []).every(p => have.has(p)) && (!a.origin || a.origin === core.origin));
  if (!anyAlt) {
    if (!phaseOk(t.reqs, core)) why.push(`needs ${Object.entries(t.reqs).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    for (const p of t.pre ?? []) if (!have.has(p)) why.push(`needs talent ${p}`);
    if (t.origin && t.origin !== core.origin) why.push(`needs origin ${t.origin}`);
  }
  if (t.aspect && t.aspect !== core.race) why.push(`needs race ${t.aspect}`);
  if (t.rarity === "Oath" && t.category !== core.oath) why.push(`needs oath ${t.category}`);
  return { ok: why.length === 0, why };
}

export function mantraSlots(core, game) {
  const s = { ...(game.slots ?? BASE_SLOTS) };
  const o = game.oaths[core.oath]?.slots ?? {};
  for (const k of ["Combat", "Mobility", "Support", "Wildcard"]) s[k] += o[k] ?? 0;
  if (core.talents.includes("Neuroplasticity")) s.Wildcard++;
  if (core.talents.some(t => t.includes("Will o' Wisp"))) s.Wisp++;
  if (core.talents.some(t => t.includes("Chorus of Souls"))) s.Wisp++;
  return s;
}

export function mantraUsage(core, game) {
  const slots = mantraSlots(core, game);
  const counts = { Combat: 0, Mobility: 0, Support: 0, Wisp: 0, Wildcard: 0 };
  let overflow = 0;
  for (const name of core.mantras) {
    const m = game.mantras[name]; if (!m || m.type !== "Normal") continue;
    const cat = m.category; if (!(cat in counts) || cat === "Wildcard") continue;
    let use;
    if (counts[cat] < slots[cat]) use = cat;
    else if (cat === "Wisp" && counts.Support < slots.Support) use = "Support";
    else if (counts.Wildcard < slots.Wildcard) use = "Wildcard";
    else { use = cat; overflow++; }
    counts[use]++;
  }
  return { counts, slots, overflow };
}

export function validate(core, game) {
  const errors = [], warnings = [];
  const err = (code, msg) => errors.push({ code, msg }), warn = (code, msg) => warnings.push({ code, msg });
  const pts = pointsSpent(core.final);
  if (pts !== TOTAL_POINTS) err("points", `${pts} points spent, need ${TOTAL_POINTS}`);
  for (const s of ALL_STATS) if (core.final[s] > 100 || core.final[s] < 0) err("stat_max", `${s} = ${core.final[s]}`);
  const bonus = core.multifaceted ? {} : (game.races[core.race] ?? {});
  for (const [s, v] of Object.entries(bonus)) if ((core.final[s] ?? 0) < v) err("race_bonus", `${s} below racial bonus ${v}`);
  if (core.shrine) {
    if (!core.preShrine) err("shrine", "shrine enabled but no pre-shrine stats");
    else {
      if (pointsSpent(core.preShrine) > TOTAL_POINTS) err("shrine", "pre-shrine exceeds 330 points");
      const { base } = shrineOfOrder(core.preShrine, bonus);
      for (const s of ALL_STATS) if (core.final[s] < base[s]) err("shrine", `${s}: final ${core.final[s]} < shrine base ${base[s]}`);
      if (powerFor(core.preShrine) < 8) warn("shrine_power_low", `shrining at power ${powerFor(core.preShrine)}`);
    }
  }
  const seen = new Set();
  let warders = 0;
  for (const t of core.talents) {
    if (isPath(t)) continue;
    if (seen.has(t)) err("dup_talent", t); seen.add(t);
    const g = game.talents[t];
    if (!g) { err("unknown_talent", t); continue; }
    if (g.category === WARDER_CATEGORY && t !== "Justicar's Gift") warders++;
    const r = talentObtainable(t, core, game);
    if (!r.ok) err("talent_reqs", `${t}: ${r.why.join("; ")}`);
    if (g.outfit && g.outfit !== core.outfit) warn("talent_soft", `${t} wants outfit ${g.outfit}`);
    if (g.weaponType && !core.weapon) warn("talent_soft", `${t} needs a ${g.weaponType}`);
    for (const m of g.mantras ?? []) if (!core.mantras.includes(m)) warn("talent_soft", `${t} wants mantra ${m}`);
    for (const x of g.exclusive ?? []) if (seen.has(x)) err("exclusive", `${t} excludes ${x}`);
  }
  if (warders > 4) err("warder_cap", `${warders} Warder talents, max 4`);
  for (const m of core.mantras) {
    const g = game.mantras[m];
    if (!g) { err("unknown_mantra", m); continue; }
    if (!meetsStats(core.final, g.reqs)) err("mantra_reqs", `${m} needs ${JSON.stringify(g.reqs)}`);
    if (g.attunement && !core.final[g.attunement]) err("mantra_reqs", `${m} needs ${g.attunement}`);
  }
  const usage = mantraUsage(core, game);
  if (usage.overflow > 0) err("mantra_slots", `${usage.overflow} mantra(s) over slot limit ${JSON.stringify(usage.slots)}`);
  if (core.outfit && core.outfit !== "None") {
    const o = game.outfits[core.outfit];
    if (!o) err("unknown_outfit", core.outfit);
    else { if (!meetsStats(core.final, o.reqs)) err("outfit_reqs", core.outfit); if (o.origin && o.origin !== core.origin) err("outfit_reqs", `${core.outfit} needs origin ${o.origin}`); }
  }
  if (core.weapon) {
    const w = game.weapons[core.weapon];
    if (!w) err("unknown_weapon", core.weapon); else if (!meetsStats(core.final, w.reqs)) err("weapon_reqs", core.weapon);
  } else warn("no_weapon", "no weapon selected");
  return { ok: errors.length === 0, errors, warnings };
}
```

- [ ] **Step 4: run, expect pass.** The corpus test is the important one: if real builds fail on `talent_reqs`, inspect the failing talent's raw `requirements` in gamedata — likely an alternate path (`or`, `memento`, `equipment`, `quests`) the validator must treat as satisfiable. Add that key to `slimdata.py` as an `alt: true` flag and make `talentObtainable` accept the talent when `alt` is set and stat reqs pass. Keep iterating until the 30 builds pass; do **not** loosen stat-requirement checks.

- [ ] **Step 5: Commit** — `git add engine/validate.js tests/validate.test.js pipeline/slimdata.py data/game.js* && git commit -m "feat(engine): build validator"`

---

### Task 7: `pipeline/mine.py` → `data/archetypes.json` + `.js`

**Files:**
- Create: `pipeline/mine.py`, `pipeline/test_mine.py`, outputs `data/archetypes.json`, `data/archetypes.js`

**Interfaces — Produces `archetypes.json`:**
```json
{"meta": {"generated": "...", "builds_in": 1204, "builds_kept": 880, "archetypes": N},
 "archetypes": [ { "id", "role", "label", "members", "example_ids": [3], "views_total",
    "stack": {"stat": "Charisma", "min": 85, "modal": 90},
    "pre_shrine_modal": {Flat},  "shrine_power_modal": 12, "shrine_power_window": [8, 15], "shrined_rate": 0.9,
    "post_shrine_modal": {Flat}, "post_shrine_spread": {"Charisma": {"p25": 60, "p50": 65, "p75": 75}, ...},
    "talent_freq": [["name", 0.93], ...],   // top 120, desc; core = ≥0.5, common = 0.25–0.5
    "mantra_freq": [["name", 0.93], ...],   // top 40
    "gem_freq": {"Graceful Flame": [["Blue", 0.7]]},
    "oath": [[name, f]], "origin": [[name, f]], "race": [[name, f]], "murmur": [[name, f]], "bell": [[name, f]],
    "outfits": [[name, f]], "weapons": [[name, f]], "enchants": [[name, f]],
    "equipment": {"Head": [[name, f]], ..., "Rings": [[name, f]]},
    "boons": [[name, f]], "flaws": [[name, f]], "traits_modal": {"Vitality": 6, ...},
    "multifaceted_rate": 0.4 } ] }
```

Role tagging (python, on `attributes` = final stats, flattened):
```python
def role_of(b, final, talents, oath):
    healer_sig = {"Graceful Flame","Command: Live","Symbiotic Sustain","Alsin's Aid"} & set(b["mantras"]) or {"Undying Flame","Justicar's Mark","Kindness","Grand Support"} & set(talents)
    if healer_sig and (final["Charisma"] >= 50 or (final["Flamecharm"] >= 40 and final["Willpower"] >= 40)) or oath == "Linkstrider": return "healer"
    wmax = max(final[w] for w in WEAPON); amax = max(final[a] for a in ATT)
    if final["Fortitude"] >= 75 or {"Reinforced Armor","Moving Fortress"} & set(talents): return "tank"
    if wmax >= 65 and wmax >= amax: return "dps"
    if amax >= 65 and wmax < 65: return "mage"
    return "hybrid"
```
Sub-cluster key = `(role, weapon_type_of_top_weapon_stat or "none", tuple(sorted(a for a in ATT if final[a] >= 40)), oath)`. Merge: if a key has < 4 members, drop the oath from the key and retry; if still < 4, drop attunements; clusters still < 4 are discarded. `stack.stat` = the CORE stat with the highest modal pre-shrine value; `stack.min` = its p25; `shrined` = preShrine has points and differs from postShrine; `shrine_power` from `preShrine` via the Pn/Kn formulas (port them in Python). Modal = most common value, ties → higher. `label` = `f"{role.title()} · {'/'.join(attunements) or 'attunementless'} · {weapon_type or 'no weapon'} · {oath}"`.

- [ ] **Step 1: failing test** — `pipeline/test_mine.py`

```python
import json, os, unittest, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pipeline"))

class Mine(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.check_call([sys.executable, os.path.join(ROOT, "pipeline", "mine.py")], cwd=ROOT)
        cls.a = json.load(open(os.path.join(ROOT, "data", "archetypes.json"), encoding="utf-8"))
        cls.game = json.load(open(os.path.join(ROOT, "data", "game.json"), encoding="utf-8"))

    def test_shape_and_counts(self):
        self.assertGreaterEqual(self.a["meta"]["builds_kept"], 800)
        self.assertGreaterEqual(len(self.a["archetypes"]), 15)
        roles = {x["role"] for x in self.a["archetypes"]}
        self.assertTrue({"healer", "dps", "tank", "mage"} <= roles, roles)
        for x in self.a["archetypes"]:
            self.assertGreaterEqual(x["members"], 4)
            self.assertEqual(len(x["example_ids"]), min(3, x["members"]))
            self.assertIn(x["stack"]["stat"], self.game["races"].keys().__class__ and x["pre_shrine_modal"].keys())
            self.assertEqual(sum(1 for v in x["post_shrine_modal"].values()), 16)

    def test_names_resolve_to_game_data(self):
        for x in self.a["archetypes"]:
            for name, _ in x["talent_freq"]:
                self.assertTrue(name in self.game["talents"] or name.startswith(("Oath: ", "Murmur: ")), name)
            for name, _ in x["mantra_freq"]: self.assertIn(name, self.game["mantras"])

    def test_healer_archetype_looks_right(self):
        h = [x for x in self.a["archetypes"] if x["role"] == "healer"]
        self.assertTrue(h)
        best = max(h, key=lambda x: x["members"])
        self.assertIn(best["stack"]["stat"], ("Charisma", "Fortitude", "Agility", "Willpower"))
        names = [n for n, _ in best["mantra_freq"][:15]]
        self.assertTrue({"Graceful Flame", "Reinforce", "Symbiotic Sustain"} & set(names), names)

    def test_pointsmath(self):
        from mine import points_spent, power_for
        self.assertEqual(points_spent({"Charisma": 90, "Flamecharm": 1, "Thundercall": 1, "Frostdraw": 1}), 91)
        self.assertEqual(power_for({"Strength": 45}), 2)

    def test_js_twin(self):
        self.assertTrue(open(os.path.join(ROOT, "data", "archetypes.js"), encoding="utf-8").read().startswith("export default "))
```

- [ ] **Step 2: run, expect failure.**

- [ ] **Step 3: implement `pipeline/mine.py`** — complete script:

```python
"""Mine data/raw/feed_*.json into data/archetypes.json / .js"""
import json, os, datetime, statistics
from collections import Counter, defaultdict
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
BASE = ["Strength", "Fortitude", "Agility", "Intelligence", "Willpower", "Charisma"]
WEAPON = ["Heavy Wep.", "Medium Wep.", "Light Wep."]
ATT = ["Flamecharm", "Frostdraw", "Thundercall", "Galebreathe", "Shadowcast", "Ironsing", "Bloodrend"]
ALL = BASE + WEAPON + ATT
CORE = BASE + WEAPON
WTYPE = {"Heavy Wep.": "heavy", "Medium Wep.": "medium", "Light Wep.": "light"}
MIN_MEMBERS, MIN_VIEWS = 4, 500

def flat(nested):
    f = {s: 0 for s in ALL}
    for grp in ("base", "weapon", "attunement"):
        for k, v in (nested or {}).get(grp, {}).items():
            if k in f: f[k] = int(v or 0)
    return f

def points_spent(f):
    t = sum(f.get(s, 0) for s in ALL); seen = False
    for a in ATT:
        v = f.get(a, 0)
        if seen and v > 0: t -= 1
        if v >= 1: seen = True
    return t

def power_for(f):
    return max(0, min(20, (points_spent(f) - 30 + 15) // 15))

def modal(values):
    c = Counter(values); top = max(c.values())
    return max(v for v, n in c.items() if n == top)

def pct(values, p):
    s = sorted(values); return s[min(len(s) - 1, int(round(p * (len(s) - 1))))]

def freq(counter, n, denom):
    return [[k, round(v / denom, 3)] for k, v in counter.most_common(n) if k not in (None, "", "None")]

def role_of(b, final, talents, oath):
    ts, ms = set(talents), set(b["mantras"])
    healer_sig = ({"Graceful Flame", "Command: Live", "Symbiotic Sustain", "Alsin's Aid"} & ms) or ({"Undying Flame", "Justicar's Mark", "Kindness", "Grand Support"} & ts)
    if oath == "Linkstrider" or (healer_sig and (final["Charisma"] >= 50 or (final["Flamecharm"] >= 40 and final["Willpower"] >= 40))): return "healer"
    wmax = max(final[w] for w in WEAPON); amax = max(final[a] for a in ATT)
    if final["Fortitude"] >= 75 or ({"Reinforced Armor", "Moving Fortress"} & ts): return "tank"
    if wmax >= 65 and wmax >= amax: return "dps"
    if amax >= 65 and wmax < 65: return "mage"
    return "hybrid"

def load():
    seen = {}
    for f in ("feed_top.json", "feed_popular.json"):
        for b in json.load(open(os.path.join(RAW, f), encoding="utf-8")): seen[b["id"]] = b
    return list(seen.values())

def prep(b):
    final = flat(b["attributes"]); pre = flat(b["preShrine"]); post = flat(b["postShrine"])
    shrined = any(pre.values()) and pre != (post if any(post.values()) else final)
    meta = b["stats"]["meta"]
    top_w = max(WEAPON, key=lambda w: final[w])
    return {"id": b["id"], "views": b["meta"].get("views", 0), "final": final, "pre": pre if shrined else None, "shrined": shrined,
            "talents": [t for t in b["talents"] if not t.startswith(("Oath: ", "Murmur: "))], "mantras": b["mantras"],
            "mods": b.get("content", {}).get("mantraModifications", {}) or {}, "oath": meta.get("Oath", "None"), "origin": meta.get("Origin"),
            "race": meta.get("Race"), "murmur": meta.get("Murmur"), "bell": meta.get("Bell"), "outfit": meta.get("Outfit"),
            "weapon": b.get("weapons") or "", "enchant": b.get("enchant") or "", "wtype": WTYPE[top_w] if final[top_w] >= 40 else "none",
            "atts": tuple(a for a in ATT if final[a] >= 40), "equipment": b.get("equipment") or {},
            "boons": [b["stats"].get("boon1"), b["stats"].get("boon2")], "flaws": [b["stats"].get(f"flaw{i}") for i in (1, 2, 3)],
            "traits": b["stats"].get("traits") or {}, "multifaceted": bool(b.get("multifaceted"))}

def cluster(items):
    def key(x, level):
        k = [x["role"], x["wtype"]]
        if level <= 1: k.append(x["atts"])
        if level == 0: k.append(x["oath"])
        return tuple(k)
    groups, leftover = {}, items
    for level in (0, 1, 2):
        g = defaultdict(list)
        for x in leftover: g[key(x, level)].append(x)
        leftover = []
        for k, members in g.items():
            if len(members) >= MIN_MEMBERS: groups[k] = members
            else: leftover.extend(members)
    return groups

def summarize(key, members, game):
    n = len(members); members = sorted(members, key=lambda x: -x["views"])
    shrined = [m for m in members if m["shrined"]]
    pre_src = shrined if len(shrined) >= max(2, n // 3) else []
    pre_modal = {s: modal([m["pre"][s] for m in pre_src]) if pre_src else 0 for s in ALL}
    post_modal = {s: modal([m["final"][s] for m in members]) for s in ALL}
    spread = {s: {"p25": pct([m["final"][s] for m in members], .25), "p50": pct([m["final"][s] for m in members], .5), "p75": pct([m["final"][s] for m in members], .75)} for s in ALL}
    stack_stat = max(CORE, key=lambda s: pre_modal[s]) if pre_src else max(CORE, key=lambda s: post_modal[s])
    stack_vals = [m["pre"][stack_stat] for m in pre_src] or [m["final"][stack_stat] for m in members]
    powers = [power_for(m["pre"]) for m in pre_src] or [12]
    tal = Counter(t for m in members for t in set(m["talents"]) if t in game["talents"])
    man = Counter(t for m in members for t in set(m["mantras"]) if t in game["mantras"])
    gems = defaultdict(Counter)
    for m in members:
        for name, mod in m["mods"].items():
            if isinstance(mod, dict) and mod.get("gem") and mod["gem"] != "None": gems[name][mod["gem"]] += 1
    equip = {}
    for slot in ("Head", "Arms", "Legs", "Torso", "Face", "Earrings", "Rings"):
        c = Counter()
        for m in members:
            v = m["equipment"].get(slot)
            for item in (v if isinstance(v, list) else [v]):
                if isinstance(item, dict) and item.get("name"): c[item["name"]] += 1
        equip[slot] = freq(c, 6, n)
    role, wtype = key[0], key[1]
    atts = key[2] if len(key) > 2 else tuple(a for a in ATT if post_modal[a] >= 40)
    oath = key[3] if len(key) > 3 else modal([m["oath"] for m in members])
    ident = "-".join([role, wtype, *(a.lower()[:5] for a in atts), oath.lower()]).replace(" ", "")
    return {
        "id": ident, "role": role, "label": f"{role.title()} · {'/'.join(atts) or 'attunementless'} · {wtype if wtype != 'none' else 'no weapon'} · {oath}",
        "members": n, "example_ids": [m["id"] for m in members[:3]], "views_total": sum(m["views"] for m in members),
        "stack": {"stat": stack_stat, "min": pct(stack_vals, .25), "modal": modal(stack_vals)},
        "pre_shrine_modal": pre_modal, "shrine_power_modal": modal(powers), "shrine_power_window": [min(powers), max(powers)],
        "shrined_rate": round(len(shrined) / n, 3), "post_shrine_modal": post_modal, "post_shrine_spread": spread,
        "talent_freq": freq(tal, 120, n), "mantra_freq": freq(man, 40, n),
        "gem_freq": {k: freq(v, 3, sum(v.values())) for k, v in gems.items()},
        "oath": freq(Counter(m["oath"] for m in members), 5, n), "origin": freq(Counter(m["origin"] for m in members), 5, n),
        "race": freq(Counter(m["race"] for m in members), 5, n), "murmur": freq(Counter(m["murmur"] for m in members), 3, n),
        "bell": freq(Counter(m["bell"] for m in members), 3, n), "outfits": freq(Counter(m["outfit"] for m in members), 6, n),
        "weapons": freq(Counter(m["weapon"] for m in members), 8, n), "enchants": freq(Counter(m["enchant"] for m in members), 5, n),
        "equipment": equip, "boons": freq(Counter(b for m in members for b in m["boons"]), 4, n), "flaws": freq(Counter(f for m in members for f in m["flaws"]), 5, n),
        "traits_modal": {t: modal([int(m["traits"].get(t, 0) or 0) for m in members]) for t in ("Vitality", "Erudition", "Proficiency", "Songchant")},
        "multifaceted_rate": round(sum(m["multifaceted"] for m in members) / n, 3),
    }

def main():
    game = json.load(open(os.path.join(ROOT, "data", "game.json"), encoding="utf-8"))
    raw = load()
    kept = [prep(b) for b in raw if b["stats"].get("pointSpent") == 330 and b["meta"].get("views", 0) >= MIN_VIEWS and b["talents"]]
    for x in kept: x["role"] = role_of({"mantras": x["mantras"]}, x["final"], x["talents"], x["oath"])
    groups = cluster(kept)
    arch = sorted((summarize(k, v, game) for k, v in groups.items()), key=lambda a: -a["views_total"])
    out = {"meta": {"generated": datetime.datetime.utcnow().isoformat() + "Z", "builds_in": len(raw), "builds_kept": len(kept), "archetypes": len(arch)}, "archetypes": arch}
    json.dump(out, open(os.path.join(ROOT, "data", "archetypes.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    open(os.path.join(ROOT, "data", "archetypes.js"), "w", encoding="utf-8").write("export default " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n")
    print(f"{len(kept)} builds -> {len(arch)} archetypes"); 
    for a in arch: print(f"  {a['members']:3d}  {a['label']}")

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: run, expect pass.** Fix the one sloppy assertion in `test_shape_and_counts` (`self.assertIn(x["stack"]["stat"], x["pre_shrine_modal"].keys())`) if you copied it verbatim. Print the archetype list and eyeball it: healer clusters should be Charisma/Flame heavy; if `hybrid` swallows > 30% of builds, tighten `role_of` thresholds (e.g. dps at wmax ≥ 60) and re-run.

- [ ] **Step 5: Commit** — `git add pipeline/mine.py pipeline/test_mine.py data/archetypes.js* && git commit -m "feat(pipeline): archetype miner"`

---

### Task 8: `engine/score.js`

**Files:** Create `engine/score.js`, `tests/score.test.js`

**Interfaces:** Produces `export function scoreBuild(core, archetype) -> {score: 0..100, breakdown: {spread, talents, mantras}}`

- spread (0–50): `1 - min(1, L1(final, post_shrine_modal) / 200)` × 50, L1 over the 16 stats.
- talents (0–30): fraction of archetype `core_talents` (freq ≥ 0.5) present in `core.talents` × 30 (100% if there are none).
- mantras (0–20): fraction of the top-8 `mantra_freq` present × 20.

- [ ] **Step 1: failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scoreBuild } from "../engine/score.js";
import { fromFeedBuild } from "../engine/convert.js";
const A = JSON.parse(readFileSync(new URL("../data/archetypes.json", import.meta.url))).archetypes;
const feeds = [...JSON.parse(readFileSync(new URL("../data/raw/feed_top.json", import.meta.url))), ...JSON.parse(readFileSync(new URL("../data/raw/feed_popular.json", import.meta.url)))];

test("an archetype's own example build scores >= 70 against it", () => {
  for (const a of A.slice(0, 10)) {
    const b = feeds.find(f => f.id === a.example_ids[0]);
    const { score } = scoreBuild(fromFeedBuild(b), a);
    assert.ok(score >= 70, `${a.id}: ${score}`);
  }
});

test("empty build scores low", () => {
  const core = fromFeedBuild(feeds[0]); core.talents = []; core.mantras = []; for (const k in core.final) core.final[k] = 0;
  assert.ok(scoreBuild(core, A[0]).score < 40);
});
```

- [ ] **Step 2: run, expect failure.** **Step 3: implement:**

```js
import { ALL_STATS } from "./stats.js";
export function scoreBuild(core, a) {
  let l1 = 0; for (const s of ALL_STATS) l1 += Math.abs((core.final[s] ?? 0) - (a.post_shrine_modal[s] ?? 0));
  const spread = 50 * (1 - Math.min(1, l1 / 200));
  const coreT = a.talent_freq.filter(([, f]) => f >= 0.5).map(([n]) => n);
  const have = new Set(core.talents);
  const talents = 30 * (coreT.length ? coreT.filter(t => have.has(t)).length / coreT.length : 1);
  const topM = a.mantra_freq.slice(0, 8).map(([n]) => n);
  const haveM = new Set(core.mantras);
  const mantras = 20 * (topM.length ? topM.filter(m => haveM.has(m)).length / topM.length : 1);
  const score = Math.round(spread + talents + mantras);
  return { score, breakdown: { spread: Math.round(spread), talents: Math.round(talents), mantras: Math.round(mantras) } };
}
```

- [ ] **Step 4: run, expect pass.** If example builds score < 70 it means the cluster is too loose — lower `l1 / 200` to `/ 250` only if the *median* example score is ≥ 70; otherwise fix the miner.
- [ ] **Step 5: Commit** — `git commit -m "feat(engine): meta score"`

---

### Task 9: `engine/assemble.js` part 1 — archetype selection and stat planning

**Files:** Create `engine/assemble.js`, `tests/assemble.test.js`

**Interfaces:**
- Consumes: `stats.js`, `shrine.js`, `validate.js` (`talentObtainable, mantraUsage, WARDER_CATEGORY, grantedTalents`), `score.js`, `convert.js` (`toDraft`).
- Produces (this task):
```js
export function normalizeRequest(partial) -> Request        // fills defaults (§2.1 of spec)
export function selectArchetype(req, archetypes) -> {archetype, adapted: boolean}
export function planStats(req, archetype, game) -> {preShrine: Flat|null, shrinePower: number|null, shrineBase: Flat|null, final: Flat, race: string, multifaceted: boolean, notes: string[]}
```

Request defaults: `role:"dps", include_attunements:[], exclude_attunements:[], attunementless:false, weapon_type:null, weapon:null, oath:null, origin:null, race:null, shrine:true, multifaceted:false, must_talents:[], avoid_talents:[], must_mantras:[], avoid_mantras:[], free_text:""`.

`selectArchetype`: candidates with `role === req.role` (fallback: all). Score = 100 − 30·(excluded attunement with modal ≥ 20 present) + 20·(each included attunement with modal ≥ 20) + 15·(weapon type matches archetype top weapon stat / `none` matches no weapon ≥ 40) + 10·(oath matches top oath) + log10(views_total). `adapted = true` when any include is missing or any exclude is present in the winner.

`planStats` algorithm:
1. `race = req.race ?? top archetype race ?? "None"`; `bonus = multifaceted ? {} : game.races[race]`.
2. `target = {...post_shrine_modal}`, `pre = {...pre_shrine_modal}` (if archetype `shrined_rate < 0.3` or `!req.shrine` → `pre = null`).
3. Excludes: `target[a] = 0`, `pre[a] = 0`. Attunementless: all attunements 0. Includes not already ≥ 20: `target[a] = 40`; `pre[a] = max(pre[a], 1)`.
4. Weapon: `none` → all weapon stats 0; a type → that stat `max(target, 65)`, other weapon stats 0, `pre[w] = max(pre[w], 1)` (weapon stat drops ≤ 25 so pre 1 is fine).
5. Must-haves: for each must talent/mantra, `target[canon(k)] = max(target, v)` for its stat reqs (ignore Power/Body/Mind/Weapon/Attunement).
6. `pre[stack.stat] = max(pre[stack.stat], stack.min)`. Race bonus: `pre[s] = max(pre[s], bonus[s])`, `target[s] = max(target[s], bonus[s])`. Any `target[s] > 0` ⇒ `pre[s] = max(pre[s], 1)`.
7. If `pre`: cap `pointsSpent(pre)` ≤ `pointsForPower(min(19, max(shrine_power_modal, 8)))` + 14 by reducing non-stack stats proportionally (never below 1 or bonus); `shrineBase = shrineOfOrder(pre, bonus).base`; `target[s] = max(target[s], shrineBase[s])`; `shrinePower = powerFor(pre)`.
8. Fit to 330: `floor[s] = max(shrineBase?.[s] ?? 0, bonus[s] ?? 0, mustMin[s] ?? 0, s === stack.stat ? min(target[s], stack.modal - 25) : 0)`. While `pointsSpent(target) > 330`: pick the stat with the largest `target[s] − floor[s]` **that is not in `priority`** (priority = stack stat, must-have stats, included attunements), decrement by 1; if none, decrement the largest priority slack. While `< 330`: raise, in order, the stat with the largest `post_shrine_spread[s].p75 − target[s]` among stats with `target[s] > 0` (cap 100); if all at p75, add to the stack stat, then to Fortitude.
9. Return `{preShrine: pre, shrinePower, shrineBase, final: target, race, multifaceted, notes}`; `notes` records every adaptation in plain words ("Ironsing removed", "Flamecharm added at 40").

- [ ] **Step 1: failing tests** — `tests/assemble.test.js` (part 1)

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeRequest, selectArchetype, planStats } from "../engine/assemble.js";
import { pointsSpent, ATTUNEMENTS, WEAPON_STATS } from "../engine/stats.js";
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
```

- [ ] **Step 2: run, expect failure.**
- [ ] **Step 3: implement** `normalizeRequest`, `selectArchetype`, `planStats` in `engine/assemble.js` per the algorithm above. Keep each as its own exported function; helper `fitTo330(target, floor, priority, spread, stackStat)` separate and pure.
- [ ] **Step 4: run, expect pass.** Common failure: shrine base for a core stat exceeding target because `pre` was capped oddly — fix by applying the shrine *before* the weapon/attunement edits are considered final (step 7 must run after steps 3–6, as listed).
- [ ] **Step 5: Commit** — `git add engine/assemble.js tests/assemble.test.js && git commit -m "feat(engine): archetype selection and stat planning"`

---

### Task 10: `engine/assemble.js` part 2 — talents, mantras, gear, guide, `assemble()`

**Files:** Modify `engine/assemble.js`, `tests/assemble.test.js`; create `engine/index.js`

**Interfaces — Produces:**
```js
export function pickTalents(req, archetype, coreDraft, game) -> {talents: string[], groups: {core, recommended, choose}, dropped: [{name, why}]}
export function pickMantras(req, archetype, coreDraft, game) -> {mantras: string[], mantraMods: {}, dropped: []}
export function pickGear(req, archetype, coreDraft, game) -> {outfit, weapon, enchant, equipment, boons, flaws, traits, murmur, bell, origin, oath}
export function buildGuide(build, game) -> guide[]
export function assemble(partialRequest, archetypes, game) -> Build
// engine/index.js re-exports everything from stats, shrine, convert, validate, score, assemble
```

`pickTalents`: candidates in order = `must_talents` → `talent_freq` names (desc) minus `avoid_talents`. `coreDraft` = BuildCore with `talents: []` so far. Loop until no change: for each candidate not yet taken, if `talentObtainable(name, {...coreDraft, talents: taken}, game).ok` → take. Then a second pass: for taken talents whose `pre` are missing but obtainable, add them (prerequisite auto-add). Warder cap: keep the first 4 (by candidate order) with `category === WARDER_CATEGORY` (excluding `Justicar's Gift`); the rest go to `groups.choose["Warder path (pick 4)"]`. `groups.core` = taken with freq ≥ 0.5 or must; `groups.recommended` = the rest. Always append `Oath: <oath>` handled by `toDraft` — do not add here. `dropped` lists must-haves that were unobtainable with `why`.

`pickMantras`: candidates = `must_mantras` → `mantra_freq` names → oath mantras from `game.oaths[oath].mantras` (all categories), minus avoids. Take if `game.mantras[name]` exists, `reqs` met at final, attunement (if any) > 0 at final, and adding it keeps `mantraUsage(...).overflow === 0` (Oath/Origin-type mantras bypass slots). `mantraMods[name] = {gem: top gem_freq[name] ?? "None", spark: "None"}`.

`pickGear`: `oath = req.oath ?? archetype.oath[0]`, `origin = req.origin ?? archetype.origin[0]`, murmur/bell/boons/flaws/traits from archetype modals (boons: first two ≠ None; flaws: first three, pad "None"); `outfit` = first of `archetype.outfits` whose reqs are met at final and origin matches (else "None"); `weapon` = `req.weapon` if given, else `""` when `weapon_type === "none"`, else first of `archetype.weapons` with matching `wtype` and reqs met (else first any-type with reqs met, else ""); `enchant` = top enchant if a weapon; `equipment[slot]` = `{name, qualityStars: 3, pips: [], enchant: ""}` for the top item per slot (Rings: top 4), `null` if none.

`buildGuide`: 
- pre phase (if shrine): steps ordered stack stat first, then other pre stats descending; each step `"<Stat> → <n>"` with `unlocks` = taken talents whose stat reqs become met once that stat reaches n given earlier steps (simulate cumulative flat).
- `{phase:"shrine", step:"Shrine of Order at Power <p>", unlocks: []}` with a `detail` string listing the resulting base.
- post phase: stats where `final[s] > base[s]`, ordered: must-have/included attunement stats first, then by final value desc; `unlocks` computed the same way from base upward; mantras unlocked are appended with `"(mantra)"` suffix.
- If no shrine: single phase `"pre"` from zero to final.

`assemble(partial, archetypes, game)`: `req = normalizeRequest(partial)`; `{archetype, adapted} = selectArchetype`; `plan = planStats`; build `core` = {name: `${archetype.label}` (or "Custom " + role if adapted), description: one sentence with stack stat / shrine power / top stats, notes: plan.notes joined, ...gear, multifaceted, shrine: !!plan.preShrine, preShrine, final, talents, mantras, mantraMods, equipment}. Then `validation = validate(core, game)`; `{score} = scoreBuild(core, archetype)`; `guide`; `draft = toDraft(core)`. Return Build.

- [ ] **Step 1: failing tests** (append to `tests/assemble.test.js`)

```js
import { assemble } from "../engine/assemble.js";
import { validate } from "../engine/validate.js";

test("assemble: every archetype's default request is valid and scores >= 70", () => {
  const bad = [];
  for (const a of A) {
    const b = assemble({ role: a.role, oath: a.oath[0]?.[0] ?? null }, A.filter(x => x.id === a.id), game);
    if (!b.validation.ok || b.meta_score < 70) bad.push({ id: a.id, score: b.meta_score, errors: b.validation.errors.slice(0, 4) });
  }
  assert.deepEqual(bad, [], JSON.stringify(bad, null, 1));
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
```

- [ ] **Step 2: run, expect failure.**
- [ ] **Step 3: implement** the four pickers, `buildGuide`, `assemble`, and `engine/index.js`:

```js
export * from "./stats.js"; export * from "./shrine.js"; export * from "./convert.js";
export * from "./validate.js"; export * from "./score.js"; export * from "./assemble.js";
```

- [ ] **Step 4: run, expect pass.** Expect iteration here. Typical fixes: (a) a talent needs `Power 20` at pre-shrine → phase logic already allows final; (b) `mantra_slots` overflow because oath mantras were counted → ensure `type !== "Normal"` bypass; (c) score < 70 because `pickTalents` skipped core talents whose prerequisites weren't in `talent_freq` → prerequisite auto-add pass must run. If an archetype cannot reach 70 after fixes, print its breakdown; if `spread` is the problem the miner's cluster is too loose — raise `MIN_MEMBERS` to 5 for that role and re-mine rather than lowering the gate.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(engine): talents, mantras, gear, guide, assemble()"`

---

### Task 11: Healer regression test

**Files:** Create `tests/regression_healer.test.js`

- [ ] **Step 1: write the test**

```js
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
```

- [ ] **Step 2: run** — if it fails on stat distance, the tolerance is ±15 by design; do not widen it. Fix the healer archetype selection/ranking or the must-have stat raising instead.
- [ ] **Step 3: Commit** — `git add tests/regression_healer.test.js && git commit -m "test: healer regression"`

---

### Task 12: `pipeline/verify_builder.py` — real-builder check

**Files:** Create `pipeline/verify_builder.py`, `pipeline/export_builds.mjs`

**Interfaces:**
- `node pipeline/export_builds.mjs out_dir` → writes `out_dir/<archetype_id>.json` = `{ "build": <draft>, "phase": "post"|"pre", "meta_score": n, "archetype_id": id }` for every archetype's default request (uses `assemble` + `draftEnvelope`).
- `python pipeline/verify_builder.py <file-or-dir> [--headless] [--keep] [--screenshot-dir DIR]` → prints one JSON line per build: `{"id", "ok", "power", "pointSpent", "issueCount", "issues": [..], "talentsAccepted": n, "talentsSent": n, "shrineMode"}`; exit 1 if any `ok` is false. `ok` = `issueCount == 0 && pointSpent == 330 && power == 20`.

Implementation: import `dwfill` (same folder) and reuse `DEFAULT_PROFILE`, `CHROME_EXE`, `BUILDER_URL`, `DRAFT_KEY`, `JS_DOM_SNAPSHOT`, and its localStorage-init route (read `dwfill.main` for the exact Playwright sequence: `add_init_script` setting the draft key, `goto(BUILDER_URL)`, wait ~1.5 s, evaluate the pinia store read). Extend the DOM snapshot with the issue texts:

```js
out.issues = [...document.querySelectorAll('[class*="issue"], [class*="warning"], [class*="error"]')]
  .map(e => (e.textContent || '').replace(/\s+/g,' ').trim()).filter(t => t && t.length < 300);
```

Use `--headless` in CI-style runs (Haiku worker); default headless = true, `--show` to watch.

- [ ] **Step 1: write `pipeline/export_builds.mjs`**

```js
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { assemble, draftEnvelope } from "../engine/index.js";
const game = JSON.parse(readFileSync(new URL("../data/game.json", import.meta.url)));
const A = JSON.parse(readFileSync(new URL("../data/archetypes.json", import.meta.url))).archetypes;
const out = process.argv[2] ?? "out/builds"; mkdirSync(out, { recursive: true });
for (const a of A) {
  const b = assemble({ role: a.role, oath: a.oath[0]?.[0] ?? null }, [a], game);
  const env = draftEnvelope(b);
  writeFileSync(`${out}/${a.id}.json`, JSON.stringify({ ...env, meta_score: b.meta_score, archetype_id: a.id, validation: b.validation }, null, 1));
}
console.log(`wrote ${A.length} builds to ${out}`);
```

- [ ] **Step 2: write `pipeline/verify_builder.py`** reusing dwfill; smoke test with the healer fixture: `python pipeline/dwfill.py tests/fixtures/spec_healer_final.json --no-wait` must still work (proves the copied dwfill is intact), then `node pipeline/export_builds.mjs out/builds && python pipeline/verify_builder.py out/builds/<one id>.json`.
- [ ] **Step 3: run on one build, confirm the JSON line shows `power: 20, pointSpent: 330`.** If `issueCount` > 0, print `issues` — these are real builder complaints and must be fed back into `validate.js` as new rules (Task 13).
- [ ] **Step 4: add `out/` to `.gitignore`; commit** — `git add pipeline/verify_builder.py pipeline/export_builds.mjs .gitignore && git commit -m "feat(pipeline): real-builder verification"`

---

### Task 13: Full verification sweep (Haiku worker) and fix loop

- [ ] **Step 1:** `node pipeline/export_builds.mjs out/builds && python pipeline/verify_builder.py out/builds --headless > out/verify.jsonl`; summarise: count ok/not ok, list every distinct issue string.
- [ ] **Step 2:** For each distinct builder issue not caught by `validate.js`, add a failing test in `tests/validate.test.js` reproducing it from the offending build (Sonnet), implement the rule, re-run `npm test`, re-export, re-verify.
- [ ] **Step 3:** Done when `verify.jsonl` has zero `ok:false` and `npm test` + `npm run pytest` are green. Commit: `git commit -am "fix(engine): rules learned from real-builder verification"`

---

### Task 14: `page/index.html` — UI, engine wiring, copy code, bookmarklet

**Files:** Create `page/index.html`, `page/app.js`, `page/styles.css`

Load `superpowers`-independent design skill guidance? No — follow the spec §3 and the artifact rules: no external libs, ES modules from relative paths, theme tokens on `:root` with dark overrides under both `@media (prefers-color-scheme: dark)` guarded `:root:not([data-theme="light"])` and `:root[data-theme="dark"]`, body gets an explicit token background, 16 px side gutters, stacks under 800 px.

`page/app.js`:
```js
import * as E from "../engine/index.js";
import GAME from "../data/game.js";
import ARCH from "../data/archetypes.js";
// state, form → request, render(build), copy, bookmarklet, ai, library
```
Published paths (Task 16) are `engine/*.js`, `data/game.js`, `data/archetypes.js`, `app.js`, `styles.css` relative to the page, so `app.js` imports must be `./engine/index.js`, `./data/game.js`, `./data/archetypes.js` — put `app.js` at the repo root of the published set and use `root: "."` with a files map that publishes `page/app.js` at `app.js`. Locally, open via a tiny static server (`python -m http.server 8080` from repo root → `http://localhost:8080/page/`) — for that to resolve the same relative paths, `page/app.js` imports use `../engine/index.js` locally; **resolve this by publishing with the files map `{"engine/index.js": "engine/index.js", …, "app.js": "page/app.js"}` and writing imports as `./engine/index.js`, and for local testing serve from a temp dir that mirrors the published layout** (`pipeline/serve_local.py` copies page/* + engine/* + data/*.js into `out/site/` and serves it). Add that script (20 lines, `shutil.copytree` + `http.server`).

Form fields (ids): `role, att-include (chips), att-exclude (chips), attunementless, weapon-type, weapon (datalist from GAME.weapons filtered by type), oath, origin, race, shrine, multifaceted, must-talents (chips w/ datalist), avoid-talents, must-mantras, avoid-mantras, free-text, generate`.
Right pane: `build-header` (name, score badge, "based on N builds", example links `https://deepwoken.co/builder?id=<id>`), `guide` list, `stats-table`, `talents` (three groups), `mantras` (name + gem), `gear`, `warnings`, action bar: `copy-code`, `bookmarklet` link + 3 steps, `ai-refine` (hidden), `save-library` (hidden), `library` tab.

Bookmarklet (href = `"javascript:" + encodeURIComponent(src)`):
```js
(()=>{if(location.hostname!=='deepwoken.co'){alert('Open https://deepwoken.co/builder first, then click this bookmark.');return;}
const s=prompt('Paste the build code from dwbuilder:');if(!s)return;
try{const env=JSON.parse(s);if(env.version!==1||!env.build)throw 0;localStorage.setItem('_dwb.draft.v1.new',JSON.stringify(env));location.href='/builder';}
catch(e){alert('That did not look like a dwbuilder build code.');}})();
```
"Copy build code" copies `JSON.stringify(E.draftEnvelope(build))`.

- [ ] **Step 1:** write `styles.css` (tokens, layout, chips, table, badge) and `index.html` skeleton with `<title>Deepwoken Forge</title>` at top.
- [ ] **Step 2:** write `app.js`: populate selects from GAME (oaths, origins, races, weapons by type), chips with datalist validation (`unknown name → chip rejected + nearest 3 suggestions by case-insensitive substring`), `generate()` → `E.assemble(req, ARCH.archetypes, GAME)` → `render()`; when role changes, set the other selects to "auto" (empty = null).
- [ ] **Step 3:** local run: `python pipeline/serve_local.py` → open `http://localhost:8080/`, generate a healer, click Copy, open deepwoken.co/builder in the same browser, run the bookmarklet, paste → builder shows the build with Power 20 and 0 issues. Record a screenshot in `out/`.
- [ ] **Step 4:** Commit — `git add page pipeline/serve_local.py && git commit -m "feat(page): generator UI, copy code, bookmarklet"`

---

### Task 15: Page — `sample` refine and `db` library

**Files:** Modify `page/app.js`, `page/index.html`

- [ ] **Step 1: AI refine.** On load: `const sample = await claude.use("sample")` (wrapped in try; `null` → keep button hidden). Click handler:

```js
const slice = {
  talents: Object.fromEntries([...build.talents, ...candidateTalents(build, 60)].map(t => [t, { reqs: GAME.talents[t]?.reqs, desc: GAME.talents[t]?.desc }])),
  mantras: Object.fromEntries([...build.mantras, ...candidateMantras(build, 30)].map(m => [m, { reqs: GAME.mantras[m]?.reqs, category: GAME.mantras[m]?.category, desc: GAME.mantras[m]?.desc }])),
};
const prompt = `You are refining a Deepwoken build. Only propose swaps using names present in the provided lists. Return JSON {"swaps":[{"kind":"talent"|"mantra","remove":string|null,"add":string|null,"reason":string}],"playstyle":string}. Max 6 swaps. Player's request: ${req.free_text}\nBuild: ${JSON.stringify({final: build.final, talents: build.talents, mantras: build.mantras, oath: build.oath, origin: build.origin})}\nAvailable: ${JSON.stringify(slice)}`;
const res = await sample.json(prompt, { modelTier: "quick" });
```
Apply each swap to a clone, run `E.validate`; keep only swaps that leave `ok === true`; list rejected swaps under Warnings; re-score; show `playstyle`. Error codes: `not_granted` → hide button; `rate_limited` → toast "try again in a minute"; anything else → toast with message. `candidateTalents(build, n)` = top-n `talent_freq` names of the build's archetype not already taken and obtainable (`E.talentObtainable`); similarly for mantras.

- [ ] **Step 2: Library.** `const db = await claude.use("db")`; if non-null show Save + Library tab. Save: `db.collection("builds").doc(id).set({name, author: promptName, request: req, build: {…build without draft}, created: Date.now()})` where `id = crypto.randomUUID()`. Library tab: `db.collection("builds").orderBy("created","desc").limit(50).onSnapshot(...)` → cards (name, author, score, role) → "Load" re-renders that build (recompute `draft` via `E.toDraft`). Read `0.2.46/db.d.ts` in the artifact-capabilities skill folder before writing this — signatures there are authoritative.
- [ ] **Step 3:** local run still works with both capabilities `null` (buttons hidden, nothing throws — check console).
- [ ] **Step 4:** Commit — `git commit -am "feat(page): AI refine and shared library"`

---

### Task 16: Publish, README, memory

- [ ] **Step 1: README.md** — what it is; `npm test` / `npm run pytest`; refresh data: re-run `feedscrape.py` in the temp dir (or copy it into `pipeline/`), copy outputs to `data/raw/`, `npm run pipeline`, `npm test`, `node pipeline/export_builds.mjs out/builds && python pipeline/verify_builder.py out/builds`, then republish; bookmarklet instructions for friends; the quality gates.
- [ ] **Step 2: Publish** (done by the main session, not a worker): load `artifact-design` skill, then `Artifact` with `file_path: page/index.html`, `files: {"app.js":"page/app.js","styles.css":"page/styles.css","engine/index.js":"engine/index.js","engine/stats.js":…,"engine/shrine.js":…,"engine/convert.js":…,"engine/validate.js":…,"engine/score.js":…,"engine/assemble.js":…,"data/game.js":"data/game.js","data/archetypes.js":"data/archetypes.js"}`, `capabilities: {sample: {}, db: {}}`, `favicon: "⚔️"`, `description: "Pick a role and attunements, get a verified Deepwoken build with a guide and one-click builder import."`.
- [ ] **Step 3:** open the published page, generate a healer, run the bookmarklet import end-to-end once more against the live URL; fix any path/CSP issue and republish.
- [ ] **Step 4:** Update memory: `project_deepwoken_builds.md` → point at `C:\Users\G-Force\Downloads\dwbuilder` and the artifact URL; note the tool replaces hand-made specs.
- [ ] **Step 5:** Final commit — `git add -A && git commit -m "docs: README and publish notes"`.

---

## Self-review

- Spec §1.1 mine → Task 7; §1.2 slimdata → Task 4; §1.3 verify → Tasks 12–13; §2.2 shrine → Task 3; §2.3 assemble → Tasks 9–10; §2.4 validate → Task 6; §2.5 score → Task 8; §2.6 output shape → Task 10 `assemble()`; §3 page → Tasks 14–15; §4 worker streams → task headers name the model; §5 tests → Tasks 3, 6, 9, 10, 11, 13; §6 error handling → Tasks 14–15 (banner on missing data: add in Task 14 Step 2 — if `ARCH`/`GAME` import fails the module script errors; wrap `app.js` bootstrap in a `try` that writes a banner into `#error-banner`); §7 gates → Tasks 10, 11, 13; §8 done → Task 16.
- Names checked across tasks: `pointsSpent, powerFor, pointsForPower, meetsStats, reqValue, canon, zeroFlat, flatten, nest` (T2) used in T3/T6/T9; `shrineOfOrder` (T3) in T6/T9; `fromFeedBuild, fromSpec, toDraft, draftEnvelope` (T5) in T6/T8/T10/T12/T14; `validate, talentObtainable, mantraSlots, mantraUsage, grantedTalents, WARDER_CATEGORY` (T6) in T10/T11/T15; `scoreBuild` (T8) in T10; `normalizeRequest, selectArchetype, planStats, assemble` (T9/T10) in T11/T12/T14.
