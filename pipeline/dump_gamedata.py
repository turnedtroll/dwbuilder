"""
dump_gamedata.py - refresh data/raw/gamedata.json from the live deepwoken.co builder.

Opens https://deepwoken.co/builder headless, waits for the app's gameData pinia store to
finish loading (/get?type=all plus the aspects/oaths/flaws/boons/equipment tables) and writes
the store's state - the same shape pipeline/slimdata.py reads:
{data: {talents, mantras, weapons, outfits, enchants}, aspectsData, oathsData, flawsData,
 boonsData, equipmentData, loading, error}.

Usage: python pipeline/dump_gamedata.py [--out data/raw/gamedata.json]
"""
import argparse, json, os, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS_GAMEDATA = """
() => {
  const root = document.querySelector('#__nuxt');
  const pinia = root && root.__vue_app__ && root.__vue_app__.config.globalProperties.$pinia;
  const st = pinia && pinia.state.value.gameData;
  if (!st || st.loading || !st.data || !st.aspectsData || !st.oathsData) return null;
  return JSON.parse(JSON.stringify(st));
}
"""

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "raw", "gamedata.json"))
    args = ap.parse_args()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto("https://deepwoken.co/builder", wait_until="domcontentloaded", timeout=60000)
        deadline = time.time() + 90
        data = None
        while time.time() < deadline and data is None:
            try:
                data = page.evaluate(JS_GAMEDATA)
            except Exception:
                data = None
            if data is None:
                time.sleep(0.5)
        browser.close()
    if data is None:
        print("gameData store did not load within 90 s", file=sys.stderr)
        sys.exit(1)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print(f"{args.out}: {len(data['data'].get('talents', []))} talents, {len(data['data'].get('mantras', []))} mantras")
