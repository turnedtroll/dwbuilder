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

const BOOKMARKLET_SRC = `(()=>{if(location.hostname!=='deepwoken.co'){alert('Open https://deepwoken.co/builder first, then click this bookmark.');return;}
const s=prompt('Paste the build code from dwbuilder:');if(!s)return;
try{const env=JSON.parse(s);if(env.version!==1||!env.build)throw 0;localStorage.setItem('_dwb.draft.v1.new',JSON.stringify(env));location.href='/builder';}
catch(e){alert('That did not look like a dwbuilder build code.');}})();`;

const state = {
  include: new Set(), exclude: new Set(),
  mustTalents: [], avoidTalents: [], mustMantras: [], avoidMantras: [],
  build: null, auto: true,
};

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
    const build = E.assemble(readRequest(), ARCH.archetypes, GAME);
    state.build = build;
    showError("");
    render(build);
  } catch (e) {
    console.error(e);
    showError(`Could not forge that build: ${e.message}`);
  }
}

// ---------- render ----------
const fmtStat = s => s;
function render(b) {
  $("build-role").textContent = b.based_on?.archetype?.split("-")[0] ?? "";
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

  // talents
  const groups = b.talentGroups ?? { core: b.talents, recommended: [], choose: {} };
  const tal = $("talents"); tal.replaceChildren();
  const pills = (names, cls = "") => el("div", { class: "pills" }, ...names.map(n => el("span", { class: `pill ${cls}`, text: n })));
  if (groups.core?.length) tal.append(el("h4", { text: `Core (${groups.core.length})` }), pills(groups.core));
  if (groups.recommended?.length) tal.append(el("h4", { text: `Recommended (${groups.recommended.length})` }), pills(groups.recommended, "rec"));
  for (const [label, opts] of Object.entries(groups.choose ?? {})) tal.append(el("h4", { text: `Choose: ${label}` }), pills(opts, "rec"));
  if (!tal.children.length) tal.append(el("p", { class: "hint", text: "No talents." }));

  // mantras
  $("mantras").replaceChildren(...(b.mantras.length ? b.mantras.map(m => {
    const gem = b.mantraMods?.[m]?.gem;
    return el("span", { class: "pill" }, m, gem && gem !== "None" ? el("span", { class: "gem", text: gem }) : null);
  }) : [el("p", { class: "hint", text: b.oath === "Silentheart" ? "No mantras — Silentheart forgoes them." : "No mantras." })]));

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
async function copyCode() {
  if (!state.build) return;
  const code = $("build-code").value;
  try {
    await navigator.clipboard.writeText(code);
    toast("Copied — now run the bookmarklet on deepwoken.co/builder");
  } catch {
    $("build-code").focus(); $("build-code").select();
    toast("Clipboard blocked — the code is selected below, copy it by hand");
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
  const bm = $("bookmarklet");
  bm.href = "javascript:" + encodeURIComponent(BOOKMARKLET_SRC);
  bm.addEventListener("click", e => { e.preventDefault(); toast("Drag this link to your bookmarks bar, then use it on deepwoken.co/builder"); });

  // The page at rest shows a real build: the most-viewed archetype's role, generated once.
  const top = [...ARCH.archetypes].sort((a, b) => b.views_total - a.views_total)[0];
  if (top) $("role").value = top.role;
  state.auto = true;
  generate();
}

try {
  boot();
} catch (e) {
  console.error(e);
  showError(`Deepwoken Forge could not start: ${e.message}`);
  for (const c of document.querySelectorAll("#request-form input, #request-form select, #request-form textarea, #request-form button")) c.disabled = true;
}
