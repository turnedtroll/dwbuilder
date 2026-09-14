"""
dwfill.py - open https://deepwoken.co/builder in a visible Chrome window and
fill in a complete Deepwoken build from a JSON spec, then leave the window open
so the user can sign in with Discord and click Save themselves.

Usage:
    python dwfill.py spec.json [--screenshot out.png] [--no-wait] [--profile DIR]

Injection route:
    The builder (Nuxt 3 + pinia, store id "build") auto-restores a local draft
    from localStorage["_dwb.draft.v1.new"] when opened without ?id=.  The draft
    is  {version:1, build:<full build object>, phase:"pre"|"post", baseline:""}
    and is validated structurally against the builder's default build object,
    then applied with store.restoreDraft(build, phase).  We write that key via
    an init script before the page's JS runs, load /builder, and then verify by
    reading the pinia store directly:
        document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$pinia
    If the draft was not picked up we fall back to calling
    $pinia._s.get('build').restoreDraft(build, phase) from page JS.
"""
import argparse
import copy
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PROFILE = os.path.join(HERE, "chrome-profile")
CHROME_EXE = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
BUILDER_URL = "https://deepwoken.co/builder"
DRAFT_KEY = "_dwb.draft.v1.new"

BASE_STATS = ["Strength", "Fortitude", "Agility", "Intelligence", "Willpower", "Charisma"]
WEAPON_STATS = ["Heavy Wep.", "Medium Wep.", "Light Wep."]
ATTUNEMENTS = ["Flamecharm", "Frostdraw", "Thundercall", "Galebreathe", "Shadowcast", "Ironsing", "Bloodrend"]
TRAITS = ["Vitality", "Erudition", "Proficiency", "Songchant"]

STAT_ALIASES = {
    "str": "Strength", "strength": "Strength",
    "ftd": "Fortitude", "frt": "Fortitude", "fort": "Fortitude", "fortitude": "Fortitude",
    "agl": "Agility", "agi": "Agility", "agility": "Agility",
    "int": "Intelligence", "intel": "Intelligence", "intelligence": "Intelligence",
    "wil": "Willpower", "wll": "Willpower", "will": "Willpower", "willpower": "Willpower",
    "cha": "Charisma", "chr": "Charisma", "charisma": "Charisma",
    "heavy": "Heavy Wep.", "hvy": "Heavy Wep.", "heavy wep": "Heavy Wep.", "heavy wep.": "Heavy Wep.",
    "heavy weapon": "Heavy Wep.", "heavy weapons": "Heavy Wep.",
    "medium": "Medium Wep.", "med": "Medium Wep.", "medium wep": "Medium Wep.", "medium wep.": "Medium Wep.",
    "medium weapon": "Medium Wep.", "medium weapons": "Medium Wep.",
    "light": "Light Wep.", "lht": "Light Wep.", "light wep": "Light Wep.", "light wep.": "Light Wep.",
    "light weapon": "Light Wep.", "light weapons": "Light Wep.",
    "flame": "Flamecharm", "flamecharm": "Flamecharm", "fire": "Flamecharm",
    "frost": "Frostdraw", "frostdraw": "Frostdraw", "ice": "Frostdraw",
    "thunder": "Thundercall", "thundercall": "Thundercall", "lightning": "Thundercall",
    "gale": "Galebreathe", "galebreathe": "Galebreathe", "wind": "Galebreathe",
    "shadow": "Shadowcast", "shadowcast": "Shadowcast",
    "iron": "Ironsing", "ironsing": "Ironsing", "metal": "Ironsing",
    "blood": "Bloodrend", "bloodrend": "Bloodrend",
}


# --------------------------------------------------------------------------
# Default build object (mirrors the builder's Cr() factory exactly).  Every key
# here must exist with the same JS typeof in the draft or the builder rejects it.
# --------------------------------------------------------------------------
def zero_attrs():
    return {
        "base": {k: 0 for k in BASE_STATS},
        "weapon": {k: 0 for k in WEAPON_STATS},
        "attunement": {k: 0 for k in ATTUNEMENTS},
    }


def default_build():
    return {
        "version": 3,
        "createdAt": "",
        "updatedAt": "",
        "author": {"id": "", "verifiedId": "", "name": ""},
        "stats": {
            "buildName": "",
            "buildDescription": "",
            "buildAuthor": "",
            "power": 0,
            "points": 330,
            "pointSpent": 0,
            "pointsUntilNextPower": 0,
            "traits": {k: 0 for k in TRAITS},
            "traitsPoints": 12,
            "meta": {"Race": "None", "Oath": "None", "Murmur": "None",
                     "Origin": "Castaway", "Bell": "None", "Outfit": "None"},
            "boon1": "None", "boon2": "None",
            "flaw1": "None", "flaw2": "None", "flaw3": "None",
        },
        "attributes": zero_attrs(),
        "content": {"notes": "", "mantraModifications": {}},
        "meta": {
            "visibility": "public", "private": False, "tags": [],
            "votes": {"up": 0, "down": 0, "voters": {}},
            "views": 0, "saved": 0,
            "comments": {"count": 0, "lastActivity": None},
        },
        "talents": [],
        "weapons": "",
        "enchant": "",
        "motif": "",
        "weaponStars": {"count": 0, "mod": ""},
        "multifaceted": False,
        "mantras": [],
        "preShrine": zero_attrs(),
        "postShrine": zero_attrs(),
        "preMastery": {},
        "postMastery": {},
        "favoritedTalents": [],
        "equipment": {"Head": None, "Arms": None, "Legs": None, "Torso": None,
                      "Face": None, "Earrings": None, "Rings": [None, None, None, None]},
    }


# --------------------------------------------------------------------------
# Spec -> build conversion
# --------------------------------------------------------------------------
def canon_stat(name):
    n = str(name).strip()
    if n in BASE_STATS or n in WEAPON_STATS or n in ATTUNEMENTS:
        return n
    key = n.lower().replace("_", " ")
    if key in STAT_ALIASES:
        return STAT_ALIASES[key]
    raise ValueError(f"Unknown stat name: {name!r}")


def parse_stats(block):
    """Accept flat {statName: value} or nested {base:{}, weapon:{}, attunement:{}}."""
    out = zero_attrs()
    if not block:
        return out
    if isinstance(block, dict) and set(block.keys()) <= {"base", "weapon", "attunement"} and any(
            isinstance(v, dict) for v in block.values()):
        flat = {}
        for grp in ("base", "weapon", "attunement"):
            flat.update(block.get(grp) or {})
    else:
        flat = block
    for k, v in flat.items():
        c = canon_stat(k)
        v = int(v)
        if c in BASE_STATS:
            out["base"][c] = v
        elif c in WEAPON_STATS:
            out["weapon"][c] = v
        else:
            out["attunement"][c] = v
    return out


def stats_total(attrs):
    return sum(attrs["base"].values()) + sum(attrs["weapon"].values()) + sum(attrs["attunement"].values())


def has_points(attrs):
    return stats_total(attrs) > 0


def deep_merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            deep_merge(dst[k], v)
        else:
            dst[k] = copy.deepcopy(v)
    return dst


def spec_to_build(spec):
    """Return (build, phase) in the builder's native store shape."""
    b = default_build()

    # Raw passthrough: spec may be a full store-shaped build already.
    if "build" in spec and isinstance(spec["build"], dict):
        deep_merge(b, spec["build"])
        phase = spec.get("phase") or ("post" if has_points(b["postShrine"]) else "pre")
        return b, phase

    s = b["stats"]
    s["buildName"] = spec.get("name", spec.get("buildName", ""))
    s["buildDescription"] = spec.get("description", spec.get("buildDescription", ""))
    b["content"]["notes"] = spec.get("notes", "")

    meta = s["meta"]
    for key, spec_key in (("Origin", "origin"), ("Oath", "oath"), ("Race", "race"),
                          ("Murmur", "murmur"), ("Bell", "bell"), ("Outfit", "outfit")):
        val = spec.get(spec_key)
        if val is None:
            val = (spec.get("meta") or {}).get(key)
        if val not in (None, ""):
            meta[key] = str(val)

    b["weapons"] = str(spec.get("weapon", spec.get("weapons", "")) or "")
    b["enchant"] = str(spec.get("enchant", "") or "")
    b["motif"] = str(spec.get("motif", "") or "")
    b["multifaceted"] = bool(spec.get("multifaceted", False))
    if isinstance(spec.get("weaponStars"), dict):
        deep_merge(b["weaponStars"], spec["weaponStars"])

    boons = list(spec.get("boons", []))
    flaws = list(spec.get("flaws", []))
    for i in range(2):
        s[f"boon{i+1}"] = boons[i] if i < len(boons) and boons[i] else "None"
    for i in range(3):
        s[f"flaw{i+1}"] = flaws[i] if i < len(flaws) and flaws[i] else "None"

    for k, v in (spec.get("traits") or {}).items():
        kk = k.strip().capitalize()
        if kk not in TRAITS:
            raise ValueError(f"Unknown trait: {k}")
        s["traits"][kk] = int(v)

    shrine = bool(spec.get("shrineOfOrder", spec.get("shrine", False)))
    pre_block = spec.get("preShrine", spec.get("stats"))
    post_block = spec.get("postShrine")
    pre = parse_stats(pre_block)
    post = parse_stats(post_block) if post_block else None

    if shrine:
        b["preShrine"] = copy.deepcopy(pre)
        if post is not None:
            b["postShrine"] = copy.deepcopy(post)
            b["attributes"] = copy.deepcopy(post)
            phase = "post"
        else:
            # Shrine requested but no post-shrine numbers: load pre-shrine stats,
            # and dwfill will call the builder's own applyShrineOrder() afterwards.
            b["attributes"] = copy.deepcopy(pre)
            phase = "pre"
    else:
        b["attributes"] = copy.deepcopy(pre)
        phase = "pre"

    b["mantras"] = [str(m) for m in spec.get("mantras", [])]
    b["content"]["mantraModifications"] = {m: {} for m in b["mantras"]}
    if isinstance(spec.get("mantraModifications"), dict):
        for m, mod in spec["mantraModifications"].items():
            b["content"]["mantraModifications"][m] = dict(mod)

    talents = [str(t) for t in spec.get("talents", [])]
    # The builder represents the chosen Oath / Murmur as talents named "Oath: X" /
    # "Murmur: X"; add them automatically unless autoPathTalents is false.
    if spec.get("autoPathTalents", True):
        for key, prefix in (("Oath", "Oath: "), ("Murmur", "Murmur: ")):
            val = meta[key]
            if val and val != "None" and (prefix + val) not in talents:
                talents.append(prefix + val)
    b["talents"] = talents
    b["favoritedTalents"] = [str(t) for t in spec.get("favoritedTalents", [])]
    b["meta"]["tags"] = [str(t) for t in spec.get("tags", [])]
    if isinstance(spec.get("equipment"), dict):
        deep_merge(b["equipment"], spec["equipment"])

    return b, phase


# --------------------------------------------------------------------------
# Page-side helpers
# --------------------------------------------------------------------------
JS_GET_STORE = """
() => {
  const root = document.querySelector('#__nuxt');
  const app = root && root.__vue_app__;
  const pinia = app && app.config.globalProperties.$pinia;
  if (!pinia) return null;
  const st = pinia.state.value.build;
  if (!st) return null;
  return { current: JSON.parse(JSON.stringify(st.current)),
           shrineMode: st.shrineMode, currentId: st.currentId, loading: st.loading };
}
"""

JS_RESTORE_DRAFT = """
([build, phase]) => {
  const pinia = document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$pinia;
  const store = pinia._s.get('build');
  if (!store) throw new Error('build store not found');
  store.restoreDraft(build, phase);
  return true;
}
"""

JS_APPLY_SHRINE = """
() => {
  const pinia = document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$pinia;
  const store = pinia._s.get('build');
  return store.applyShrineOrder();
}
"""

JS_DOM_SNAPSHOT = r"""
() => {
  const txt = s => (s || '').replace(/\s+/g, ' ').trim();
  const out = { title: document.title, statusTexts: [], stats: {}, preShrine: {}, traits: {}, selects: {},
                nameInput: null, issues: [] };
  const traitNames = ["Vitality", "Erudition", "Proficiency", "Songchant"];
  // Stat / trait inputs: <input class="num-field" aria-label="Strength"> inside .stat-number / .stat-item
  for (const el of document.querySelectorAll('input.num-field[aria-label]')) {
    const label = el.getAttribute('aria-label');
    if (traitNames.includes(label)) { out.traits[label] = Number(el.value); continue; }
    out.stats[label] = Number(el.value);
    const row = el.closest('.stat-number');
    const pre = row && row.querySelector('.preshrine-stat');
    if (pre) out.preShrine[label] = Number(txt(pre.textContent));
  }
  // Race / Oath / Murmur / Origin / Bell selects: <div class="stat-item"><b class="label-full">Race</b>...<select>
  for (const item of document.querySelectorAll('.stat-item')) {
    const lab = item.querySelector('b.label-full, .label-full');
    const sel = item.querySelector('select');
    if (lab && sel) out.selects[txt(lab.textContent)] = sel.value;
  }
  out.headText = txt(document.body.innerText).slice(0, 6000);
  out.inputValues = [...document.querySelectorAll('input')].map(e => e.value).filter(v => v && v.length > 2);
  for (const el of document.querySelectorAll('[class*="status"], [class*="draft"]')) {
    const t = txt(el.textContent); if (t && t.length < 200) out.statusTexts.push(t);
  }
  const body = txt(document.body.innerText);
  const mi = body.match(/(\d+) build issues?/);
  out.issueCount = mi ? Number(mi[1]) : 0;
  out.pointsLeft = (body.match(/(-?\d+) points left/) || [])[1];
  out.power = (body.match(/Power: (\d+)/) || [])[1];
  return out;
}
"""


def flat_attrs(attrs):
    d = {}
    for grp in ("base", "weapon", "attunement"):
        d.update(attrs.get(grp, {}))
    return d


def compare(expected, actual, label, report):
    ok = True
    for k, v in expected.items():
        av = actual.get(k)
        if av != v:
            report.append(f"  MISMATCH {label}.{k}: expected {v!r}, page has {av!r}")
            ok = False
    return ok


def verify(expected_build, phase_expected, state, report):
    cur = state["current"]
    ok = True
    ok &= compare({"buildName": expected_build["stats"]["buildName"]}, cur["stats"], "stats", report)
    ok &= compare(expected_build["stats"]["meta"], cur["stats"]["meta"], "meta", report)
    ok &= compare(expected_build["stats"]["traits"], cur["stats"]["traits"], "traits", report)
    ok &= compare({k: expected_build["stats"][k] for k in ("boon1", "boon2", "flaw1", "flaw2", "flaw3")},
                  cur["stats"], "boons/flaws", report)
    ok &= compare(flat_attrs(expected_build["attributes"]), flat_attrs(cur["attributes"]), "attributes", report)
    ok &= compare(flat_attrs(expected_build["preShrine"]), flat_attrs(cur["preShrine"]), "preShrine", report)
    ok &= compare(flat_attrs(expected_build["postShrine"]), flat_attrs(cur["postShrine"]), "postShrine", report)
    ok &= compare({"weapons": expected_build["weapons"], "enchant": expected_build["enchant"]}, cur, "weapon", report)
    missing_m = [m for m in expected_build["mantras"] if m not in cur["mantras"]]
    if missing_m:
        report.append(f"  MISMATCH mantras missing on page: {missing_m}")
        ok = False
    missing_t = [t for t in expected_build["talents"] if t not in cur["talents"]]
    if missing_t:
        report.append(f"  MISMATCH talents missing on page: {missing_t}")
        ok = False
    extra_t = [t for t in cur["talents"] if t not in expected_build["talents"]]
    if extra_t:
        report.append(f"  note: builder auto-added talents (origin/race/attunement innates): {extra_t}")
    if state["shrineMode"] != phase_expected:
        report.append(f"  MISMATCH shrineMode: expected {phase_expected!r}, page has {state['shrineMode']!r}")
        ok = False
    return ok


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("--screenshot", default=None, help="save a screenshot after filling")
    ap.add_argument("--profile", default=DEFAULT_PROFILE)
    ap.add_argument("--no-wait", action="store_true", help="close the browser after filling (testing)")
    ap.add_argument("--dump-json", default=None, help="write the final store build state to this file")
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass

    with open(args.spec, encoding="utf-8") as f:
        spec = json.load(f)
    build, phase = spec_to_build(spec)
    need_apply_shrine = bool(spec.get("shrineOfOrder", spec.get("shrine", False))) and not spec.get("postShrine") \
        and "build" not in spec
    draft = {"version": 1, "build": build, "phase": phase, "baseline": ""}
    draft_json = json.dumps(draft)

    total = stats_total(build["attributes"])
    print(f"[dwfill] spec '{build['stats']['buildName']}' -> {total} points in attributes, phase={phase}, "
          f"{len(build['talents'])} talents, {len(build['mantras'])} mantras")
    if total > 330:
        print("[dwfill] WARNING: more than 330 attribute points; the builder may show it as over-invested.")

    os.makedirs(args.profile, exist_ok=True)
    init_script = f"""
      (() => {{
        try {{
          if (sessionStorage.getItem('__dwfill_applied') !== '1') {{
            localStorage.setItem({json.dumps(DRAFT_KEY)}, {json.dumps(draft_json)});
            sessionStorage.setItem('__dwfill_applied', '1');
          }}
        }} catch (e) {{}}
      }})();
    """

    with sync_playwright() as p:
        launch_kwargs = dict(
            user_data_dir=args.profile,
            headless=False,
            args=["--disable-blink-features=AutomationControlled", "--start-maximized"],
            ignore_default_args=["--enable-automation"],
            viewport=None,
        )
        if os.path.exists(CHROME_EXE):
            launch_kwargs["executable_path"] = CHROME_EXE
        else:
            launch_kwargs["channel"] = "chrome"
        try:
            ctx = p.chromium.launch_persistent_context(**launch_kwargs)
        except Exception as e:
            if "existing browser session" in str(e) or "already in use" in str(e):
                print("[dwfill] ERROR: the Chrome profile is already open (a previous dwfill window is still "
                      "running). Close that window first, or pass --profile <other dir>.")
                sys.exit(2)
            raise
        ctx.add_init_script(init_script)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.on("dialog", lambda d: d.accept())

        print(f"[dwfill] opening {BUILDER_URL}")
        resp = page.goto(BUILDER_URL, wait_until="domcontentloaded", timeout=60000)
        status = resp.status if resp else None
        print(f"[dwfill] HTTP {status}")
        if status and status >= 400:
            print("[dwfill] page returned an error status; the site may be blocking automation.")
            print(page.content()[:1500])

        # Wait for the pinia store to exist and for the builder to finish loading game data.
        state = None
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                state = page.evaluate(JS_GET_STORE)
            except Exception:
                state = None
            if state and not state["loading"]:
                cur = state["current"]
                if cur["stats"]["buildName"] == build["stats"]["buildName"] and \
                        flat_attrs(cur["attributes"]) == flat_attrs(build["attributes"]):
                    break
            time.sleep(0.5)

        if not state:
            print("[dwfill] ERROR: could not reach the pinia store on the page (site changed or blocked).")
        else:
            restored = state["current"]["stats"]["buildName"] == build["stats"]["buildName"]
            if restored:
                print("[dwfill] draft restored from localStorage by the builder itself.")
            else:
                print("[dwfill] draft not auto-restored; calling store.restoreDraft() directly.")
                page.evaluate(JS_RESTORE_DRAFT, [build, phase])
                time.sleep(1.0)

            if need_apply_shrine:
                res = page.evaluate(JS_APPLY_SHRINE)
                print(f"[dwfill] applied Shrine of Order via store.applyShrineOrder(): {res}")
                phase = "post"
                time.sleep(0.5)

            time.sleep(1.5)  # let watchers settle (auto talents, derived points)
            state = page.evaluate(JS_GET_STORE)
            if need_apply_shrine:
                # post-shrine numbers were computed by the builder; adopt them for the check
                build["preShrine"] = state["current"]["preShrine"]
                build["attributes"] = state["current"]["attributes"]
            report = []
            ok = verify(build, phase, state, report)
            cur = state["current"]
            print("[dwfill] verification " + ("PASSED" if ok else "FAILED"))
            for line in report:
                print(line)
            print(f"[dwfill] page state: name={cur['stats']['buildName']!r} power={cur['stats']['power']} "
                  f"pointsSpent={cur['stats']['pointSpent']} shrineMode={state['shrineMode']}")
            print(f"[dwfill] attributes: {flat_attrs(cur['attributes'])}")
            print(f"[dwfill] preShrine : {flat_attrs(cur['preShrine'])}")
            print(f"[dwfill] talents ({len(cur['talents'])}): {cur['talents']}")
            print(f"[dwfill] mantras ({len(cur['mantras'])}): {cur['mantras']}")
            try:
                dom = page.evaluate(JS_DOM_SNAPSHOT)
                print(f"[dwfill] DOM status: {dom['statusTexts'][:1]}")
                name_shown = build["stats"]["buildName"] in dom["headText"] or                     build["stats"]["buildName"] in dom["inputValues"]
                print(f"[dwfill] DOM: build name shown={name_shown} power={dom['power']} "
                      f"pointsLeft={dom['pointsLeft']} buildIssues={dom['issueCount']}")
                exp_sel = {k: build["stats"]["meta"][k] for k in ("Race", "Oath", "Murmur", "Origin", "Bell")}
                sel_bad = {k: (dom["selects"].get(k), v) for k, v in exp_sel.items()
                           if (dom["selects"].get(k) or "None") != v}
                print(f"[dwfill] DOM selects {dom['selects']}: "
                      + ("match the spec" if not sel_bad else f"MISMATCH (page, expected) {sel_bad}"))
                exp = flat_attrs(build["attributes"])
                dom_bad = {k: (v, exp.get(k)) for k, v in dom["stats"].items() if exp.get(k) != v}
                if dom["stats"]:
                    print(f"[dwfill] DOM stat inputs ({len(dom['stats'])} found): "
                          + ("all match the spec" if not dom_bad else f"MISMATCH (page, expected) {dom_bad}"))
                else:
                    print("[dwfill] DOM stat inputs: none found (Stats tab not visible?)")
                if dom["preShrine"]:
                    exp_pre = flat_attrs(build["preShrine"])
                    pre_bad = {k: (v, exp_pre.get(k)) for k, v in dom["preShrine"].items() if exp_pre.get(k) != v}
                    print(f"[dwfill] DOM pre-shrine column ({len(dom['preShrine'])} found): "
                          + ("all match the spec" if not pre_bad else f"MISMATCH (page, expected) {pre_bad}"))
                exp_tr = build["stats"]["traits"]
                tr_bad = {k: (v, exp_tr.get(k)) for k, v in dom["traits"].items() if exp_tr.get(k) != v}
                print(f"[dwfill] DOM traits {dom['traits']}: "
                      + ("match the spec" if not tr_bad else f"MISMATCH (page, expected) {tr_bad}"))
            except Exception as e:
                print(f"[dwfill] DOM snapshot failed: {e}")
            if args.dump_json:
                with open(args.dump_json, "w", encoding="utf-8") as f:
                    json.dump(state, f, indent=1)

        if args.screenshot:
            try:
                # Playwright's page.screenshot can hang on this site ("waiting for fonts"),
                # so grab the pixels straight from Chrome DevTools instead.
                import base64
                cdp = ctx.new_cdp_session(page)
                res = cdp.send("Page.captureScreenshot", {"format": "png"})
                with open(args.screenshot, "wb") as f:
                    f.write(base64.b64decode(res["data"]))
                cdp.detach()
                print(f"[dwfill] screenshot -> {args.screenshot}")
            except Exception as e:
                print(f"[dwfill] screenshot failed: {e}")

        if args.no_wait:
            ctx.close()
            return

        print("[dwfill] Done. The browser stays open: sign in with Discord (account menu, top right)")
        print("[dwfill] and click Save in the builder. Close the browser window to end this script.")
        try:
            while True:
                if page.is_closed() or not ctx.pages:
                    break
                time.sleep(1.0)
        except KeyboardInterrupt:
            pass
        except Exception:
            pass
        try:
            ctx.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
