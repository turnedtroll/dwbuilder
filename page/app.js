// Deepwoken Forge — request form → engine → build view. Imports are written for the published
// layout (engine/, data/ next to this file); pipeline/serve_local.py mirrors it for local runs.
import * as E from "./engine/index.js";
import GAME from "./data/game.js";
import ARCH from "./data/archetypes.js";

const $ = id => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};

// The bookmark runs on deepwoken.co/builder. It reads the build code from the clipboard (falls
// back to a paste prompt) and loads it straight into the builder's pinia store - the same call
// the builder makes when it recovers a draft - so nothing reloads and nothing races the
// builder's own draft autosave. If the store can't be found it falls back to the localStorage
// draft key + reload. `void` keeps the javascript: URL from navigating to the promise's text.
const BOOKMARKLET_SRC = `void (async()=>{
if(location.hostname!=='deepwoken.co'){alert('Open https://deepwoken.co/builder first, then click this bookmark.');return;}
const parse=t=>{try{const e=JSON.parse(t);return e&&e.version===1&&e.build?e:null}catch(x){return null}};
let env=null;try{env=parse(await navigator.clipboard.readText());}catch(x){}
if(!env){const t=prompt('Paste the build code from Deepwoken Forge:');if(!t)return;env=parse(t);}
if(!env){alert('That did not look like a Deepwoken Forge build code. Click "Send to deepwoken.co" on the Forge page first, then click this bookmark.');return;}
try{const root=document.querySelector('#__nuxt');const store=root.__vue_app__.config.globalProperties.$pinia._s.get('build');store.restoreDraft(env.build,env.phase||'post');window.scrollTo(0,0);}
catch(x){localStorage.setItem('_dwb.draft.v1.new',JSON.stringify(env));location.href='/builder';}
})();`.replace(/\n/g, "");

const state = {
  include: new Set(), exclude: new Set(),
  mustTalents: [], avoidTalents: [], mustMantras: [], avoidMantras: [],
  build: null, req: null, auto: true,
  sample: null, db: null, libraryUnsub: null,
};
const ROLE_LABEL = { dps: "DPS", healer: "Healer", tank: "Tank", mage: "Mage", hybrid: "Hybrid", bossraid: "Boss raid", chime: "Chime" };
const archetypeOf = b => ARCH.archetypes.find(a => a.id === b?.based_on?.archetype) ?? null;
const isPathEntry = n => typeof n === "string" && (n.startsWith("Oath: ") || n.startsWith("Murmur: "));

// ---------- form population ----------
function fillSelect(id, names) {
  const s = $(id);
  for (const n of names) if (n && n !== "None") s.append(el("option", { value: n, text: n }));
}

function attunementChips(containerId, set, other, otherSet) {
  const box = $(containerId);
  for (const a of E.ATTUNEMENTS) {
    const chip = el("label", { class: "chip chip-toggle", text: a });
    const input = el("input", { type: "checkbox", value: a });
    chip.prepend(input);
    input.addEventListener("change", () => {
      if (input.checked) { set.add(a); otherSet.delete(a); syncAttunementChips(); }
      else set.delete(a);
      chip.classList.toggle("on", input.checked);
      state.auto = false;
    });
    box.append(chip);
  }
  function syncAttunementChips() {
    for (const [id, s] of [["att-include", state.include], ["att-exclude", state.exclude]]) {
      for (const c of $(id).querySelectorAll(".chip-toggle")) {
        const on = s.has(c.querySelector("input").value);
        c.querySelector("input").checked = on; c.classList.toggle("on", on);
      }
    }
  }
}

function weaponDatalist() {
  const wt = $("weapon-type").value;
  const list = $("weapon-list"); list.replaceChildren();
  $("weapon-field").hidden = wt === "none";
  const names = Object.entries(GAME.weapons)
    .filter(([, w]) => !wt || wt === "none" || w.wtype === wt)
    .map(([n]) => n).sort();
  for (const n of names) list.append(el("option", { value: n }));
}

// ---------- name chips with validation ----------
function resolveName(kind, raw) {
  const name = raw.trim();
  if (!name) return null;
  if (kind === "talent") return E.resolveTalent(name, GAME);
  if (name in GAME.mantras) return name;
  const lower = name.toLowerCase();
  return Object.keys(GAME.mantras).find(m => m.toLowerCase() === lower) ?? null;
}
function suggest(kind, raw) {
  const pool = Object.keys(kind === "talent" ? GAME.talents : GAME.mantras).filter(n => !n.startsWith("Oath: ") && !n.startsWith("Murmur: "));
  const q = raw.trim().toLowerCase();
  let hits = pool.filter(n => n.toLowerCase().includes(q));
  if (!hits.length) { const first = q.split(/\s+/)[0]; hits = pool.filter(n => n.toLowerCase().split(/\s+/)[0] === first); }
  return hits.slice(0, 3);
}
function chipList(baseId, kind, arr) {
  const box = $(baseId), input = $(`${baseId}-input`), hint = $(`${baseId}-hint`);
  const draw = () => {
    box.replaceChildren(...arr.map((n, i) => el("span", { class: "chip" }, n,
      el("button", { type: "button", "aria-label": `Remove ${n}`, text: "×", onclick: () => { arr.splice(i, 1); draw(); state.auto = false; } }))));
  };
  const add = () => {
    const raw = input.value;
    if (!raw.trim()) return;
    const r = resolveName(kind, raw);
    if (!r) {
      const s = suggest(kind, raw);
      hint.textContent = `No ${kind} named ${raw.trim()}` + (s.length ? ` — did you mean ${s.join(", ")}?` : ".");
      hint.classList.add("bad");
      return;
    }
    hint.textContent = ""; hint.classList.remove("bad");
    if (!arr.includes(r)) arr.push(r);
    input.value = ""; draw(); state.auto = false;
  };
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  input.addEventListener("change", add);
  draw();
}

// ---------- request ----------
function readRequest() {
  const v = id => $(id).value || null;
  const wt = $("weapon-type").value;
  return {
    role: $("role").value,
    include_attunements: [...state.include],
    exclude_attunements: [...state.exclude],
    attunementless: $("attunementless").checked,
    weapon_type: wt || null,
    weapon: wt === "none" ? null : v("weapon"),
    oath: v("oath"), origin: v("origin"), race: v("race"),
    shrine: $("shrine").checked,
    multifaceted: $("multifaceted").checked,
    must_talents: [...state.mustTalents], avoid_talents: [...state.avoidTalents],
    must_mantras: [...state.mustMantras], avoid_mantras: [...state.avoidMantras],
    free_text: $("free-text").value,
  };
}

function showError(msg, kind = "bad") {
  const b = $("error-banner"); b.textContent = msg; b.className = `banner ${kind === "warn" ? "warn" : ""}`; b.hidden = !msg;
}

function generate() {
  try {
    const req = readRequest();
    const build = E.assemble(req, ARCH.archetypes, GAME);
    state.build = build; state.req = req;
    showError("");
    $("refine-section").hidden = true;
    render(build);
  } catch (e) {
    console.error(e);
    showError(`Could not forge that build: ${e.message}`);
  }
}

// ---------- render ----------
const fmtStat = s => s;
function render(b) {
  $("build-role").textContent = ROLE_LABEL[b.based_on?.archetype?.split("-")[0]] ?? b.based_on?.archetype?.split("-")[0] ?? "";
  $("build-auto").hidden = !state.auto;
  $("build-based").textContent = `based on ${b.based_on.members} build${b.based_on.members === 1 ? "" : "s"}${b.based_on.adapted ? " (adapted)" : ""}`;
  $("build-name").textContent = b.name;
  $("build-desc").textContent = b.description ?? "";
  const badge = $("build-score");
  badge.textContent = `meta ${b.meta_score}`;
  badge.className = `badge ${b.meta_score >= 70 ? "ok" : b.meta_score >= 50 ? "warn" : "bad"}`;
  const br = b.score_breakdown ?? {};
  $("build-breakdown").textContent = Object.entries(br).map(([k, v]) => `${k} ${v}`).join(" · ");
  $("build-examples").replaceChildren("Examples: ", ...(b.based_on.examples ?? []).map(id =>
    el("a", { href: `https://deepwoken.co/builder?id=${encodeURIComponent(id)}`, target: "_blank", rel: "noopener", text: id })));

  // validation
  const issues = [
    ...b.validation.errors.map(x => ({ ...x, kind: "bad" })),
    ...b.validation.warnings.map(x => ({ ...x, kind: "warn" })),
    ...(b.notes ? String(b.notes).split("\n").filter(Boolean).map(msg => ({ code: "note", msg, kind: "warn" })) : []),
  ];
  $("warnings").replaceChildren(issues.length
    ? el("ul", {}, ...issues.map(i => el("li", { class: i.kind === "warn" ? "warn" : "" }, el("code", { text: i.code }), i.msg)))
    : el("p", { class: "hint", text: b.validation.ok ? "Valid build — 330 points, all requirements met." : "No details." }));

  // guide
  const phases = [["pre", "Pre-shrine"], ["shrine", "Shrine"], ["post", "Post-shrine"]];
  $("guide").replaceChildren(...phases.map(([key, label]) => {
    const steps = b.guide.filter(g => g.phase === key);
    return el("div", { class: "phase" }, el("h4", { text: label }),
      steps.length
        ? el("ol", {}, ...steps.map(g => el("li", {}, g.step,
            g.detail ? el("span", { class: "unlocks", text: g.detail }) : null,
            g.unlocks?.length ? el("span", { class: "unlocks", text: `Unlocks: ${g.unlocks.join(", ")}` }) : null)))
        : el("p", { class: "hint", text: key === "shrine" && !b.shrine ? "No Shrine of Order." : "—" }));
  }));

  // stats
  const table = $("stats-table");
  const hasPre = b.shrine && b.preShrine;
  table.replaceChildren(
    el("thead", {}, el("tr", {}, el("th", { text: "Stat" }), hasPre ? el("th", { class: "num", text: "Pre-shrine" }) : null, el("th", { class: "num", text: "Final" }))),
    el("tbody", {}, ...E.ALL_STATS.map(s => el("tr", { class: (b.final[s] ?? 0) === 0 && (b.preShrine?.[s] ?? 0) === 0 ? "zero" : "" },
      el("td", { text: fmtStat(s) }),
      hasPre ? el("td", { class: "num", text: b.preShrine[s] ?? 0 }) : null,
      el("td", { class: "num", text: b.final[s] ?? 0 })))));
  const figs = [["Points", `${E.pointsSpent(b.final)} / ${E.TOTAL_POINTS}`], ["Power", E.powerFor(b.final)]];
  if (hasPre) figs.push(["Shrine at power", b.shrinePower ?? E.powerFor(b.preShrine)]);
  $("figures").replaceChildren(...figs.map(([k, v]) => el("span", {}, `${k} `, el("b", { text: v }))));

  // talents - the builder's shared card budget: counting talents <= 52 + (12 - obtained mantras) * 2
  const bud = b.budget;
  $("talent-count").textContent = bud ? `${bud.counting} / ${bud.cap}` : "";
  $("talent-hint").textContent = bud
    ? `${bud.counting} talent picks of ${bud.cap} (${bud.mantras} obtained mantra${bud.mantras === 1 ? "" : "s"} cost 2 picks each; tier, origin and gear talents are free). ${b.talents.length - bud.counting} free talents included.`
    : "";
  const groups = b.talentGroups ?? { core: b.talents, recommended: [], choose: {} };
  const tal = $("talents"); tal.replaceChildren();
  const pills = (names, cls = "") => el("div", { class: "pills" }, ...names.map(n => el("span", { class: `pill ${cls}`, text: n })));
  if (groups.core?.length) tal.append(el("h4", { text: `Core (${groups.core.length})` }), pills(groups.core));
  if (groups.recommended?.length) tal.append(el("h4", { text: `Recommended (${groups.recommended.length})` }), pills(groups.recommended, "rec"));
  for (const [label, opts] of Object.entries(groups.choose ?? {})) tal.append(el("h4", { text: `Choose: ${label}` }), pills(opts, "rec"));
  if (!tal.children.length) tal.append(el("p", { class: "hint", text: "No talents." }));

  // mantras - equipped loadout (fills the slots), swap pool, and free oath/monster mantras
  const mg = b.mantraGroups;
  const man = $("mantras"); man.replaceChildren();
  const gemOf = m => { const g = b.mantraMods?.[m]?.gem; return g && g !== "None" ? el("span", { class: "gem", text: g }) : null; };
  if (mg) {
    const slotTotal = Object.values(mg.slots ?? {}).reduce((x, y) => x + y, 0);
    $("mantra-count").textContent = `${mg.equipped.length} equipped / ${slotTotal} slots`;
    if (mg.equipped.length) man.append(el("h4", { text: `Equipped (${mg.equipped.length} of ${slotTotal} slots)` }),
      el("div", { class: "pills" }, ...mg.equipped.map(e => el("span", { class: "pill" }, e.name, gemOf(e.name), el("span", { class: "slot", text: e.slot })))));
    if (mg.extra.length) man.append(el("h4", { text: `Also obtained - swap in as needed (${mg.extra.length})` }),
      el("div", { class: "pills" }, ...mg.extra.map(m => el("span", { class: "pill rec" }, m, gemOf(m)))));
    if (mg.free.length) man.append(el("h4", { text: `Oath / monster mantras - no slot or pick cost (${mg.free.length})` }),
      el("div", { class: "pills" }, ...mg.free.map(m => el("span", { class: "pill free" }, m, gemOf(m)))));
    if (!man.children.length) man.append(el("p", { class: "hint", text: b.oath === "Silentheart" ? "No mantras — Silentheart forgoes them." : "No mantras." }));
  } else {
    $("mantra-count").textContent = "";
    man.append(el("div", { class: "pills" }, ...b.mantras.map(m => el("span", { class: "pill" }, m, gemOf(m)))));
  }

  // gear & path
  const kv = [["Weapon", b.weapon || "—"], ["Enchant", b.enchant || "—"], ["Outfit", b.outfit || "—"],
    ["Oath", b.oath || "None"], ["Origin", b.origin || "—"], ["Race", b.race || "None"], ["Murmur", b.murmur || "None"], ["Bell", b.bell || "None"],
    ["Boons", (b.boons ?? []).join(", ") || "—"], ["Flaws", (b.flaws ?? []).join(", ") || "—"],
    ["Traits", Object.entries(b.traits ?? {}).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(", ") || "—"]];
  for (const [slot, item] of Object.entries(b.equipment ?? {})) {
    const names = (Array.isArray(item) ? item : [item]).filter(Boolean).map(x => x.name).filter(Boolean);
    if (names.length) kv.push([slot, names.join(", ")]);
  }
  $("gear").replaceChildren(...kv.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]));

  $("build-code").value = JSON.stringify(E.draftEnvelope(b));
}

// ---------- actions ----------
let toastTimer;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}
async function copyToClipboard() {
  const code = $("build-code").value;
  try { await navigator.clipboard.writeText(code); return true; }
  catch {
    const d = $("build-code").closest("details"); if (d) d.open = true;
    $("build-code").focus(); $("build-code").select();
    return false;
  }
}
async function copyCode() {
  if (!state.build) return;
  toast(await copyToClipboard() ? "Build code copied" : "Clipboard blocked — the code is selected below, copy it by hand");
}
// Copies the code, then opens the builder in a new tab; the bookmark does the rest there.
async function sendToBuilder() {
  if (!state.build) return;
  const copied = await copyToClipboard();
  window.open("https://deepwoken.co/builder", "_blank", "noopener");
  toast(copied ? "Copied — now click the ⚔ Import bookmark in the builder tab" : "Clipboard blocked — copy the code below, then paste it when the bookmark asks");
}
const SETUP_KEY = "forge.setupDone";
function setupDone(done) {
  $("setup-step").classList.toggle("collapsed", done);
  $("setup-done").checked = done;
  try { localStorage.setItem(SETUP_KEY, done ? "1" : ""); } catch { /* per-viewer convenience only */ }
}

// ---------- capabilities: Refine with AI (sample), Library (db) ----------
// `claude.use(name)` resolves the namespace or null (not served / not granted / failed) - the
// page must work with both null: the buttons stay hidden and nothing throws.
async function useCapability(name) {
  try {
    if (!globalThis.claude?.use) return null;
    return (await globalThis.claude.use(name)) ?? null;
  } catch { return null; }
}

// Top-n talents/mantras the build does not have yet but could take right now - the vocabulary
// Claude may swap in (it must not invent names). Ranked by corpus-wide frequency (each
// archetype's frequency list weighted by its member count), since the picker has usually already
// taken everything on the build's own archetype list.
let _globalFreq = null;
function globalFreq() {
  if (_globalFreq) return _globalFreq;
  const tal = new Map(), man = new Map();
  for (const a of ARCH.archetypes) {
    for (const [t, f] of a.talent_freq) tal.set(t, (tal.get(t) ?? 0) + f * a.members);
    for (const [m, f] of a.mantra_freq) man.set(m, (man.get(m) ?? 0) + f * a.members);
  }
  const rank = m => [...m.entries()].sort((x, y) => y[1] - x[1]).map(([n]) => n);
  return (_globalFreq = { talents: rank(tal), mantras: rank(man) });
}
function candidateTalents(build, n) {
  const have = new Set(build.talents);
  return globalFreq().talents.filter(t => !have.has(t) && GAME.talents[t] && !isPathEntry(t) && E.talentObtainable(t, build, GAME).ok).slice(0, n);
}
function candidateMantras(build, n) {
  const have = new Set(build.mantras);
  return globalFreq().mantras.filter(m => !have.has(m) && GAME.mantras[m] && E.meetsStats(build.final, GAME.mantras[m].reqs ?? {})
    && (!GAME.mantras[m].attunement || (build.final[GAME.mantras[m].attunement] ?? 0) > 0)).slice(0, n);
}

// Re-derive everything assemble() derives from a core after talents/mantras changed.
function rescore(build) {
  const core = { ...build };
  const a = archetypeOf(build);
  core.validation = E.validate(core, GAME);
  if (a) { const { score, breakdown } = E.scoreBuild(core, a, GAME); core.meta_score = score; core.score_breakdown = breakdown; }
  core.draft = E.toDraft(core);
  return core;
}

function applySwap(build, swap) {
  if (isPathEntry(swap.remove) || isPathEntry(swap.add)) return null; // oath/murmur are path choices, not swappable talents
  const c = { ...build, talents: [...build.talents], mantras: [...build.mantras], mantraMods: { ...(build.mantraMods ?? {}) } };
  const list = swap.kind === "mantra" ? c.mantras : c.talents;
  if (swap.remove) { const i = list.indexOf(swap.remove); if (i < 0) return null; list.splice(i, 1); if (swap.kind === "mantra") delete c.mantraMods[swap.remove]; }
  if (swap.add) {
    if (list.includes(swap.add)) return null;
    if (swap.kind === "mantra" ? !GAME.mantras[swap.add] : !GAME.talents[swap.add]) return null;
    list.push(swap.add);
    if (swap.kind === "mantra") c.mantraMods[swap.add] = { gem: "None", spark: "None" };
  }
  return c;
}

async function refine() {
  const build = state.build, req = state.req, sample = state.sample;
  if (!build || !sample) return;
  const btn = $("ai-refine"); btn.disabled = true;
  const section = $("refine-section"), status = $("refine-status");
  section.hidden = false; status.hidden = false; status.textContent = "Thinking…";
  $("playstyle").textContent = ""; $("refine-swaps").replaceChildren();
  try {
    const slice = {
      talents: Object.fromEntries([...build.talents, ...candidateTalents(build, 60)].filter(t => GAME.talents[t]).map(t => [t, { reqs: GAME.talents[t].reqs, desc: GAME.talents[t].desc }])),
      mantras: Object.fromEntries([...build.mantras, ...candidateMantras(build, 30)].filter(m => GAME.mantras[m]).map(m => [m, { reqs: GAME.mantras[m].reqs, category: GAME.mantras[m].category, desc: GAME.mantras[m].desc }])),
    };
    const prompt = `You are refining a Deepwoken build. Only propose swaps using names present in the provided lists. Return JSON {"swaps":[{"kind":"talent"|"mantra","remove":string|null,"add":string|null,"reason":string}],"playstyle":string}. Max 6 swaps. Player's request: ${req?.free_text || "(none - just tighten the build)"}\nBuild: ${JSON.stringify({ final: build.final, talents: build.talents, mantras: build.mantras, oath: build.oath, origin: build.origin })}\nAvailable: ${JSON.stringify(slice)}`;
    const res = await sample.json(prompt, { modelTier: "quick" });
    const swaps = Array.isArray(res?.swaps) ? res.swaps.slice(0, 6) : [];
    let current = build; const applied = [], rejected = [];
    for (const sw of swaps) {
      if (!sw || (sw.kind !== "talent" && sw.kind !== "mantra") || (!sw.remove && !sw.add)) continue;
      const next = applySwap(current, sw);
      const scored = next && rescore(next);
      if (scored && scored.validation.ok) { current = scored; applied.push(sw); }
      else rejected.push({ ...sw, why: next ? (scored.validation.errors[0]?.msg ?? "invalid") : "name not in build / unknown" });
    }
    state.build = current;
    render(current);
    section.hidden = false; status.hidden = true;
    $("playstyle").textContent = typeof res?.playstyle === "string" ? res.playstyle : "";
    const line = (sw, cls, tail) => el("li", { class: cls }, el("code", { text: sw.kind }),
      `${sw.remove ? `− ${sw.remove}` : ""}${sw.remove && sw.add ? " → " : ""}${sw.add ? `+ ${sw.add}` : ""}`, tail ? ` — ${tail}` : "");
    $("refine-swaps").replaceChildren(el("ul", {},
      ...applied.map(sw => line(sw, "", sw.reason)),
      ...rejected.map(sw => line(sw, "warn", `rejected: ${sw.why}`))));
    if (!applied.length && !rejected.length) $("refine-swaps").append(el("p", { class: "hint", text: "No swaps proposed." }));
    toast(`Refined: ${applied.length} swap${applied.length === 1 ? "" : "s"} applied${rejected.length ? `, ${rejected.length} rejected` : ""}`);
  } catch (e) {
    status.hidden = true;
    const code = e?.code;
    if (code === "not_granted" || code === "sampling_disabled" || code === "not_declared" || code === "capability_disabled" || code === "capability_removed") {
      btn.hidden = true; section.hidden = true;
    } else if (code === "rate_limited") toast("Claude is busy — try again in a minute");
    else if (code === "cancelled") { /* nothing to say */ }
    else toast(`Refine failed: ${e?.message ?? e}`);
  } finally { btn.disabled = false; }
}

// Library: builds/<id> documents {name, author, request, build (without draft), created}.
function stripBuild(b) { const { draft, ...rest } = b; return rest; }

async function saveToLibrary() {
  const db = state.db, build = state.build; if (!db || !build) return;
  const author = (prompt("Your name for the library entry:", "") ?? "").trim();
  if (!author) return;
  const btn = $("save-library"); btn.disabled = true;
  try {
    await db.collection("builds").doc(crypto.randomUUID()).set({
      name: build.name, author, role: build.based_on?.archetype?.split("-")[0] ?? "", score: build.meta_score,
      request: state.req ?? {}, build: JSON.parse(JSON.stringify(stripBuild(build))), created: Date.now(),
    });
    toast("Saved to the library");
  } catch (e) {
    const code = e?.code;
    if (code === "quota_exceeded") toast("Library is full — delete some builds first");
    else if (code === "not_granted" || code === "revoked" || code === "capability_disabled" || code === "capability_removed") { btn.hidden = true; $("library-tab").hidden = true; }
    else toast(`Save failed: ${e?.message ?? e}`);
  } finally { btn.disabled = false; }
}

function renderLibrary(snap) {
  const cards = $("library-cards"); cards.replaceChildren();
  $("library-empty").hidden = !snap.empty;
  for (const d of snap.docs) {
    const v = d.data() ?? {};
    const score = Number(v.score ?? v.build?.meta_score ?? 0);
    cards.append(el("div", { class: "card" },
      el("div", { class: "name", text: String(v.name ?? "Untitled") }),
      el("div", { class: "meta" },
        el("span", { class: `badge ${score >= 70 ? "ok" : score >= 50 ? "warn" : "bad"}`, text: `meta ${score}` }),
        el("span", { text: String(v.role ?? "") }),
        el("span", { text: v.author ? `by ${v.author}` : "" }),
        el("span", { text: v.created ? new Date(Number(v.created)).toLocaleDateString() : "" })),
      el("button", { type: "button", class: "ghost", text: "Load", onclick: () => {
        if (!v.build) return;
        const b = rescore(JSON.parse(JSON.stringify(v.build)));
        state.build = b; state.req = v.request ?? state.req; state.auto = false;
        $("refine-section").hidden = true;
        render(b);
        toast(`Loaded ${b.name}`);
      } })));
  }
}

function toggleLibrary() {
  const section = $("library-section"), tab = $("library-tab");
  section.hidden = !section.hidden; tab.classList.toggle("on", !section.hidden);
  if (!section.hidden && !state.libraryUnsub && state.db) {
    // Subscribe once; the snapshot re-renders the cards on every change.
    state.libraryUnsub = state.db.collection("builds").orderBy("created", "desc").limit(50)
      .onSnapshot(renderLibrary, e => { toast(`Library unavailable: ${e?.message ?? e?.code}`); state.libraryUnsub = null; });
  }
}

async function wireCapabilities() {
  const [sample, db] = await Promise.all([useCapability("sample"), useCapability("db")]);
  state.sample = sample; state.db = db;
  if (sample) { $("ai-refine").hidden = false; $("ai-refine").addEventListener("click", refine); }
  if (db) {
    $("save-library").hidden = false; $("library-tab").hidden = false;
    $("save-library").addEventListener("click", saveToLibrary);
    $("library-tab").addEventListener("click", toggleLibrary);
  }
}

// ---------- boot ----------
function boot() {
  fillSelect("oath", Object.keys(GAME.oaths));
  fillSelect("origin", GAME.origins ?? []);
  fillSelect("race", Object.keys(GAME.races));
  for (const n of Object.keys(GAME.talents)) if (!n.startsWith("Oath: ") && !n.startsWith("Murmur: ")) $("talent-list").append(el("option", { value: n }));
  for (const n of Object.keys(GAME.mantras)) $("mantra-list").append(el("option", { value: n }));
  attunementChips("att-include", state.include, "att-exclude", state.exclude);
  attunementChips("att-exclude", state.exclude, "att-include", state.include);
  chipList("must-talents", "talent", state.mustTalents);
  chipList("avoid-talents", "talent", state.avoidTalents);
  chipList("must-mantras", "mantra", state.mustMantras);
  chipList("avoid-mantras", "mantra", state.avoidMantras);
  weaponDatalist();

  $("weapon-type").addEventListener("change", () => { $("weapon").value = ""; weaponDatalist(); state.auto = false; });
  $("role").addEventListener("change", () => {
    for (const id of ["oath", "origin", "race", "weapon-type"]) $(id).value = "";
    $("weapon").value = ""; weaponDatalist(); state.auto = false;
  });
  for (const id of ["oath", "origin", "race", "weapon", "shrine", "multifaceted", "attunementless"]) $(id).addEventListener("change", () => { state.auto = false; });
  $("request-form").addEventListener("submit", e => { e.preventDefault(); generate(); });
  $("copy-code").addEventListener("click", copyCode);
  $("send-builder").addEventListener("click", sendToBuilder);
  const bm = $("bookmarklet");
  bm.href = "javascript:" + encodeURIComponent(BOOKMARKLET_SRC);
  bm.addEventListener("click", e => { e.preventDefault(); toast("Don't click it here — drag it up onto your bookmarks bar"); });
  $("setup-done").addEventListener("change", e => setupDone(e.target.checked));
  let done = false; try { done = localStorage.getItem(SETUP_KEY) === "1"; } catch { /* ignore */ }
  setupDone(done);

  // The page at rest shows a real build: the most-viewed archetype's role, generated once.
  const top = [...ARCH.archetypes].sort((a, b) => b.views_total - a.views_total)[0];
  if (top) $("role").value = top.role;
  state.auto = true;
  generate();
  wireCapabilities(); // resolves later (or null); the page is already usable
}

try {
  boot();
} catch (e) {
  console.error(e);
  showError(`Deepwoken Forge could not start: ${e.message}`);
  for (const c of document.querySelectorAll("#request-form input, #request-form select, #request-form textarea, #request-form button")) c.disabled = true;
}
