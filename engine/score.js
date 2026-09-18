import { ALL_STATS } from "./stats.js";
import { resolveTalent, mantraPathWhy } from "./validate.js";

export function scoreBuild(core, a, game) {
  // Weapon stats don't count against a build whose weapon doesn't scale with them (Hero's Blades) or
  // that has none: the reference player's leftover weapon points are not something to copy.
  const weaponScales = core.weapon && game.weapons[core.weapon]?.wtype;
  let l1 = 0;
  for (const s of ALL_STATS) {
    if (!weaponScales && ["Heavy Wep.", "Medium Wep.", "Light Wep."].includes(s)) continue;
    l1 += Math.abs((core.final[s] ?? 0) - (a.post_shrine_modal[s] ?? 0));
  }
  const spread = 50 * (1 - Math.min(1, l1 / 200));

  // Core = the archetype's most frequent talents, but no more than a real kit holds (the builder's
  // card budget): coverage of a union larger than any member's kit could never reach 100%.
  // Another oath's talents (rarity Oath, other category) can't be on this path at all - a mixed-oath
  // cluster's frequency list has them, but they're not a miss.
  const onPath = n => { const g = game.talents[n]; return !g || g.rarity !== "Oath" || g.category === core.oath; };
  const kit = a.budget?.talents ?? Infinity;
  const coreT = a.talent_freq.filter(([n, f]) => f >= 0.5 && onPath(n)).slice(0, kit).map(([n]) => n);
  const have = new Set(core.talents.map(t => resolveTalent(t, game)).filter(Boolean));
  const talents = 30 * (coreT.length ? coreT.filter(t => have.has(t)).length / coreT.length : 1);

  const topM = a.mantra_freq.map(([n]) => n).filter(n => !mantraPathWhy(n, core, game)).slice(0, 8);
  const haveM = new Set(core.mantras);
  const mantras = 20 * (topM.length ? topM.filter(m => haveM.has(m)).length / topM.length : 1);

  const score = Math.round(spread + talents + mantras);
  return { score, breakdown: { spread: Math.round(spread), talents: Math.round(talents), mantras: Math.round(mantras) } };
}
