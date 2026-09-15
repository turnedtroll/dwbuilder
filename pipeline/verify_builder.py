"""
verify_builder.py - load exported build drafts into the live deepwoken.co
builder (via Playwright, mirroring pipeline/dwfill.py's injection route) and
report back power / points spent / issue count for each one.

Usage:
    python verify_builder.py <file-or-dir> [--headless] [--show] [--keep]
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


def set_draft_and_load(page, ctx, env, deadline_s=60):
    """Write the draft into localStorage and (re)load the builder, mirroring
    dwfill.main's launch sequence, then poll the pinia store until it
    settles (or the deadline passes)."""
    draft = {"version": 1, "build": env["build"], "phase": env.get("phase", "pre"), "baseline": ""}
    draft_json = json.dumps(draft)

    # localStorage is per-origin: a fresh page (about:blank / chrome://new-tab-page)
    # is not on deepwoken.co yet, so setting the key now would land on the wrong
    # origin. Prime the origin with a first navigation whenever we're not already
    # there (R3's "writing before goto is equivalent" holds once we're on-origin).
    if not page.url.startswith(dwfill.BUILDER_URL.rsplit("/", 1)[0]):
        page.goto(dwfill.BUILDER_URL, wait_until="domcontentloaded", timeout=60000)

    # Writing localStorage before goto is equivalent to dwfill's init-script
    # approach (R3): the builder reads it on the next navigation.
    page.evaluate(
        """(v) => { try { localStorage.setItem(v[0], v[1]); } catch (e) {} }""",
        [dwfill.DRAFT_KEY, draft_json],
    )
    resp = page.goto(dwfill.BUILDER_URL, wait_until="domcontentloaded", timeout=60000)
    status = resp.status if resp else None

    build_name = env["build"]["stats"]["buildName"]
    state = None
    deadline = time.time() + deadline_s
    while time.time() < deadline:
        try:
            state = page.evaluate(dwfill.JS_GET_STORE)
        except Exception:
            state = None
        if state and not state.get("loading"):
            cur = state.get("current") or {}
            if cur.get("stats", {}).get("buildName") == build_name:
                break
        time.sleep(0.5)
    return state, status


def verify_one(page, ctx, build_id, env, headless_fallback_allowed, args):
    state, status = set_draft_and_load(page, ctx, env)

    headless_fallback = False
    settled = state and not state.get("loading") and \
        (state.get("current") or {}).get("stats", {}).get("buildName") == env["build"]["stats"]["buildName"]

    if (not settled) and headless_fallback_allowed and (status is None or status >= 400 or not settled):
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
        dom = page.evaluate(JS_DOM_SNAPSHOT_WITH_ISSUES)
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
    issue_count = dom.get("issueCount", 0)

    result = {
        "id": build_id,
        "ok": issue_count == 0 and point_spent == 330 and power == 20,
        "power": power,
        "pointSpent": point_spent,
        "issueCount": issue_count,
        "issues": dom.get("issues", []),
        "talentsAccepted": len(cur.get("talents", [])),
        "talentsSent": len(env["build"].get("talents", [])),
        "shrineMode": state.get("shrineMode"),
        "phase": env.get("phase"),
    }
    if headless_fallback:
        result["headlessFallback"] = True

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", help="a single exported build JSON file, or a directory of them")
    ap.add_argument("--headless", action="store_true", default=True, help="run headless (default)")
    ap.add_argument("--show", action="store_true", help="watch in a visible window (overrides --headless)")
    ap.add_argument("--keep", action="store_true", help="keep the browser open after the run")
    ap.add_argument("--screenshot-dir", default=None)
    ap.add_argument("--profile", default=DEFAULT_PROFILE_VERIFY)
    args = ap.parse_args()
    headless = args.headless and not args.show

    os.makedirs(args.profile, exist_ok=True)
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
            log(f"[verify] ERROR: could not launch Chrome/Playwright: {e}")
            print(json.dumps({"id": None, "ok": False, "error": f"BLOCKED: {e}"}))
            sys.exit(1)

        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.on("dialog", lambda d: d.accept())

        for build_id, env in builds:
            log(f"[verify] {build_id}: loading...")
            try:
                result = verify_one(page, ctx, build_id, env, headless_fallback_allowed=headless, args=args)
            except Exception as e:
                log(f"[verify] {build_id}: exception during verify: {e}")
                result = {
                    "id": build_id, "ok": False, "power": None, "pointSpent": None,
                    "issueCount": None, "issues": [f"exception: {e}"],
                    "talentsAccepted": None, "talentsSent": len(env["build"].get("talents", [])),
                    "shrineMode": None, "phase": env.get("phase"),
                }

            if result is None:
                # headless attempt did not settle; retry this one build with a visible context
                try:
                    ctx.close()
                except Exception:
                    pass
                ctx = launch_context(p, args.profile, False)
                page = ctx.pages[0] if ctx.pages else ctx.new_page()
                page.on("dialog", lambda d: d.accept())
                try:
                    result = verify_one(page, ctx, build_id, env, headless_fallback_allowed=False, args=args)
                    if result:
                        result["headlessFallback"] = True
                except Exception as e:
                    log(f"[verify] {build_id}: exception during headless-fallback verify: {e}")
                    result = {
                        "id": build_id, "ok": False, "power": None, "pointSpent": None,
                        "issueCount": None, "issues": [f"exception: {e}"],
                        "talentsAccepted": None, "talentsSent": len(env["build"].get("talents", [])),
                        "shrineMode": None, "phase": env.get("phase"), "headlessFallback": True,
                    }
                # go back to headless for subsequent builds
                if headless:
                    try:
                        ctx.close()
                    except Exception:
                        pass
                    ctx = launch_context(p, args.profile, True)
                    page = ctx.pages[0] if ctx.pages else ctx.new_page()
                    page.on("dialog", lambda d: d.accept())

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
