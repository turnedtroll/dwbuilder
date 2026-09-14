import json, os, unittest, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

class SlimData(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.check_call([sys.executable, os.path.join(ROOT, "pipeline", "slimdata.py")], cwd=ROOT)
        cls.g = json.load(open(os.path.join(ROOT, "data", "game.json"), encoding="utf-8"))

    def test_sizes(self):
        self.assertLess(os.path.getsize(os.path.join(ROOT, "data", "game.json")), 400_000)
        self.assertGreater(len(self.g["talents"]), 890)
        self.assertGreater(len(self.g["mantras"]), 230)

    def test_known_entries(self):
        t = self.g["talents"]["Command: Live"]
        self.assertEqual(t["reqs"], {"Charisma": 75}); self.assertEqual(t["pre"], ["Vow of Mastery"])
        self.assertEqual(self.g["talents"]["Reinforced Armor"]["reqs"], {"Fortitude": 90})
        m = self.g["mantras"]["Graceful Flame"]
        self.assertEqual(m["attunement"], "Flamecharm"); self.assertEqual(m["category"], "Support"); self.assertEqual(m["type"], "Normal")
        self.assertEqual(self.g["outfits"]["Warder's Attire"]["origin"], "Justicar")
        self.assertIn("Justicar's Gift", self.g["outfits"]["Warder's Attire"]["talents"])
        self.assertEqual(self.g["weapons"]["Fool's Tankard"]["wtype"], "light")
        self.assertEqual(self.g["races"]["Capra"], {"Intelligence": 3, "Willpower": 2})
        self.assertEqual(self.g["oaths"]["Linkstrider"]["slots"].__class__, dict)
        self.assertIn("Justicar", self.g["origins"]); self.assertIn("Rhythm", self.g["murmurs"])
        self.assertEqual(self.g["slots"]["Combat"], 3)

    def test_js_twin(self):
        js = open(os.path.join(ROOT, "data", "game.js"), encoding="utf-8").read()
        self.assertTrue(js.startswith("export default "))

    def test_voi_filtering(self):
        # Verify VOI (legacy variant) entries are filtered out
        for talent_name in self.g["talents"]:
            self.assertNotIn("(VOI)", talent_name, f"VOI entry found in talents: {talent_name}")
        for mantra_name in self.g["mantras"]:
            self.assertNotIn("(VOI)", mantra_name, f"VOI entry found in mantras: {mantra_name}")
        # Verify Burning Servants has real (non-VOI) requirements
        self.assertIn("Burning Servants", self.g["mantras"])
        self.assertEqual(self.g["mantras"]["Burning Servants"]["reqs"], {"Flamecharm": 1})
