"""
serve_local.py - mirror the published layout into out/site/ and serve it.

page/app.js imports ./engine/index.js, ./data/game.js and ./data/archetypes.js
relative to itself (the layout the Artifact publish uses), so the page cannot
be opened from page/ directly. This copies page/*, engine/*.js and data/*.js
into out/site/ and serves that on http://localhost:8080/.

Usage: python pipeline/serve_local.py [--port 8080] [--no-serve]
"""
import argparse, glob, http.server, os, shutil, functools

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "out", "site")


def build_site():
    shutil.rmtree(SITE, ignore_errors=True)
    shutil.copytree(os.path.join(ROOT, "page"), SITE)
    os.makedirs(os.path.join(SITE, "engine")), os.makedirs(os.path.join(SITE, "data"))
    for f in glob.glob(os.path.join(ROOT, "engine", "*.js")):
        shutil.copy(f, os.path.join(SITE, "engine"))
    for name in ("game.js", "archetypes.js"):
        shutil.copy(os.path.join(ROOT, "data", name), os.path.join(SITE, "data"))
    return SITE


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--no-serve", action="store_true", help="only build out/site/")
    args = ap.parse_args()
    print(f"site built at {build_site()}")
    if not args.no_serve:
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=SITE)
        print(f"serving http://localhost:{args.port}/")
        http.server.ThreadingHTTPServer(("", args.port), handler).serve_forever()
