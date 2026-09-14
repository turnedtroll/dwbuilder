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
