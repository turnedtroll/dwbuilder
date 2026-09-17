import json, os, unittest, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pipeline"))
from mine import points_spent

class Mine(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.check_call([sys.executable, os.path.join(ROOT, "pipeline", "mine.py")], cwd=ROOT)
        with open(os.path.join(ROOT, "data", "archetypes.json"), encoding="utf-8") as fh:
            cls.a = json.load(fh)
        with open(os.path.join(ROOT, "data", "game.json"), encoding="utf-8") as fh:
            cls.game = json.load(fh)

    def test_shape_and_counts(self):
        self.assertGreaterEqual(self.a["meta"]["builds_kept"], 800)
        self.assertGreaterEqual(len(self.a["archetypes"]), 15)
        roles = {x["role"] for x in self.a["archetypes"]}
        self.assertTrue({"healer", "dps", "tank", "mage", "bossraid", "chime"} <= roles, roles)
        for x in self.a["archetypes"]:
            self.assertGreaterEqual(x["members"], 4)
            self.assertEqual(len(x["example_ids"]), min(3, x["members"]))
            self.assertIn(x["stack"]["stat"], x["pre_shrine_modal"].keys())
            self.assertEqual(sum(1 for v in x["post_shrine_modal"].values()), 16)
            self.assertTrue(327 <= points_spent(x["post_shrine_modal"]) <= 333, x["id"])
        self.assertEqual(len({x["id"] for x in self.a["archetypes"]}), len(self.a["archetypes"]))

    def test_names_resolve_to_game_data(self):
        for x in self.a["archetypes"]:
            for name, _ in x["talent_freq"]:
                self.assertTrue(name in self.game["talents"] or name.startswith(("Oath: ", "Murmur: ")), name)
            for name, _ in x["mantra_freq"]: self.assertIn(name, self.game["mantras"])

    def test_healer_archetype_looks_right(self):
        h = [x for x in self.a["archetypes"] if x["role"] == "healer"]
        self.assertTrue(h)
        best = max(h, key=lambda x: x["members"])
        self.assertIn(best["stack"]["stat"], ("Charisma", "Fortitude", "Agility", "Willpower"))
        names = [n for n, _ in best["mantra_freq"][:15]]
        self.assertTrue({"Graceful Flame", "Reinforce", "Symbiotic Sustain"} & set(names), names)

    def test_default_oath_is_the_medoids_oath(self):
        # post_shrine_modal is the L1-medoid member's real build (ruling R6), so the archetype's
        # default oath (oath[0]) must be the one that build actually holds - otherwise the engine
        # plans stats for an oath the stat block was never meant for (e.g. Saintsworn's 15 in five
        # attunements on a Frostdraw/Ironsing medoid). Frequencies stay honest; only the order changes.
        from mine import load
        by_id = {b["id"]: b for b in load()}
        for x in self.a["archetypes"]:
            med = by_id[x["medoid_id"]]
            oath = med["meta"].get("Oath", "None")
            if oath in (None, "", "None"):
                self.assertTrue(not x["oath"] or x["oath"][0][0] != "None", x["id"])
                continue
            self.assertEqual(x["oath"][0][0], oath, x["id"])
            self.assertTrue(x["id"].endswith(oath.lower().replace(" ", "")) or x["id"].rsplit("-", 1)[-1].isdigit(), x["id"])
            self.assertEqual(sorted(x["oath"][1:], key=lambda kv: -kv[1]), x["oath"][1:], x["id"])

    def test_budget_reflects_members(self):
        # Each archetype records how many talents / obtained mantras its members typically hold, so the
        # engine can pick like a real player instead of taking the union of everything members ever took.
        # The builder's rule: counting talents <= 52 + (12 - normal mantras) * 2.
        for x in self.a["archetypes"]:
            b = x["budget"]
            self.assertTrue(0 <= b["mantras"] <= 20, x["id"])
            self.assertTrue(20 <= b["talents"] <= 76, x["id"])
            self.assertLessEqual(b["talents"], 52 + (12 - b["mantras"]) * 2 + 6, x["id"])  # medians of real builds sit near the cap

    def test_pointsmath(self):
        from mine import points_spent, power_for
        self.assertEqual(points_spent({"Charisma": 90, "Flamecharm": 1, "Thundercall": 1, "Frostdraw": 1}), 91)
        self.assertEqual(power_for({"Strength": 45}), 2)

    def test_js_twin(self):
        with open(os.path.join(ROOT, "data", "archetypes.js"), encoding="utf-8") as fh:
            self.assertTrue(fh.read().startswith("export default "))

    def test_resolver(self):
        from mine import make_resolver
        r = make_resolver(self.game)
        self.assertEqual(r("Wyvern's Claw [LHT]"), "Wyvern's Claw")
        self.assertEqual(r("To the Finish"), "To The Finish")
        self.assertIsNone(r("Definitely Not A Talent"))

if __name__ == "__main__":
    unittest.main()
