import { ALL_STATS } from "./stats.js";
import { resolveTalent } from "./validate.js";

export function scoreBuild(core, a, game) {
  let l1 = 0;
  for (const s of ALL_STATS) l1 += Math.abs((core.final[s] ?? 0) - (a.post_shrine_modal[s] ?? 0));
  const spread = 50 * (1 - Math.min(1, l1 / 200));

  const coreT = a.talent_freq.filter(([, f]) => f >= 0.5).map(([n]) => n);
  const have = new Set(core.talents.map(t => resolveTalent(t, game)).filter(Boolean));
  const talents = 30 * (coreT.length ? coreT.filter(t => have.has(t)).length / coreT.length : 1);

  const topM = a.mantra_freq.slice(0, 8).map(([n]) => n);
  const haveM = new Set(core.mantras);
  const mantras = 20 * (topM.length ? topM.filter(m => haveM.has(m)).length / topM.length : 1);

  const score = Math.round(spread + talents + mantras);
  return { score, breakdown: { spread: Math.round(spread), talents: Math.round(talents), mantras: Math.round(mantras) } };
}
