"""Mine data/raw/feed_*.json into data/archetypes.json / .js"""
import json, os, re, sys, datetime, statistics
from collections import Counter, defaultdict
if hasattr(sys.stdout, "reconfigure"): sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
BASE = ["Strength", "Fortitude", "Agility", "Intelligence", "Willpower", "Charisma"]
WEAPON = ["Heavy Wep.", "Medium Wep.", "Light Wep."]
ATT = ["Flamecharm", "Frostdraw", "Thundercall", "Galebreathe", "Shadowcast", "Ironsing", "Bloodrend"]
ALL = BASE + WEAPON + ATT
CORE = BASE + WEAPON
WTYPE = {"Heavy Wep.": "heavy", "Medium Wep.": "medium", "Light Wep.": "light"}
MIN_MEMBERS, MIN_VIEWS = 4, 500

VARIANT_SUFFIX = re.compile(r" \[[A-Z]{3,4}\]$")

def make_resolver(game):
    names = game["talents"]; lower = {k.lower(): k for k in names}
    def resolve(name):
        if name in names: return name
        base = VARIANT_SUFFIX.sub("", name)
        return base if base in names else lower.get(base.lower())
    return resolve

def flat(nested):
    f = {s: 0 for s in ALL}
    for grp in ("base", "weapon", "attunement"):
        for k, v in (nested or {}).get(grp, {}).items():
            if k in f: f[k] = int(v or 0)
    return f

def points_spent(f):
    t = sum(f.get(s, 0) for s in ALL); seen = False
    for a in ATT:
        v = f.get(a, 0)
        if seen and v > 0: t -= 1
        if v >= 1: seen = True
    return t

def power_for(f):
    return max(0, min(20, (points_spent(f) - 30 + 15) // 15))

def modal(values):
    c = Counter(values); top = max(c.values())
    return max(v for v, n in c.items() if n == top)

def pct(values, p):
    s = sorted(values); return s[min(len(s) - 1, int(round(p * (len(s) - 1))))]

def freq(counter, n, denom):
    return [[k, round(v / denom, 3)] for k, v in counter.most_common(n) if k not in (None, "", "None")]

def role_of(b, final, talents, oath):
    ts, ms = set(talents), set(b["mantras"])
    healer_sig = ({"Graceful Flame", "Command: Live", "Symbiotic Sustain", "Alsin's Aid"} & ms) or ({"Undying Flame", "Justicar's Mark", "Kindness", "Grand Support"} & ts)
    # Precedence: healer -> dps -> mage -> tank -> hybrid. Tank runs after dps/mage because
    # Fortitude >= 75 / Reinforced Armor / Moving Fortress is baseline survivability present
    # across most of the corpus, not a distinguishing signal; it's a fallback before hybrid.
    if oath == "Linkstrider" or (healer_sig and (final["Charisma"] >= 50 or (final["Flamecharm"] >= 40 and final["Willpower"] >= 40))): return "healer"
    wmax = max(final[w] for w in WEAPON); amax = max(final[a] for a in ATT)
    if wmax >= 65 and wmax >= amax: return "dps"
    if amax >= 65 and wmax < 65: return "mage"
    if final["Fortitude"] >= 75 or ({"Reinforced Armor", "Moving Fortress"} & ts): return "tank"
    return "hybrid"

def load():
    seen = {}
    for f in ("feed_top.json", "feed_popular.json"):
        with open(os.path.join(RAW, f), encoding="utf-8") as fh:
            for b in json.load(fh): seen[b["id"]] = b
    return list(seen.values())

# Chime (of Conflict) builds are an intent players tag themselves. Boss raid is Deepwoken slang for
# a self-sufficient hybrid - good health, good damage AND healing - so it is a stat/kit signature.
GLOBAL_ENCHANT, GLOBAL_STAR_MOD = {}, {}  # per weapon type, filled in main() from the whole corpus
INTENT_TAGS = {"pvp: chime": "chime"}
INTENT_ROLES = ("chime",)
HEAL_MANTRAS = {"Graceful Flame", "Command: Live", "Symbiotic Sustain", "Alsin's Aid", "Rally", "Parasitic Leech", "Shade Devour"}
HEAL_TALENTS = {"Undying Flame", "Justicar's Mark", "Kindness", "Grand Support", "Lord's Tithe", "Phoenix Flames", "Blood Bank", "Saint Jay"}

def is_bossraid(x, resolve):
    f = x["final"]
    dmg = max(max(f[w] for w in WEAPON), max(f[a] for a in ATT))
    heals = bool(set(x["mantras"]) & HEAL_MANTRAS) or bool(set(filter(None, map(resolve, x["talents"]))) & HEAL_TALENTS)
    return f["Fortitude"] >= 50 and dmg >= 65 and heals
ROLE_LABEL = {"dps": "DPS", "bossraid": "Boss raid", "chime": "Chime"}

def intent_of(b):
    tags = {str(t).strip().lower() for t in (b.get("meta", {}).get("tags") or [])}
    return tuple(sorted({INTENT_TAGS[t] for t in tags if t in INTENT_TAGS}))

def prep(b):
    final = flat(b["attributes"]); pre = flat(b["preShrine"]); post = flat(b["postShrine"])
    shrined = any(pre.values()) and pre != (post if any(post.values()) else final)
    meta = b["stats"]["meta"]
    top_w = max(WEAPON, key=lambda w: final[w])
    return {"id": b["id"], "views": b["meta"].get("views", 0), "final": final, "pre": pre if shrined else None, "shrined": shrined, "intent": intent_of(b),
            "talents": [t for t in b["talents"] if not t.startswith(("Oath: ", "Murmur: "))], "mantras": b["mantras"],
            "mods": b.get("content", {}).get("mantraModifications", {}) or {}, "oath": meta.get("Oath", "None"), "origin": meta.get("Origin"),
            "race": meta.get("Race"), "murmur": meta.get("Murmur"), "bell": meta.get("Bell"), "outfit": meta.get("Outfit"),
            "weapon": b.get("weapons") or "", "enchant": b.get("enchant") or "", "weapon_stars": b.get("weaponStars") or {}, "wtype": WTYPE[top_w] if final[top_w] >= 40 else "none",
            "atts": tuple(a for a in ATT if final[a] >= 40), "equipment": b.get("equipment") or {},
            "boons": [b["stats"].get("boon1"), b["stats"].get("boon2")], "flaws": [b["stats"].get(f"flaw{i}") for i in (1, 2, 3)],
            "traits": b["stats"].get("traits") or {}, "multifaceted": bool(b.get("multifaceted"))}

def cluster(items):
    def key(x, level):
        k = [x["role"], x["wtype"]]
        if level <= 1: k.append(x["atts"])
        if level == 0: k.append(x["oath"])
        return tuple(k)
    groups, leftover = {}, items
    for level in (0, 1, 2):
        g = defaultdict(list)
        for x in leftover: g[key(x, level)].append(x)
        leftover = []
        for k, members in g.items():
            if len(members) >= MIN_MEMBERS: groups[k] = members
            else: leftover.extend(members)
    return groups

def summarize(key, members, game, resolve):
    n = len(members); members = sorted(members, key=lambda x: -x["views"])
    shrined = [m for m in members if m["shrined"]]
    pre_src = shrined if len(shrined) >= max(2, n // 3) else []
    # Per-stat modals for stack_stat selection (old logic kept for backward compat in stack computation)
    pre_modal_old = {s: modal([m["pre"][s] for m in pre_src]) if pre_src else 0 for s in ALL}
    post_modal_old = {s: modal([m["final"][s] for m in members]) for s in ALL}

    # Compute L1-medoid: member minimizing sum of L1 distances to all members; ties -> higher views
    def l1_dist(m1_stats, m2_stats):
        return sum(abs(m1_stats.get(s, 0) - m2_stats.get(s, 0)) for s in ALL)
    medoid = min(members, key=lambda m: (sum(l1_dist(m["final"], o["final"]) for o in members), -m["views"]))
    post_shrine_modal = dict(medoid["final"])  # Medoid member's real stats (coherent build)

    # Pre-shrine modal: medoid's pre if shrined, else L1-medoid of pre_src, else all zeros
    if medoid["shrined"] and medoid["pre"]:
        pre_shrine_modal = dict(medoid["pre"])
    elif pre_src:
        pre_medoid = min(pre_src, key=lambda m: (sum(l1_dist(m["pre"], o["pre"]) for o in pre_src), -m["views"]))
        pre_shrine_modal = dict(pre_medoid["pre"])
    else:
        pre_shrine_modal = {s: 0 for s in ALL}

    spread = {s: {"p25": pct([m["final"][s] for m in members], .25), "p50": pct([m["final"][s] for m in members], .5), "p75": pct([m["final"][s] for m in members], .75)} for s in ALL}
    stack_stat = max(CORE, key=lambda s: pre_modal_old[s]) if pre_src else max(CORE, key=lambda s: post_modal_old[s])
    stack_vals = [m["pre"][stack_stat] for m in pre_src] or [m["final"][stack_stat] for m in members]
    powers = [power_for(m["pre"]) for m in pre_src] or [12]
    # dict.fromkeys (not set()) for per-member dedup: iteration order must be deterministic
    # (insertion order from the source list) so Counter.most_common()'s tie-breaking at the
    # freq() truncation boundary doesn't depend on Python's per-process string hash seed.
    tal = Counter(t for m in members for t in dict.fromkeys(filter(None, map(resolve, m["talents"]))))
    man = Counter(t for m in members for t in dict.fromkeys(t for t in m["mantras"] if t in game["mantras"]))
    # Typical kit size (builder rule: counting talents <= 52 + (12 - obtained Normal mantras) * 2).
    # Medians over members, so one wishlist build doesn't inflate the archetype's budget.
    counting = lambda m: sum(1 for t in dict.fromkeys(filter(None, map(resolve, m["talents"]))) if game["talents"][t].get("counts"))
    normal_mantras = lambda m: sum(1 for t in dict.fromkeys(m["mantras"]) if t in game["mantras"] and game["mantras"][t].get("type", "Normal") == "Normal"
                                   and game["mantras"][t].get("category") in ("Combat", "Mobility", "Support", "Wisp"))
    budget = {"mantras": int(statistics.median(normal_mantras(m) for m in members)),
              "talents": int(statistics.median(counting(m) for m in members))}
    budget["talents"] = min(budget["talents"], 52 + (12 - budget["mantras"]) * 2)
    gems = defaultdict(Counter)
    for m in members:
        for name, mod in m["mods"].items():
            if isinstance(mod, dict) and mod.get("gem") and mod["gem"] != "None": gems[name][mod["gem"]] += 1
    equip = {}
    for slot in ("Head", "Arms", "Legs", "Torso", "Face", "Earrings", "Rings"):
        c = Counter()
        for m in members:
            v = m["equipment"].get(slot)
            for item in (v if isinstance(v, list) else [v]):
                if isinstance(item, dict) and item.get("name"): c[item["name"]] += 1
        equip[slot] = freq(c, 6, n)
    # Stars and pips per slot: the most common exact pip signature among members' 3-star items in
    # that slot (fallback: any stars), so gear comes with the stats real builds roll on it.
    gear_pips = {}
    for slot in ("Head", "Arms", "Legs", "Torso", "Face", "Earrings", "Rings"):
        sigs = Counter()
        for m in members:
            v = m["equipment"].get(slot)
            for item in (v if isinstance(v, list) else [v]):
                if not isinstance(item, dict) or not item.get("name"): continue
                pips = tuple((p.get("stat"), p.get("rarity") or "Rare") for p in (item.get("pips") or []) if p.get("stat"))
                if pips: sigs[(int(item.get("qualityStars") or 0), pips)] += 1
        if not sigs: continue
        three = Counter({k: v for k, v in sigs.items() if k[0] == 3})
        stars, pips = (three or sigs).most_common(1)[0][0]
        gear_pips[slot] = {"stars": stars or 3, "pips": [list(p) for p in pips]}
    star_mods = Counter((m["weapon_stars"] or {}).get("mod") for m in members if (m["weapon_stars"] or {}).get("mod") in ("DMG%", "PEN%"))
    weapon_stars = {"count": 3, "mod": star_mods.most_common(1)[0][0] if star_mods else GLOBAL_STAR_MOD.get(key[1], "DMG%")}
    role, wtype = key[0], key[1]
    enchants = freq(Counter(m["enchant"] for m in members), 5, n)
    if not enchants and GLOBAL_ENCHANT.get(wtype): enchants = [[GLOBAL_ENCHANT[wtype], 0.0]]  # nobody in the cluster set one; the weapon type's usual pick
    atts = key[2] if len(key) > 2 else tuple(a for a in ATT if post_modal_old[a] >= 40)
    # Fallback-level clusters (oath not in the key) mix oaths; the stat block is the medoid's, so the
    # medoid's oath is the only one guaranteed coherent with it -> it names the archetype and leads
    # the oath list (rest stays by frequency). A "None"-oath medoid falls back to the modal oath.
    oath = key[3] if len(key) > 3 else (medoid["oath"] if medoid["oath"] not in (None, "", "None") else modal([m["oath"] for m in members]))
    oath_counts = Counter(m["oath"] for m in members)
    oath_freq = [kv for kv in freq(oath_counts, len(oath_counts), n) if kv[0] == oath] + [kv for kv in freq(oath_counts, 5, n) if kv[0] != oath][:4]
    ident = "-".join([role, wtype, *(a.lower()[:5] for a in atts), oath.lower()]).replace(" ", "")
    return {
        "id": ident, "role": role, "label": f"{ROLE_LABEL.get(role, role.title())} · {'/'.join(atts) or 'attunementless'} · {wtype if wtype != 'none' else 'no weapon'} · {oath}",
        "members": n, "example_ids": [m["id"] for m in members[:3]], "medoid_id": medoid["id"], "views_total": sum(m["views"] for m in members),
        "stack": {"stat": stack_stat, "min": pct(stack_vals, .25), "modal": modal(stack_vals)},
        "pre_shrine_modal": pre_shrine_modal, "shrine_power_modal": modal(powers), "shrine_power_window": [min(powers), max(powers)],
        "shrined_rate": round(len(shrined) / n, 3), "post_shrine_modal": post_shrine_modal, "post_shrine_spread": spread,
        "talent_freq": freq(tal, 120, n), "mantra_freq": freq(man, 40, n), "budget": budget,
        "gem_freq": {k: freq(v, 3, sum(v.values())) for k, v in gems.items()},
        "oath": oath_freq, "origin": freq(Counter(m["origin"] for m in members), 5, n),
        "race": freq(Counter(m["race"] for m in members), 5, n), "murmur": freq(Counter(m["murmur"] for m in members), 3, n),
        "bell": freq(Counter(m["bell"] for m in members), 3, n), "outfits": freq(Counter(m["outfit"] for m in members), 6, n),
        "weapons": freq(Counter(m["weapon"] for m in members), 8, n), "enchants": enchants,
        "equipment": equip, "gear_pips": gear_pips, "weapon_stars": weapon_stars, "boons": freq(Counter(b for m in members for b in m["boons"]), 4, n), "flaws": freq(Counter(f for m in members for f in m["flaws"]), 5, n),
        "traits_modal": {t: modal([int(m["traits"].get(t, 0) or 0) for m in members]) for t in ("Vitality", "Erudition", "Proficiency", "Songchant")},
        "multifaceted_rate": round(sum(m["multifaceted"] for m in members) / n, 3),
    }

def main():
    with open(os.path.join(ROOT, "data", "game.json"), encoding="utf-8") as fh:
        game = json.load(fh)
    resolve = make_resolver(game)
    raw = load()
    kept = [prep(b) for b in raw if b["stats"].get("pointSpent") == 330 and b["meta"].get("views", 0) >= MIN_VIEWS and b["talents"]]
    for x in kept: x["role"] = role_of({"mantras": x["mantras"]}, x["final"], x["talents"], x["oath"])
    GLOBAL_ENCHANT["none"] = Counter(x["enchant"] for x in kept if x["enchant"]).most_common(1)[0][0]  # any weapon type
    for wt in ("light", "medium", "heavy"):
        ench = Counter(x["enchant"] for x in kept if x["wtype"] == wt and x["enchant"])
        if ench: GLOBAL_ENCHANT[wt] = ench.most_common(1)[0][0]
        mods = Counter((x["weapon_stars"] or {}).get("mod") for x in kept if x["wtype"] == wt and (x["weapon_stars"] or {}).get("mod") in ("DMG%", "PEN%"))
        if mods: GLOBAL_STAR_MOD[wt] = mods.most_common(1)[0][0]
    # Intent roles from the authors' own tags: a "pve: boss" build also joins the bossraid clusters,
    # a "pvp: chime" build the chime clusters (on top of its stat-shape role above).
    kept += [dict(x, role=r) for x in kept for r in INTENT_ROLES if r in x["intent"]] + [dict(x, role="bossraid") for x in kept if is_bossraid(x, resolve)]
    groups = cluster(kept)
    arch = sorted((summarize(k, v, game, resolve) for k, v in groups.items()), key=lambda a: -a["views_total"])
    seen_ids = Counter()
    for a in arch:
        seen_ids[a["id"]] += 1
        if seen_ids[a["id"]] > 1: a["id"] = f"{a['id']}-{seen_ids[a['id']]}"
    out = {"meta": {"generated": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"), "builds_in": len(raw), "builds_kept": len(kept), "archetypes": len(arch)}, "archetypes": arch}
    with open(os.path.join(ROOT, "data", "archetypes.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(ROOT, "data", "archetypes.js"), "w", encoding="utf-8") as fh:
        fh.write("export default " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n")
    print(f"{len(kept)} builds -> {len(arch)} archetypes")
    for a in arch: print(f"  {a['members']:3d}  {a['label']}")

if __name__ == "__main__":
    main()
