"""
serve_local.py - mirror the published layout into out/site/ and serve it.

page/app.js imports ./engine/index.js, ./data/game.js and ./data/archetypes.js
relative to itself (the layout the Artifact publish uses), so the page cannot
be opened from page/ directly. This copies page/*, engine/*.js and data/*.js
into out/site/ and serves that on http://localhost:8080/.

Usage: python pipeline/serve_local.py [--port 8080] [--no-serve]
"""
import argparse, glob, http.server, os, re, shutil, functools, subprocess, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "out", "site")


# page/index.html is written as a document fragment (title + links + markup) so it can also be
# published as a claude.ai Artifact, which supplies the skeleton itself. A normal host needs the
# full document, so wrap it here.
SKELETON = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Meta-derived Deepwoken builds: pick a role and attunements, get a verified build with a leveling guide and one-click import into deepwoken.co.">
<meta name="color-scheme" content="dark light">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%E2%9A%94%EF%B8%8F%3C/text%3E%3C/svg%3E">
{head}
</head>
<body>
{body}
</body>
</html>
"""


def wrap_fragment(fragment):
    # everything up to and including the stylesheet links goes in <head>; the rest is the body
    lines = fragment.splitlines()
    head, body, in_head = [], [], True
    for line in lines:
        if in_head and (line.startswith("<title") or line.startswith("<link") or not line.strip()):
            head.append(line)
        else:
            in_head = False
            body.append(line)
    nl = "\n"
    return SKELETON.format(head=nl.join(l for l in head if l.strip()), body=nl.join(body))


def version_tag():
    """Short git commit hash (or a timestamp): stamped onto every script/style/import URL so a
    fresh deploy is never served from a browser's or GitHub Pages' 10-minute cache."""
    try:
        return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()
    except Exception:
        return str(int(time.time()))


def stamp_js(src, tag):
    # relative ES-module imports: from "./x.js" / import "./x.js" -> "./x.js?v=<tag>"
    pattern = r"""((?:from|import)\s*["'])(\.{1,2}/[^"']+?\.js)(["'])"""
    return re.sub(pattern, lambda m: f"{m.group(1)}{m.group(2)}?v={tag}{m.group(3)}", src)


def build_site():
    tag = version_tag()
    shutil.rmtree(SITE, ignore_errors=True)
    shutil.copytree(os.path.join(ROOT, "page"), SITE)
    with open(os.path.join(ROOT, "page", "index.html"), encoding="utf-8") as f:
        fragment = f.read().replace('href="styles.css"', f'href="styles.css?v={tag}"').replace('src="app.js"', f'src="app.js?v={tag}"')
    with open(os.path.join(SITE, "index.html"), "w", encoding="utf-8") as f:
        f.write(wrap_fragment(fragment))
    open(os.path.join(SITE, ".nojekyll"), "w").close()  # GitHub Pages: serve files as-is
    os.makedirs(os.path.join(SITE, "engine")), os.makedirs(os.path.join(SITE, "data"))
    for f in glob.glob(os.path.join(ROOT, "engine", "*.js")):
        shutil.copy(f, os.path.join(SITE, "engine"))
    for name in ("game.js", "archetypes.js"):
        shutil.copy(os.path.join(ROOT, "data", name), os.path.join(SITE, "data"))
    for f in [os.path.join(SITE, "app.js"), *glob.glob(os.path.join(SITE, "engine", "*.js"))]:
        with open(f, encoding="utf-8") as fh: src = fh.read()
        with open(f, "w", encoding="utf-8") as fh: fh.write(stamp_js(src, tag))
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
