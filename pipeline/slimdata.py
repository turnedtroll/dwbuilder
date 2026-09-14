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
        rarity = t.get("rarity")
        # Drop desc for all talents to reduce file size
        desc = ""
        talents[t["name"]] = {
            "reqs": reqs_of(t), "pre": list(r.get("talents") or []), "or": or_block(r),
            "category": t.get("category"), "rarity": rarity, "desc": desc,
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
