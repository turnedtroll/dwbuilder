# Deepwoken Forge (dwbuilder)

Generates Deepwoken builds from what players actually publish. It mines 880 published
deepwoken.co builds into 115 archetypes (role × weapon type × attunements × oath), then
assembles a full 330-point build for a request — stats, Shrine of Order plan, talents,
mantras with gems, gear, oath/origin/race — validates it with the same rules the live
builder applies, scores it against the archetype, and hands you a build code you paste
into deepwoken.co with one bookmark click.

Every one of the 115 default builds loads in the live builder at Power 20, 330 points,
with zero build issues (see *Quality gates*).

## Layout

| Path | What |
|---|---|
| `page/` | The UI (`index.html`, `app.js`, `styles.css`). Published as a claude.ai Artifact. |
| `engine/` | Pure ES modules shared by the page and the tests: `stats`, `shrine` (Shrine of Order port), `convert` (feed build ⇄ core ⇄ builder draft), `validate`, `score`, `assemble`. |
| `data/game.js(on)` | Slimmed game data (talents, mantras, weapons, outfits, oaths, races …) from `pipeline/slimdata.py`. |
| `data/archetypes.js(on)` | Mined archetypes from `pipeline/mine.py`. |
| `data/raw/` (git-ignored) | `feed_top.json`, `feed_popular.json` (published builds), `gamedata.json` (the builder's game data). |
| `pipeline/` | Data refresh and verification scripts (below). |
| `tests/` | `node --test` suites for the engine; `pipeline/test_*.py` for the Python pipeline. |

## Run it

```bash
npm test            # engine: 45 tests
npm run pytest      # pipeline: 11 tests
python pipeline/serve_local.py   # http://localhost:8080/ — mirrors the published layout into out/site/
```

The page needs no build step and no dependencies. Locally the *Refine with AI* and
*Library* buttons stay hidden — they use the claude.ai Artifact `sample` and `db`
capabilities, which only exist on the published page.

## Using a build in deepwoken.co

1. Drag the **Import bookmarklet** link from the page to your bookmarks bar (once).
2. Click **Copy build code** on the build you want.
3. Open <https://deepwoken.co/builder>, click the bookmark, paste the code.

The builder reloads with the build in place — stats, talents, mantras, gear and shrine
phases. If the bookmarklet says it did not recognise the code, copy the code from the
text box at the bottom of the page instead.

## Refreshing the data

Playwright for Python is required (`pip install playwright && playwright install chromium`).

```bash
# 1. published builds (each run writes feed_<sort>.json into the current directory)
cd data/raw && python ../../pipeline/feedscrape.py top 8 && python ../../pipeline/feedscrape.py popular 20 && cd ../..
# 2. the builder's game data
python pipeline/dump_gamedata.py                 # -> data/raw/gamedata.json
# 3. regenerate data/game.* and data/archetypes.*
npm run pipeline
# 4. gates
npm test && npm run pytest
node pipeline/export_builds.mjs out/builds && python pipeline/verify_builder.py out/builds > out/verify.jsonl
# 5. republish the page (data/*.js travel with it)
```

`verify_builder.py` loads every exported build into the real builder (headless Chrome)
and prints one JSON line per build; the run is clean when every line has `"ok": true`.
Issue strings under `builderBugs` are defects in the builder itself (see the list at the
top of the script) and do not count.

## Quality gates

- **Engine tests** (`npm test`): points/power math, Shrine of Order against real builds,
  validator rules reproduced from the live builder (per-phase prerequisite chains,
  mandatory `or` alternatives, weapon-type requirements, oath requirements,
  attunement-tier talents), the top-30 published builds validating, and every
  archetype's default build being valid with meta score ≥ 60 (≥ 70 for ≥ 97%).
- **Pipeline tests** (`npm run pytest`): archetype shape, medoid coherence (the
  archetype's default oath is the one its medoid build holds), name resolution.
- **Live sweep** (`verify_builder.py`): 115/115 builds at Power 20 / 330 points / 0 issues.

## How a build is made

1. `selectArchetype` scores the 115 archetypes against the request (role, attunements,
   weapon type, oath, origin, race).
2. `planStats` fits the archetype medoid's stat block to 330 points around the request's
   must-have requirements, planning the pre-shrine block and Shrine of Order at the
   archetype's typical power.
3. `pickTalents` / `pickMantras` take the archetype's most frequent choices that are
   obtainable under the builder's rules; `pickGear` fills oath, origin, race, weapon,
   outfit, equipment, boons and flaws from the archetype.
4. `validate` re-checks everything; `scoreBuild` compares the result to the archetype
   (stat spread, core talents, core mantras); `buildGuide` writes the leveling order.

Rulings and the full task ledger live in `.superpowers/sdd/2026-09-13-dwbuilder/`
(local only); the design spec is `docs/superpowers/specs/2026-09-13-dwbuilder-design.md`.
