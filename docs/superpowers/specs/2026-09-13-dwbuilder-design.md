# dwbuilder — Deepwoken build generator (design spec)

Date: 2026-09-13
Status: approved in brainstorming, ready for implementation plan

## Goal

A shareable web page (published claude.ai artifact) where the owner and their
friends pick a role, attunements, weapon, oath, etc. and instantly get a
high-quality, fully valid Deepwoken build in the same shape high-view
deepwoken.co community builds have — plus a step-by-step guide and a one-click
way to import it into the deepwoken.co builder.

"High quality" is defined by the quality gates in §7, not by opinion.

## Non-goals

- Saving builds to deepwoken.co on a viewer's behalf (needs their Discord login).
- Tier lists, PvP matchup advice, in-game progression routing beyond the build.
- Automatic feed re-scraping (owner re-runs `feedscrape.py` when they want
  fresher data, then re-runs the pipeline).
- Any server other than the artifact platform.

## Repository layout

```
C:\Users\G-Force\Downloads\dwbuilder\
  README.md
  package.json               # node test runner only (no bundler)
  data/
    raw/                     # copied from %TEMP%\claude: feed_top.json,
                             # feed_popular.json, gamedata.json (git-ignored)
    archetypes.json          # output of mine.py
    game.json                # output of slimdata.py
  pipeline/
    mine.py
    slimdata.py
    verify_builder.py        # wraps existing dwfill.py (copied to pipeline/)
    dwfill.py
  engine/
    shrine.js
    assemble.js
    validate.js
    score.js
    index.js                 # re-exports; also the file the page loads
  tests/
    shrine.test.js
    validate.test.js
    assemble.test.js
    corpus.test.js
    regression_healer.test.js
    fixtures/                # spec_healer_final.json, known real builds
  page/
    index.html
    (engine/index.js and data/*.json are published as supporting files)
  docs/superpowers/specs/, docs/superpowers/plans/
```

Engine is plain ES modules with no dependencies so the same files run under
Node's built-in test runner (`node --test`) and in the browser.

## 1. Data pipeline (Python, run on the owner's PC)

### 1.1 `pipeline/mine.py` → `data/archetypes.json`

Input: `data/raw/feed_top.json`, `data/raw/feed_popular.json` (deduped by
build id; ~1,200 builds). Each record has `preShrine`, `postShrine`,
`attributes` (final stats), `talents`, `mantras`, `weapons`, `equipment`,
`meta` (views/votes), `content` (origin/oath/race/murmur/bell/notes).

Filtering: keep builds with 330 stat points spent, views ≥ 500, and a
non-empty talent list. Record the count kept.

Role tagging (a build may get one primary role and optional secondary tags):

| Role | Signal |
|---|---|
| healer | any of: Graceful Flame + Undying Flame, Command: Live, Symbiotic Sustain, Alsin's Aid, Linkstrider oath, Warder talents; Charisma ≥ 50 or Flamecharm ≥ 40 with Willpower ≥ 40 |
| tank | Fortitude ≥ 75 final, or Reinforced Armor / Moving Fortress present |
| dps | highest final stat is a weapon stat ≥ 65 |
| mage | highest final stat is an attunement ≥ 65 and weapon stat < 65 |
| hybrid | none of the above dominate (two stats within 10 of each other at the top) |

Sub-cluster within a role by (primary weapon type, attunement set ≥ 40,
oath). Drop clusters with fewer than 4 members. Each archetype records:

```json
{
  "id": "healer-cha-flame-linkstrider",
  "role": "healer",
  "label": "Charisma/Flame healer (Linkstrider)",
  "members": 27,
  "example_ids": ["4S7J6sgE", "..."],      // top 3 by views
  "views_total": 123456,
  "stack": {"stat": "Charisma", "min": 85, "modal": 90},
  "pre_shrine_modal": {"Charisma": 90, "Fortitude": 50, "Agility": 40, "...": 1},
  "shrine_power_window": [8, 15],
  "post_shrine_modal": {"Charisma": 65, "Fortitude": 50, ...},
  "post_shrine_spread": {"Charisma": {"p25": 60, "p50": 65, "p75": 75}, ...},
  "core_talents": ["Command: Live", "..."],   // taken by >=50% of members
  "common_talents": ["..."],                  // 25–50%
  "mantras": [["Graceful Flame", 0.93], ...], // frequency
  "oath": [["Linkstrider", 0.8], ...],
  "origin": [...], "race": [...], "murmur": [...], "bell": [...],
  "outfits": [...], "weapons": [...], "equipment": {"slot": [[name, freq], ...]},
  "multifaceted_rate": 0.4,
  "shrined_rate": 0.9
}
```

Also emits `data/archetypes.json#meta`: build count, generated date, source
file hashes.

### 1.2 `pipeline/slimdata.py` → `data/game.json`

Trim `data/raw/gamedata.json` to:

- `talents[name] = {reqs:{stat:n}, pre:[names], category, rarity, desc(≤160 chars), oath?, origin?, outfit?}`
- `mantras[name] = {attunement, reqs:{stat:n}, category, desc(≤160 chars)}`
- `outfits[name] = {reqs:{}, talent?, stats:{...}}`
- `weapons[name] = {type: light|medium|heavy, reqs:{}, attunement?}`
- `equipment[name] = {slot, ...}` (only items that appear in ≥1 archetype)
- `oaths`, `origins`, `races`, `murmurs`, `bells` — name lists plus reqs.
- `stats`: canonical names + aliases (from `dwfill.py`).

Target size < 400 KB. Everything the engine references must resolve to a key
here; the miner drops any talent/mantra name that does not.

### 1.3 `pipeline/verify_builder.py`

`python verify_builder.py build.json [--headless] [--screenshot out.png]`

Converts an engine output (§2.5 format) to the `dwfill.py` spec format, loads
it into the real deepwoken.co builder (existing localStorage-draft route),
then reads from the pinia store: power, points spent, the builder's own
warnings/errors list (missing prerequisites, unmet reqs), and the talent list
the builder actually accepted. Prints a JSON report; exit code 1 if any
error or points ≠ 330. Chrome is closed on exit unless `--keep`.

## 2. Engine (JavaScript, shared by tests and page)

### 2.1 Input (`Request`)

```ts
{
  role: "healer"|"dps"|"tank"|"mage"|"hybrid",
  include_attunements: string[], exclude_attunements: string[],
  attunementless: boolean,
  weapon_type: "light"|"medium"|"heavy"|"none"|null,
  weapon: string|null,
  oath: string|null, origin: string|null, race: string|null,
  shrine: boolean, multifaceted: boolean,
  must_talents: string[], avoid_talents: string[],
  must_mantras: string[], avoid_mantras: string[],
  free_text: string
}
```

### 2.2 `shrine.js`

Port of `shrine_sim.py`: `shrine(pre) -> {base, leftover}`; only stats with
≥1 point are averaged; core/weapon stats cannot drop more than 25;
attunements can drop any amount; remainder is returned as free points.
Also `powerForPoints(points)` and `pointsForPower(power)` using the builder's
progression table (extracted into `game.json#progression`).

### 2.3 `assemble.js` — `assemble(request, archetypes, game) -> Build`

1. **Select archetype**: score every archetype against the request (role
   match required; +attunement overlap, +weapon type, +oath, −excluded
   attunements present); pick best. If no archetype has the requested role +
   attunement combo, take the best same-role archetype and mark the build
   `adapted: true`.
2. **Pre-shrine plan**: start from `pre_shrine_modal`; enforce the stack
   stat at ≥ `stack.min`; put 1 point in every stat the request wants in the
   average (included attunements, weapon stat); remove excluded attunements;
   must-have talents/mantras whose reqs exceed the plan raise the relevant
   stat (respecting the 25-loss rule so it survives the shrine).
3. **Shrine**: if `request.shrine`, shrine at the archetype's modal power
   (clamped to window). Compute `base` and `leftover`.
4. **Post-shrine plan**: distribute remaining points to reach
   `post_shrine_modal`, adjusted for included/excluded attunements and
   must-haves; final total exactly 330 (Power 20). If `shrine=false`, plan is
   a single pass to the post-shrine modal.
5. **Talents**: core talents first, then must-haves, then common talents,
   all filtered by final reqs and prerequisites; avoid list removed; oath /
   origin / outfit talents added; Warder path talents capped at 4 (extra ones
   listed as "choose from"). Fill toward the talent count the builder grants at Power 20
   (`game.json#progression`) using archetype frequency order.
6. **Mantras**: archetype frequency order filtered by attunement and reqs,
   plus must-haves, minus avoids; attach deep-gem suggestions from a small
   static table (`game.json#gems`) keyed by mantra.
7. **Gear**: outfit, weapon (or "" with a note when weapon_type = none),
   enchant, equipment per slot, from archetype frequencies filtered by reqs.
8. **Guide**: ordered steps — pre-shrine stat order with unlocked talents
   per step, shrine step, post-shrine order, final table.

### 2.4 `validate.js` — `validate(build, game) -> {ok, errors[], warnings[]}`

Errors (build invalid): points ≠ 330; shrine base mismatch; any stat > 100;
talent/mantra/outfit/weapon requirement unmet at the phase it is taken;
missing prerequisite talent; excluded attunement > 0; Warder talents > 4;
name not in `game.json`; duplicate talent; mantra count over the builder's Power 20 slot count.
Warnings: adapted archetype; unfilled talent slots; oath reqs not met until
post-shrine; anything the builder would show as a notice.

### 2.5 `score.js` — `score(build, archetype) -> {score, breakdown}`

0–100 = 50 × spread similarity (1 − normalised L1 distance between final
stats and `post_shrine_modal`, capped) + 30 × core-talent coverage + 20 ×
mantra overlap. Reported with the member count and example IDs.

### 2.6 Output (`Build`)

```json
{
  "name": "...", "archetype_id": "...", "adapted": false,
  "meta_score": 84, "based_on": {"members": 27, "examples": ["4S7J6sgE"]},
  "origin": "...", "oath": "...", "race": "...", "murmur": "...", "bell": "...",
  "outfit": "...", "weapon": "...", "enchant": "...",
  "boons": [], "flaws": [], "traits": {},
  "pre_shrine": {"Charisma": 90, ...}, "shrine_power": 12,
  "shrine_base": {...}, "post_shrine": {...}, "final": {...},
  "talents": {"core": [], "recommended": [], "choose": {"Warder (pick 4)": []}},
  "mantras": [{"name": "...", "gem": "..."}],
  "equipment": {"slot": "name"},
  "guide": [{"phase": "pre", "step": "Charisma → 90", "unlocks": [...]}, ...],
  "validation": {"ok": true, "errors": [], "warnings": []},
  "draft": { ...exact dwfill.py spec object... }
}
```

`draft` is the object the page serialises for "Copy build code" and that
`verify_builder.py` consumes.

## 3. Page (`page/index.html`)

Single artifact; supporting files `engine/index.js`, `data/archetypes.json`,
`data/game.json`. No external libraries. Capabilities declared:
`{sample: {}, db: {}}`. The page fully works when both resolve `null`.

Layout: two panes, stacking under 800 px. Left = request form (§2.1 fields as
dropdowns/chips/search; must/avoid chips autocomplete from `game.json`;
role changes default the other dropdowns to the best archetype's modal
values, shown as "auto"). Right = build view: header (name, meta score,
"based on N builds", example links to `https://deepwoken.co/builder?id=`),
guide steps, final stats table, talents grouped, mantras with gem, gear,
warnings, and the action bar.

Action bar:
- **Copy build code** — copies `JSON.stringify(build.draft)`.
- **Import bookmarklet** — a `javascript:` link the viewer drags to their
  bookmarks bar; on deepwoken.co/builder it prompts for the code, writes
  `localStorage["_dwb.draft.v1.new"] = {version:1, build, phase:"post",
  baseline:""}`, and reloads. Three-step instructions beside it.
- **Refine with AI** (hidden when `sample` is null) — sends the valid build,
  the free text, and the relevant `game.json` slices to `sample.json` (quick
  tier) asking for `{swaps:[{kind, remove, add, reason}], playstyle}`; each
  swap is applied to a copy and re-validated; invalid swaps are dropped and
  listed; the playstyle paragraph is shown.
- **Save to library** (hidden when `db` is null) — writes
  `builds/<id>` {name, author, request, build, created}; **Library** tab
  lists and loads them.

Theme: dark ink/navy with gold accent as default, full light palette on
`:root`, dark overrides under both the media query and `[data-theme=dark]`.

## 4. Verification workflow (workers)

Streams run in parallel on cheap models; Opus only plans, dispatches, reviews.

| Stream | Model | Output |
|---|---|---|
| Data | Sonnet | `mine.py`, `slimdata.py`, generated JSON |
| Engine | Sonnet | engine modules + tests, TDD |
| Page | Sonnet | `index.html` + wiring |
| Verify | Haiku | `verify_builder.py` runs, report per archetype, corpus re-validation |

Engine stream depends on Data output shape (fixture-driven until real data
lands); Page depends on Engine's exported API; Verify runs last.

## 5. Tests

- `shrine.test.js`: the 5 real builds in `shrine_sim.py` reproduce.
- `validate.test.js`: each error class triggers on a crafted bad build; the
  30 highest-view corpus builds validate with zero errors.
- `assemble.test.js`: every archetype × {shrine on/off} × {each attunement
  included, each excluded} × {each weapon type} assembles to `validation.ok`
  and 330 points.
- `regression_healer.test.js`: request "healer, include Flamecharm, exclude
  Ironsing, Justicar, Linkstrider, weapon none, multifaceted" yields final
  stats within ±10 of `spec_healer_final.json` on every stat, contains
  Graceful Flame, Symbiotic Sustain, Reinforce, and Warder talents ≤ 4.
- `verify_builder.py` on every archetype's default build: zero builder
  errors, points 330.

## 6. Error handling

- Missing/invalid `data/*.json` → page shows a clear banner, form disabled.
- Unknown name in must/avoid → chip rejected with suggestion.
- Impossible request (e.g. must-have talent needing an excluded attunement)
  → build still produced, error listed in Warnings pane, must-have dropped.
- `sample` errors: `not_granted` hides the button; `rate_limited` shows a
  retry-later notice; never loops.
- `db` write failure → toast, build stays on screen.

## 7. Quality gates — definition of "good build"

1. Exactly 330 points; shrine math equals the builder's.
2. All requirements/prerequisites satisfied at the phase taken; Warder ≤ 4;
   no excluded attunement.
3. Real deepwoken.co builder loads it with zero errors/warnings.
4. Meta score ≥ 70 for every archetype's default request.
5. Healer regression test passes.

## 8. Done

Page published and link handed over; all tests green; every archetype
verified in the real builder; `README.md` documents re-running the pipeline
and republishing; memory notes updated.
