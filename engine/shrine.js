import { flatten, nest, pointsSpent } from "./stats.js";
const LOSS_CAP = 25, STAT_MAX = 100;
const clone = o => JSON.parse(JSON.stringify(o));

export function shrineOfOrder(preFlat, raceBonus = {}) {
  const n = nest(preFlat);
  const entries = [];
  for (const type of ["base", "weapon", "attunement"]) for (const name of Object.keys(n[type])) entries.push({ type, name });
  const get = p => n[p.type][p.name] ?? 0;
  const set = (p, v) => { n[p.type][p.name] = v; };
  const bonus = p => (p.type === "base" ? raceBonus[p.name] ?? 0 : 0);
  const orig = clone(n);
  const origOf = p => orig[p.type][p.name] ?? 0;
  const invested = entries.filter(p => get(p) - bonus(p) > 0);
  if (invested.length === 0) return { base: flatten(n), spare: 0 };
  let total = 0; for (const p of invested) total += get(p);
  const avg = total / invested.length;
  for (const p of invested) set(p, avg);
  const locked = new Set();
  let snap = clone(n), again = true, guard = 32;
  while (again && guard-- > 0) {
    again = false;
    let excess = 0;
    for (const p of invested) {
      if (p.type === "attunement" || locked.has(p)) continue;
      const prev = snap[p.type][p.name], o = origOf(p), cur = get(p);
      if (o - cur > LOSS_CAP) { const v = o - LOSS_CAP; set(p, v); excess += v - prev; locked.add(p); }
    }
    const free = invested.length - locked.size;
    if (free > 0 && excess !== 0) {
      const share = excess / free;
      for (const p of invested) if (!locked.has(p)) { set(p, get(p) - share); if (p.type !== "attunement" && origOf(p) - get(p) > LOSS_CAP) again = true; }
    }
    snap = clone(n);
  }
  for (const p of invested) set(p, Math.floor(get(p)));
  let after = 0; for (const p of invested) after += get(p);
  const leftover = total - after;
  const unlocked = invested.filter(p => !locked.has(p));
  if (unlocked.length > 0) {
    let rem = leftover;
    while (rem >= unlocked.length && !unlocked.some(p => get(p) + 1 > STAT_MAX)) { for (const p of unlocked) set(p, get(p) + 1); rem -= unlocked.length; }
  }
  const base = flatten(n);
  return { base, spare: Math.max(0, pointsSpent(preFlat) - pointsSpent(base)) };
}
