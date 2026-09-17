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

def is_voi(x):
    """Check if an entry is a VOI (legacy variant) entry."""
    return x.get("VOI") or "(VOI)" in (x.get("_id") or "") or "(VOI)" in (x.get("name") or "")

def reqs_of(obj):
    r = (obj.get("requirements") or {})
    return {k: int(v) for k, v in (r.get("stats") or {}).items() if isinstance(v, (int, float))}

def or_block(req):
    # The builder's semantics (its tr() evaluator): everything at the top level is mandatory, and
    # when an "or" list exists at least one alternative must hold as well. So an alternative only
    # carries what is specific to it: a bare {"weaponType": ...} (Armor Piercing) or an alternative
    # made only of quest/slay objectives we cannot model (which therefore holds trivially).
    req = req or {}
    out = []
    for alt in req.get("or") or []:
        # one raw entry (Jus Karita) nests its origin requirement one level deeper, inside its own
        # "or": [{"origin": ...}] rather than directly on the alternative - fall back to that if present.
        nested = (alt.get("or") or [{}])[0]
        out.append({"reqs": {k: int(v) for k, v in (alt.get("stats") or {}).items()}, "pre": list(alt.get("talents") or []),
                    "origin": alt.get("origin") or nested.get("origin"), "outfit": alt.get("outfit") or nested.get("outfit"),
                    "weaponType": alt.get("weaponType")})
    return out

def wtype(w):
    keys = set((w.get("scaling") or {}).keys()) | set((w.get("requirements") or {}).get("stats", {}).keys())
    for k, t in (("Light Weapon", "light"), ("Medium Weapon", "medium"), ("Heavy Weapon", "heavy")):
        if k in keys: return t
    return None

def main():
    with open(os.path.join(RAW, "gamedata.json"), encoding="utf-8") as f:
        g = json.load(f)
    D = g["data"]
    talents = {}
    for t in D["talents"]:
        # Skip VOI (legacy variant) entries
        if is_voi(t):
            continue
        r = t.get("requirements") or {}
        rarity = t.get("rarity")
        # Keep desc for non-equipment talents; drop for Equipment/Weapon/Memento to reduce file size
        desc = "" if rarity in ("Equipment", "Weapon", "Memento") else short(t.get("description"))
        talents[t["name"]] = {
            "reqs": reqs_of(t), "pre": list(r.get("talents") or []), "or": or_block(r),
            "category": t.get("category"), "rarity": rarity, "desc": desc,
            "origin": r.get("origin"), "outfit": r.get("outfit"), "aspect": r.get("aspect"),
            "weaponType": r.get("weaponType"), "mantras": list(r.get("mantras") or []),
            "exclusive": list(t.get("mutualExclusives") or []), "counts": bool(t.get("countTowardsTalentTotal", True)),
        }
    mantras = {}
    for m in D["mantras"]:
        # Skip VOI (legacy variant) entries
        if is_voi(m):
            continue
        attrs = m.get("attributes") or []
        mantras[m["name"]] = {"attunement": attrs[0] if attrs else None, "reqs": reqs_of(m), "category": m.get("category"),
                              "type": m.get("type") or "Normal", "desc": short(m.get("description")), "modifiers": list(m.get("modifiers") or [])}
    weapons = {w["name"]: {"type": w.get("type"), "wtype": wtype(w), "reqs": reqs_of(w), "talents": list(w.get("grantedTalents") or [])} for w in D["weapons"] if not is_voi(w)}
    outfits = {o["name"]: {"reqs": reqs_of(o), "origin": (o.get("requirements") or {}).get("origin"), "talents": list(o.get("grantedTalents") or [])} for o in D["outfits"] if not is_voi(o)}
    # innate_pips: the item's fixed pip rarities in order (the builder's server validates each pip's
    # rarity: innate pips first, then the star pips - 2 stars add Rare, Rare; 3 stars add Rare, Rare, Legendary).
    def equip_entry(e):
        out = {"slot": e.get("type"), "talents": list(e.get("innateTalents") or []), "reqs": reqs_of(e)}
        pips = [grp.get("rarity", "Rare") for grp in (e.get("innatePips") or []) for _ in range(int(grp.get("count") or 1))]
        if pips: out["innate_pips"] = pips
        return out
    equipment = {e["name"]: equip_entry(e) for e in g["equipmentData"] if e and not is_voi(e) and e.get("equippable", True)}  # cosmetics (equippable false) can't be saved on a build
    oaths = {o["name"]: {"slots": o.get("slots") or {}, "mantras": o.get("mantras") or {}} for o in g["oathsData"]}
    races = {a["name"]: a.get("statBonuses") or {} for a in g["aspectsData"]}
    # enumerations come from the build corpus (the builder keeps them in UI code, not game data)
    seen = {"Origin": set(), "Murmur": set(), "Bell": set()}
    for f in ("feed_top.json", "feed_popular.json"):
        with open(os.path.join(RAW, f), encoding="utf-8") as fh:
            for b in json.load(fh):
                for k in seen:
                    v = (b.get("stats", {}).get("meta") or {}).get(k)
                    if v: seen[k].add(v)
    out = {
        "meta": {"generated": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"), "talents": len(talents), "mantras": len(mantras)},
        "talents": talents, "mantras": mantras, "weapons": weapons, "outfits": outfits, "equipment": equipment,
        "enchants": [e["name"] for e in D["enchants"] if not is_voi(e)], "oaths": oaths, "races": races,
        "origins": sorted(seen["Origin"]), "murmurs": sorted(seen["Murmur"]), "bells": sorted(seen["Bell"]),
        "boons": [b["name"] for b in g["boonsData"]], "flaws": [f["name"] for f in g["flawsData"]], "slots": SLOTS,
    }
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    with open(OUT_JS, "w", encoding="utf-8") as f:
        f.write("export default " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n")
    print(f"game.json: {os.path.getsize(OUT_JSON)/1024:.0f} KB, {len(talents)} talents, {len(mantras)} mantras")

if __name__ == "__main__":
    main()
