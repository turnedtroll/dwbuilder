"""
verify_builder.py - load exported build drafts into the live deepwoken.co
builder (via Playwright, mirroring pipeline/dwfill.py's injection route) and
report back power / points spent / issue count for each one.

Usage:
    python verify_builder.py <file-or-dir> [--show] [--keep]
                              [--screenshot-dir DIR] [--profile DIR]

Prints one JSON line per build to stdout (nothing else goes to stdout, so
`> out/verify.jsonl` stays clean); diagnostics go to stderr. Exits 1 if any
build's "ok" is false.
"""
import argparse
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dwfill  # noqa: E402  (reuse constants + JS snippets, never modify it)

DEFAULT_PROFILE_VERIFY = os.path.join(HERE, "chrome-profile-verify")

# dwfill's DOM snapshot doesn't include issue text; extend it here so we can
# report the builder's own complaint strings. The brief's suggested selector
# ([class*="issue"], [class*="warning"], [class*="error"]) does not match the
# live site: as of this build, "N build issues" renders as a bare
# <details><summary>N build issues</summary><ul><li>...</li></ul></details>
# with no distinguishing class (confirmed by inspecting the live DOM). Find
# that <details> by its <summary> text instead, and fall back to the brief's
# class-based selector in case the markup changes again.
_ISSUES_LINE = (
    "  const issueDetails = [...document.querySelectorAll('details')]\n"
    "    .find(d => { const s = d.querySelector('summary'); "
    "return s && /\\d+ build issues?/.test(s.textContent); });\n"
    "  out.issues = issueDetails\n"
    "    ? [...issueDetails.querySelectorAll('li')].map(li => txt(li.textContent))"
    ".filter(t => t && t.length < 300)\n"
    "    : [...document.querySelectorAll('[class*=\"issue\"], [class*=\"warning\"], "
    "[class*=\"error\"]')].map(e => txt(e.textContent)).filter(t => t && t.length < 300);\n"
    "  return out;\n}\n"
)
_ANCHOR = "  return out;\n}\n"
assert dwfill.JS_DOM_SNAPSHOT.endswith(_ANCHOR)
JS_DOM_SNAPSHOT_WITH_ISSUES = dwfill.JS_DOM_SNAPSHOT[: -len(_ANCHOR)] + _ISSUES_LINE


# Issue strings the live builder emits because of a defect in the builder itself, verified against
# its bundle. They are reported (builderBugs) but do not count against `ok`.
#  - True Ether Bullets: its weaponType is the comma list "Pistol, Rifle, Greatcannon"; the builder's
#    evaluator checks `weaponTypeSet.has(talent.weaponType)` against the whole string without
#    splitting it, so the talent is flagged for every build, including a Pistol wielder
#    (dps-light-saltchemist, Repeater). The game accepts any of the three.
KNOWN_BUILDER_BUGS = (
    "True Ether Bullets: Requires Weapon Type: Pistol, Rifle, Greatcannon",
)


def log(*a, **kw):
    print(*a, file=sys.stderr, **kw)
    sys.stderr.flush()


def load_builds(path):
    """Yield (id, envelope_dict) pairs for a single file or a directory of them."""
    if os.path.isdir(path):
        names = sorted(f for f in os.listdir(path) if f.endswith(".json"))
        paths = [os.path.join(path, n) for n in names]
    else:
        paths = [path]
    for p in paths:
        with open(p, encoding="utf-8") as f:
            env = json.load(f)
        build_id = env.get("archetype_id") or os.path.splitext(os.path.basename(p))[0]
        yield build_id, env


def accept_dialog(d):
    """Accept the builder's beforeunload prompt so navigation proceeds. The
    dialog can already be gone by the time the callback runs (the navigation
    that raised it was aborted); Playwright then throws "No dialog is showing"
    from inside the event loop, which must not surface as an unhandled
    callback exception."""
    try:
        d.accept()
    except Exception:
        pass


def goto_builder(page):
    """page.goto with one retry: a beforeunload dialog racing the navigation
    aborts it with net::ERR_ABORTED even though the page is fine."""
    try:
        return page.goto(dwfill.BUILDER_URL, wait_until="domcontentloaded", timeout=60000)
    except Exception as e:
        if "ERR_ABORTED" not in str(e):
            raise
        time.sleep(1.0)
        return page.goto(dwfill.BUILDER_URL, wait_until="domcontentloaded", timeout=60000)


# Game data (talents etc.) is fetched by the app after mount; the build store's own `loading`
# flag only covers /builds/:id fetches, so wait on the gameData store explicitly.
JS_GAME_READY = """
() => {
  const root = document.querySelector('#__nuxt');
  const pinia = root && root.__vue_app__ && root.__vue_app__.config.globalProperties.$pinia;
  if (!pinia) return false;
  const gd = pinia._s.get('gameData'), b = pinia._s.get('build');
  return !!(gd && b && !gd.loading && gd.talents && gd.talents.length > 0);
}
"""


def fingerprint(build):
    """What we compare to decide the store really holds OUR build. buildName alone is not
    enough: it is the archetype label, which duplicate archetypes (foo, foo-2) share, and a
    stale draft with the same label can be sitting in the Chrome profile from an earlier run."""
    return {
        "name": build["stats"]["buildName"],
        "pre": build.get("preShrine", {}).get("base", {}),
        "final": build.get("attributes", {}).get("base", {}),
        "talents": sorted(build.get("talents", [])),
    }


def store_matches(cur, env):
    want = fingerprint(env["build"])
    have = fingerprint(cur)
    # The builder appends origin/race-granted talents on load, so ours must be a subset.
    return (have["name"] == want["name"] and have["pre"] == want["pre"] and have["final"] == want["final"]
            and set(want["talents"]) <= set(have["talents"]))


def set_draft_and_load(page, ctx, env, deadline_s=60):
    """Load the draft straight into the pinia store (store.restoreDraft, the same route
    dwfill.main takes) and poll until the store holds it.

    Why not localStorage + reload: the builder registers window 'pagehide' -> flush, which
    writes the CURRENT build back into the very same `_dwb.draft.v1.new` key during the
    navigation, clobbering whatever we just wrote there. The new page then restores the
    previous build and never "settles" (that was the source of nearly every headless->visible
    fallback), or - if a stale draft with the same label exists in the profile - settles on the
    WRONG build and reports its issues as ours."""
    if not page.url.startswith(dwfill.BUILDER_URL.rsplit("/", 1)[0]):
        goto_builder(page)
    status = 200
    deadline = time.time() + deadline_s
    while time.time() < deadline:
        try:
            if page.evaluate(JS_GAME_READY):
                break
        except Exception:
            pass
        time.sleep(0.5)
    else:
        return None, status

    page.evaluate(dwfill.JS_RESTORE_DRAFT, [env["build"], env.get("phase", "pre")])

    state = None
    while time.time() < deadline:
        try:
            state = page.evaluate(dwfill.JS_GET_STORE)
        except Exception:
            state = None
        if state and not state.get("loading") and store_matches(state.get("current") or {}, env):
            break
        time.sleep(0.5)
    return state, status


def stable_dom_snapshot(page, tries=8, gap_s=0.5):
    """The issue list is a computed that settles after the load-time watchers (granted
    talents, derived points) run; read it until two consecutive reads agree."""
    last = None
    for _ in range(tries):
        dom = page.evaluate(JS_DOM_SNAPSHOT_WITH_ISSUES)
        cur = (dom.get("issueCount"), dom.get("issues"))
        if cur == last:
            return dom
        last = cur
        time.sleep(gap_s)
    return dom


def verify_one(page, ctx, build_id, env, headless_fallback_allowed, args):
    state, status = set_draft_and_load(page, ctx, env)

    settled = bool(state) and not state.get("loading") and store_matches(state.get("current") or {}, env)

    if (not settled) and headless_fallback_allowed:
        log(f"[verify] {build_id}: headless attempt did not settle (HTTP {status}); retrying headless=False")
        return None  # signal caller to redo with a visible context

    if not settled:
        return {
            "id": build_id, "ok": False, "power": None, "pointSpent": None,
            "issueCount": None, "issues": ["timeout: store did not load"],
            "talentsAccepted": None, "talentsSent": len(env["build"].get("talents", [])),
            "shrineMode": None, "phase": env.get("phase"),
        }

    time.sleep(1.5)  # let watchers settle (auto talents, derived points) - mirrors dwfill.main
    state = page.evaluate(dwfill.JS_GET_STORE)
    cur = state["current"]

    try:
        dom = stable_dom_snapshot(page)
    except Exception as e:
        log(f"[verify] {build_id}: DOM snapshot failed: {e}")
        dom = {"issueCount": 0, "issues": [], "power": None, "pointsLeft": None}

    power = cur.get("stats", {}).get("power")
    if power is None:
        power = int(dom["power"]) if dom.get("power") not in (None, "") else None
    point_spent = cur.get("stats", {}).get("pointSpent")
    if point_spent is None:
        pl = dom.get("pointsLeft")
        point_spent = 330 - int(pl) if pl not in (None, "") else None
    issues = dom.get("issues", [])
    builder_bugs = [i for i in issues if any(i.startswith(k) for k in KNOWN_BUILDER_BUGS)]
    real_issues = [i for i in issues if i not in builder_bugs]

    result = {
        "id": build_id,
        "ok": not real_issues and point_spent == 330 and power == 20,
        "power": power,
        "pointSpent": point_spent,
        "issueCount": len(real_issues),
        "issues": real_issues,
        "builderBugs": builder_bugs,
        "talentsAccepted": len(cur.get("talents", [])),
        "talentsSent": len(env["build"].get("talents", [])),
        "shrineMode": state.get("shrineMode"),
        "phase": env.get("phase"),
    }

    if args.screenshot_dir:
        try:
            os.makedirs(args.screenshot_dir, exist_ok=True)
            import base64
            cdp = ctx.new_cdp_session(page)
            data = cdp.send("Page.captureScreenshot", {"format": "png"})
            with open(os.path.join(args.screenshot_dir, f"{build_id}.png"), "wb") as f:
                f.write(base64.b64decode(data["data"]))
        except Exception as e:
            log(f"[verify] {build_id}: screenshot failed: {e}")

    return result


def launch_context(p, profile, headless):
    launch_kwargs = dict(
        user_data_dir=profile,
        headless=headless,
        args=["--disable-blink-features=AutomationControlled", "--start-maximized"],
        ignore_default_args=["--enable-automation"],
        viewport=None,
    )
    if os.path.exists(dwfill.CHROME_EXE):
        launch_kwargs["executable_path"] = dwfill.CHROME_EXE
    else:
        launch_kwargs["channel"] = "chrome"
    return p.chromium.launch_persistent_context(**launch_kwargs)


def safe_launch(p, profile, headless, build_id, label):
    """launch_context, but never raise: log and return None on failure so a
    relaunch attempt can't kill the whole sweep."""
    try:
        return launch_context(p, profile, headless)
    except Exception as e:
        log(f"[verify] {build_id}: {label} relaunch failed: {e}")
        return None


def ctx_alive(ctx):
    try:
        _ = ctx.pages
        return True
    except Exception:
        return False


def failure_line(build_id, env, issue, headless_fallback=False):
    line = {
        "id": build_id, "ok": False, "power": None, "pointSpent": None,
        "issueCount": None, "issues": [issue],
        "talentsAccepted": None, "talentsSent": len(env["build"].get("talents", [])),
        "shrineMode": None, "phase": env.get("phase"),
    }
    if headless_fallback:
        line["headlessFallback"] = True
    return line


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", help="a single exported build JSON file, or a directory of them")
    ap.add_argument("--show", action="store_true", help="watch in a visible window (default: headless)")
    ap.add_argument("--keep", action="store_true", help="keep the browser open after the run")
    ap.add_argument("--screenshot-dir", default=None)
    ap.add_argument("--profile", default=DEFAULT_PROFILE_VERIFY)
    args = ap.parse_args()
    headless = not args.show

    os.makedirs(args.profile, exist_ok=True)
    # Chrome enforces one live process per user-data-dir (a second launch on a locked
    # profile silently forwards to the existing instance and exits, which Playwright
    # sees as "Target page, context or browser has been closed"). The visible-mode
    # fallback below launches its replacement context *before* closing the current
    # one (intentionally, so a relaunch failure doesn't strand the whole sweep), so
    # it needs its own profile dir to avoid colliding with the still-open original.
    fallback_profile = args.profile.rstrip("/\\") + "-fallback"
    os.makedirs(fallback_profile, exist_ok=True)
    builds = list(load_builds(args.path))
    log(f"[verify] loaded {len(builds)} build(s) from {args.path}; headless={headless}")

    results = []
    with sync_playwright() as p:
        try:
            ctx = launch_context(p, args.profile, headless)
        except Exception as e:
            if "existing browser session" in str(e) or "already in use" in str(e):
                log(f"[verify] ERROR: the Chrome profile {args.profile} is already open. "
                    "Close that window first, or pass --profile <other dir>.")
                sys.exit(2)
            # Preferred fix for a total launch failure: no stdout line at all (a
            # partial-schema line would break the one-JSON-line-per-build
            # contract), just a BLOCKED diagnostic on stderr and a non-zero exit.
            log(f"[verify] BLOCKED: could not launch Chrome/Playwright: {e}")
            sys.exit(1)

        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.on("dialog", accept_dialog)

        for build_id, env in builds:
            log(f"[verify] {build_id}: loading...")
            try:
                result = verify_one(page, ctx, build_id, env, headless_fallback_allowed=headless, args=args)
            except Exception as e:
                log(f"[verify] {build_id}: exception during verify: {e}")
                result = failure_line(build_id, env, f"exception: {e}")

            if result is None:
                # Headless attempt did not settle; retry this one build with a
                # visible context. Launch the replacement BEFORE closing the
                # current one, so a relaunch failure leaves a still-usable
                # context in hand instead of stranding the whole sweep.
                visible_ctx = safe_launch(p, fallback_profile, False, build_id, "visible-mode")
                if visible_ctx is not None:
                    try:
                        ctx.close()
                    except Exception:
                        pass
                    ctx = visible_ctx
                    page = ctx.pages[0] if ctx.pages else ctx.new_page()
                    page.on("dialog", accept_dialog)
                    try:
                        result = verify_one(page, ctx, build_id, env, headless_fallback_allowed=False, args=args)
                        if result:
                            result["headlessFallback"] = True
                    except Exception as e:
                        log(f"[verify] {build_id}: exception during headless-fallback verify: {e}")
                        result = failure_line(build_id, env, f"exception: {e}", headless_fallback=True)

                    # Try to go back to headless for subsequent builds; if that
                    # relaunch fails, keep using the working visible context
                    # rather than losing the rest of the sweep.
                    if headless:
                        headless_ctx = safe_launch(p, args.profile, True, build_id, "headless-restore")
                        if headless_ctx is not None:
                            try:
                                ctx.close()
                            except Exception:
                                pass
                            ctx = headless_ctx
                            page = ctx.pages[0] if ctx.pages else ctx.new_page()
                            page.on("dialog", accept_dialog)
                        else:
                            log(f"[verify] {build_id}: continuing remaining builds in visible "
                                "mode (headless-restore relaunch failed)")
                            headless = False
                else:
                    # The visible-mode relaunch failed. We never closed the old
                    # (headless) context, so it may still be alive -- reuse it
                    # for the rest of the sweep instead of aborting outright.
                    result = failure_line(
                        build_id, env, "relaunch failed: could not open a visible-mode context",
                        headless_fallback=True,
                    )
                    if not ctx_alive(ctx):
                        print(json.dumps(result))
                        sys.stdout.flush()
                        results.append(result)
                        log("[verify] BLOCKED: no browser context is available after a failed "
                            "relaunch; stopping the sweep.")
                        sys.exit(1)

            print(json.dumps(result))
            sys.stdout.flush()
            results.append(result)

        if not args.keep:
            try:
                ctx.close()
            except Exception:
                pass

    sys.exit(1 if any(not r.get("ok") for r in results) else 0)


if __name__ == "__main__":
    main()
