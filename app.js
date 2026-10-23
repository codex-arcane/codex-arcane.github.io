const $ = (s) => document.querySelector(s);
const PAGE = 60;
const CFG = window.GEAR_CONFIG || {};
const remote = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);
const FAV = { id: "favorites", name: "Favorites", images: true, count: 0, files: [] };  // pseudo category: every starred item
const state = { cats: [], cat: null, cache: {}, items: [], found: [], q: "", type: "", stat: "", sort: "name", dye: "", shown: PAGE, view: "grid", favOnly: false, groups: [], group: null };
// Settings and favorites. Guests: saved in this browser. Signed in: also saved to the account.
const LS_KEY = "gear-prefs", DEFAULTS = { view: "grid", favOnly: false, favs: [] };
const prefs = (() => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS_KEY) || "{}") }; } catch { return { ...DEFAULTS }; } })();
state.view = prefs.view; state.favOnly = prefs.favOnly;
const sb = remote && window.supabase ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey) : null;
let user = null, saveTimer, syncedFor = null;
// Remember which category each item came from, so items can be shown outside their own category (search, favorites, compare).
const itemCat = new WeakMap();
const catOf = (i) => itemCat.get(i) || state.cat;
const byName = (a, b) => (a.name || "").localeCompare(b.name || "");
function setCache(cat, items) {
  items.sort(byName);
  for (const i of items) itemCat.set(i, cat);
  return (state.cache[cat.id] = items);
}
async function loadItems(cat) {
  if (!state.cache[cat.id]) {
    const lists = await Promise.all(cat.files.map((f) => fetch(f).then((r) => r.json())));
    setCache(cat, lists.flat());
    rebuildNameIndex(); // keep drop/material links up to date as categories load
  }
  return state.cache[cat.id];
}
const loadAll = () => Promise.all(state.cats.map(loadItems)).catch(() => {});
const findItem = (catId, itemId) => (state.cache[catId] || []).find((i) => String(i.id) === String(itemId));

const favKey = (i, cat = catOf(i)) => `${cat.id}:${i.id}`;
const isFav = (i, cat = catOf(i)) => prefs.favs.includes(favKey(i, cat));
function toggleFav(i, cat = catOf(i)) {
  const k = favKey(i, cat);
  prefs.favs = isFav(i, cat) ? prefs.favs.filter((x) => x !== k) : [...prefs.favs, k];
  savePrefs();
}
function savePrefs() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch {}
  if (sb && user) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => sb.from("user_settings").upsert({ user_id: user.id, data: prefs, updated_at: new Date().toISOString() }), 800);
  }
}
function applyPrefs() {
  state.view = prefs.view; state.favOnly = prefs.favOnly;
  $("#v-grid").setAttribute("aria-pressed", prefs.view === "grid");
  $("#v-list").setAttribute("aria-pressed", prefs.view === "list");
  $("#favonly").checked = prefs.favOnly;
}


const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Icon paths may be Windows-style, so only the file name is used.
function imgSrc(cat, item) {
  const file = (item.image_file || item.image_url || "").split(/[\\/]/).pop();
  if (!file || !cat.images) return "";
  return remote
    ? `${CFG.supabaseUrl}/storage/v1/object/public/site/images/${encodeURIComponent(file)}`
    : `${cat.images}/${encodeURIComponent(file)}`;
}

// Categories uploaded from the owner panel: one data/<category>.json file each in Supabase Storage.
async function loadRemote() {
  const base = `${CFG.supabaseUrl}/storage/v1`;
  const res = await fetch(`${base}/object/list/site`, {
    method: "POST",
    headers: { apikey: CFG.supabaseAnonKey, Authorization: `Bearer ${CFG.supabaseAnonKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: "data", limit: 200 }),
  });
  if (!res.ok) throw new Error(res.status);
  const files = (await res.json()).filter((f) => f.name.endsWith(".json"));
  const cats = await Promise.all(files.map(async (f) => {
    const id = f.name.replace(/\.json$/, "");
    const url = `${base}/object/public/site/data/${encodeURIComponent(f.name)}`;
    const items = await fetch(url, { cache: "no-cache" }).then((r) => r.json());
    const cat = { id, name: id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), count: items.length, files: [url], images: true };
    setCache(cat, items);
    return cat;
  }));
  let structure = { groups: [] };
  try {
    const r = await fetch(`${base}/object/public/site/config/structure.json`, { cache: "no-cache" });
    if (r.ok) structure = await r.json();
  } catch {}
  const byId = Object.fromEntries(cats.map((c) => [c.id, c]));
  const used = new Set();
  const groups = (structure.groups || []).map((g) => ({
    id: g.id, name: g.name,
    cats: (g.categories || []).filter((c) => byId[c.id] && !used.has(c.id)).map((c) => {
      used.add(c.id);
      byId[c.id].name = c.name || byId[c.id].name;
      return byId[c.id];
    }),
  }));
  const loose = cats.filter((c) => !used.has(c.id));
  if (loose.length) groups.push({ id: "unsorted", name: "Unsorted", cats: loose });
  return { cats: groups.flatMap((g) => g.cats), groups };
}

function empty(msg) {
  $("#items").className = "";
  $("#items").innerHTML = `<p class="empty">${esc(msg)}</p>`;
}

async function boot() {
  try {
    if (remote) {
      Object.assign(state, await loadRemote());
    } else {
      const res = await fetch("data/manifest.json");
      if (!res.ok) throw new Error(res.status);
      state.cats = (await res.json()).categories;
      state.groups = [{ id: "all", name: "All", cats: state.cats }];
    }
  } catch {
    return empty(remote
      ? "Couldn't load categories. Check config.js and that supabase-setup.sql was run."
      : "Couldn't load data/manifest.json. Run scripts/build_manifest.py, and open the site through a web server (not by double-clicking the file).");
  }
  if (!state.cats.length) return empty(remote
    ? "No categories yet. Sign in at admin.html and upload a JSON file."
    : "No categories yet. Add a folder with a .json file inside data/ and rebuild the manifest.");
  // Warm the item cache so cross-links (drops → monsters, recipe materials → items) resolve.
  // Local: wait so the first open already has the full index. Remote: background so first paint stays fast.
  if (!remote) {
    await loadAll();
    rebuildNameIndex();
  } else {
    loadAll().then(() => rebuildNameIndex()).catch(() => {});
  }
  renderMenu();
  addEventListener("hashchange", route);
  route();
}

// ---- Links: #category, #category/itemid, #favorites ----
const parseHash = () => {
  let h = location.hash.slice(1);
  try { h = decodeURIComponent(h); } catch {}
  const i = h.indexOf("/");
  return i < 0 ? { cat: h, item: "" } : { cat: h.slice(0, i), item: h.slice(i + 1) };
};
function setHash(cat, item = "") {
  const h = cat ? `#${encodeURIComponent(cat)}${item ? "/" + encodeURIComponent(item) : ""}` : "";
  if (location.hash === h || (!h && !location.hash)) return;
  if (h) location.hash = h;                       // fires hashchange -> route()
  else { history.pushState(null, "", location.pathname + location.search); route(); }
}
let openItem = null;
async function route() {
  const { cat, item } = parseHash();
  if (!cat) { if (state.cat || !$("#items .home")) showHome(); if ($("#dlg").open) $("#dlg").close(); return; }
  if (!state.cat || state.cat.id !== cat) await pick(cat, { hash: false });
  if (!state.cat || state.cat.id !== cat) return;   // unknown category: pick() showed the home page
  if (item) {
    let c = state.cat, id = item;
    if (cat === FAV.id) { const k = item.indexOf(":"); c = state.cats.find((x) => x.id === item.slice(0, k)); id = item.slice(k + 1); }
    const it = c && findItem(c.id, id);
    if (it && openItem?.item !== it) detail(it, c, { hash: false });
  } else if ($("#dlg").open) $("#dlg").close();
}

// ---- Menu: the 3-line button opens a vertical list. Groups (like Equipment) expand to show their categories. ----
const openGroups = new Set();
const menuBtn = $("#menu-btn"), drawer = $("#drawer");

function renderMenu() {
  const top = `<div class="dg-top">
      <button type="button" data-nav="home">Home</button>
      <button type="button" data-nav="favorites">\u2605 Favorites<small>${prefs.favs.length}</small></button>
    </div>`;
  $("#menu-list").innerHTML = top + state.groups.map((g) => {
    const open = openGroups.has(g.id);
    const total = g.cats.reduce((n, c) => n + c.count, 0);
    return `<div class="dg">
      <button class="dg-head" type="button" data-g="${esc(g.id)}" aria-expanded="${open}">
        <svg class="chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="dg-name">${esc(g.name)}</span><small>${total}</small>
      </button>
      <ul class="dg-list"${open ? "" : " hidden"}>${g.cats.length
        ? g.cats.map((c) => `<li><button type="button" data-id="${esc(c.id)}" aria-current="${c === state.cat}">${esc(c.name)}<small>${c.count}</small></button></li>`).join("")
        : `<li class="muted dg-empty">No categories in this group yet.</li>`}</ul>
    </div>`;
  }).join("");
}

function openMenu() {
  renderMenu();
  drawer.classList.add("open");
  $("#scrim").hidden = false;
  document.body.classList.add("menu-open");
  menuBtn.setAttribute("aria-expanded", "true");
  $("#menu-close").focus();
}
function closeMenu(returnFocus = true) {
  if (!drawer.classList.contains("open")) return;
  openGroups.clear();  // every group starts closed the next time the menu opens
  drawer.classList.remove("open");
  $("#scrim").hidden = true;
  document.body.classList.remove("menu-open");
  menuBtn.setAttribute("aria-expanded", "false");
  if (returnFocus) menuBtn.focus();
}
menuBtn.onclick = () => (drawer.classList.contains("open") ? closeMenu() : openMenu());
$("#menu-close").onclick = () => closeMenu();
$("#scrim").onclick = () => closeMenu();
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
$("#menu-list").onclick = (e) => {
  const nav = e.target.closest("[data-nav]");
  if (nav) { closeMenu(false); nav.dataset.nav === "home" ? setHash("") : pick(FAV.id); return; }
  const head = e.target.closest(".dg-head");
  if (head) {  // press a group to expand or collapse its categories
    const id = head.dataset.g, open = head.getAttribute("aria-expanded") !== "true";
    open ? openGroups.add(id) : openGroups.delete(id);
    head.setAttribute("aria-expanded", open);
    head.nextElementSibling.hidden = !open;
    return;
  }
  const b = e.target.closest("button[data-id]");
  if (b) { closeMenu(false); pick(b.dataset.id); }
};
document.querySelectorAll(".brand, .wordmark a").forEach((a) => { a.onclick = (e) => { e.preventDefault(); closeMenu(false); setHash(""); window.scrollTo(0, 0); }; });
for (const id of ["#dlg", "#cmp"]) {  // pressing the dark area around a popup closes it
  $(id).addEventListener("click", (e) => {
    if (e.target !== e.currentTarget) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.currentTarget.close();
  });
}

// Header: stays at the top. On phones it slides away while scrolling down and comes back when scrolling up.
{
  const header = $(".top");
  let lastY = scrollY, ticking = false;
  const busy = () => document.activeElement === $("#gs") || !$("#gs-results").hidden || drawer.classList.contains("open");
  addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const y = scrollY;
      header.classList.toggle("hide", innerWidth < 760 && y > lastY && y > 140 && !busy());
      lastY = y;
    });
  }, { passive: true });
}

function updateCrumb() {
  const c = $("#crumb");
  c.hidden = !state.cat;
  document.title = state.cat ? `${state.cat.name} - Codex Arcane` : "Codex Arcane";
  if (!state.cat) return;
  const g = state.group;
  c.textContent = state.cat === FAV ? "Favorites" : remote && g ? `${g.name} \u203A ${state.cat.name}` : state.cat.name;
}

// Home page: one card per higher category (like Equipment) with how many items it holds. Pressing one opens the menu on it.
function renderHome() {
  $("#items").className = "home";
  $("#items").innerHTML = `<div class="hg-grid">${state.groups.filter((g) => g.cats.length).map((g) => {
    const n = g.cats.reduce((t, c) => t + c.count, 0);
    return `<button class="hg-card" type="button" data-g="${esc(g.id)}"><strong>${esc(g.name)}</strong><span>${n.toLocaleString()} ${n === 1 ? "item" : "items"}</span></button>`;
  }).join("")}</div>`;
}

function showHome() {
  state.cat = null; state.group = null; state.items = []; state.found = [];
  $(".tools").hidden = true;
  $("#more").hidden = true;
  updateCrumb();
  renderHome();
}

async function pick(id, { hash = true } = {}) {
  if (id === FAV.id) return showFavorites({ hash });
  const cat = state.cats.find((c) => c.id === id);
  if (!cat) return showHome();
  state.cat = cat;
  state.group = state.groups.find((g) => g.cats.includes(cat));
  $(".tools").hidden = false;
  $(".chk").hidden = false;
  prefs.cat = cat.id; savePrefs();
  if (hash) setHash(cat.id);
  updateCrumb();
  const items = await loadItems(cat);
  if (state.cat !== cat) return;  // the visitor went somewhere else while this was loading
  startList(items);
}

const favItems = () => prefs.favs.map((k) => { const i = k.indexOf(":"); return findItem(k.slice(0, i), k.slice(i + 1)); }).filter(Boolean).sort(byName);
async function showFavorites({ hash = true } = {}) {
  state.cat = FAV; state.group = null;
  $(".tools").hidden = false;
  $(".chk").hidden = true;
  if (hash) setHash(FAV.id);
  updateCrumb();
  await loadAll();
  if (state.cat !== FAV) return;
  startList(favItems());
}

// Starting a new list (category or favorites): reset search, sort and filters.
function startList(items) {
  state.items = items;
  state.q = ""; state.type = ""; state.stat = ""; state.sort = "name"; state.dye = ""; state.shown = PAGE;
  $("#q").value = ""; $("#dye").value = ""; $("#sort").value = "name";
  const types = [...new Set(items.flatMap((i) => i.obtain_types || []))].sort();
  $("#type").innerHTML = `<option value="">All sources</option>` + types.map((t) => `<option>${esc(t)}</option>`).join("");
  // Each kind of stat that has a number (ATK +12 -> ATK), once, in alphabetical order. The most common one is the default for sorting.
  const counts = new Map();
  for (const i of items) for (const [n, v] of statsOf(i)) if (v !== null) counts.set(n, (counts.get(n) || 0) + 1);
  statOpts = [...counts.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).map((name) => ({ name }));
  statDefault = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || "";
  $("#stat-label").textContent = "Any stat"; closeStat();
  const dyes = [...new Set(items.flatMap((i) => (i.dyes || []).map(dyeCode)))].sort().slice(0, 600);
  $("#dye-list").innerHTML = dyes.map((d) => `<option value="${esc(d)}">`).join("");
  $(".dyef").hidden = !dyes.length;
  setAdv(false);
  updateAdvDot();
  render();
  window.scrollTo(0, 0);
}

// ---- Stats like "ATK +12" or "DEF 5%" are split into a name and a number so they can be sorted and compared ----
const statCache = new WeakMap();
function parseStat(str) {
  const s = String(str).trim();
  let m = /^(.*?)[\s:=]*([+-]?\d+(?:[.,]\d+)?)\s*(%?)\s*$/.exec(s);
  if (m && m[1]) return { name: (m[1] + (m[3] ? " %" : "")).trim(), val: parseFloat(m[2].replace(",", ".")) };
  m = /^([+-]?\d+(?:[.,]\d+)?)\s*(%?)\s+(.+)$/.exec(s);
  if (m) return { name: (m[3] + (m[2] ? " %" : "")).trim(), val: parseFloat(m[1].replace(",", ".")) };
  return { name: s, val: null };
}
function statsOf(i) {  // Map: stat name -> number (or null when the stat has no number)
  let m = statCache.get(i);
  if (!m) {
    m = new Map();
    for (const s of i.stats || []) { const p = parseStat(s); if (!m.has(p.name)) m.set(p.name, p.val); }
    if (i.base_def != null && !m.has("Base DEF")) m.set("Base DEF", Number(i.base_def));
    statCache.set(i, m);
  }
  return m;
}
const statLabel = (n) => n.replace(/ %$/, " (%)");
const dyeCode = (d) => (typeof d === "string" ? d : d.code);

// Dye chips: small colored boxes (Coryn-style). Accepts {code,color}, plain "A30", or "A 42 C".
function readable(hex) { // black or white text, whichever is easier to read on this color
  let h = (hex || "").replace(/^#/, "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  if (h.length !== 6) return "#1b1206";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#1b1206" : "#fff";
}
function chipHtml(code, color) {
  const c = String(code ?? "").trim();
  if (!c) return "";
  const hex = color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : "";
  const style = hex ? ` style="background:${hex};color:${readable(hex)};border-color:${hex}"` : "";
  return `<i class="dye"${style}>${esc(c)}</i>`;
}
function chipsHtml(list) {
  if (!list || !list.length) return "";
  return `<span class="dye-group">${list.map((d) => {
    if (typeof d === "string") return chipHtml(d, "");
    return chipHtml(d.code ?? d, d.color || "");
  }).join("")}</span>`;
}
// Build chips from a drop row: prefer structured dye_chips, else split the dye string.
function dyeCellHtml(row) {
  const chips = row.dye_chips || row.chips;
  if (chips?.length) return chipsHtml(chips);
  const text = String(row.dye || "").trim();
  if (!text) return "";
  // "A 42 C" / "42 B C" → one box per token
  const parts = text.split(/[\s,/|]+/).filter(Boolean);
  return parts.length ? chipsHtml(parts) : chipHtml(text, "");
}
function dyeChips(item) {
  // Only real item-level dyes (objects with colour, or short list). Never dump hundreds of drop codes.
  const list = item.dyes || [];
  if (!list.length) return "";
  const rich = list.filter((d) => typeof d === "object" && d.color);
  if (rich.length) return chipsHtml(rich);
  if (list.length > 12) return ""; // aggregated drop codes — hide on cards
  return chipsHtml(list);
}

function matches(i) {
  if (state.favOnly && state.cat !== FAV && !isFav(i)) return false;
  if (state.type && !(i.obtain_types || []).includes(state.type)) return false;
  if (state.stat && !statsOf(i).has(state.stat)) return false;
  if (state.dye && !(i.dyes || []).some((d) => dyeCode(d).toLowerCase().includes(state.dye))) return false;
  if (!state.q) return true;
  const hay = [i.name, ...(i.stats || []), ...(i.obtain_types || []), i.obtained_from?.text, ...(i.dyes || []).map(dyeCode)].join(" ").toLowerCase();
  return hay.includes(state.q);
}

function sorted(found) {
  if (state.sort === "name-desc") return found.reverse();
  if ((state.sort === "hi" || state.sort === "lo") && state.stat) {
    const dir = state.sort === "hi" ? -1 : 1;
    found.sort((a, b) => {
      const x = statsOf(a).get(state.stat), y = statsOf(b).get(state.stat);
      if (x == null && y == null) return byName(a, b);
      if (x == null) return 1;
      if (y == null) return -1;
      return (x - y) * dir || byName(a, b);
    });
  }
  return found;
}

function slotHtml(i, n) {
  const cat = catOf(i);
  const src = imgSrc(cat, i);
  const summary = (i.stats || []).slice(0, 4).join(", ");
  // Do not dump aggregated drop-dye codes on the card (Coryn doesn't either)
  return `<button class="slot" data-n="${n}">${src ? `<img src="${src}" alt="" width="64" height="64" loading="lazy" decoding="async">` : ""}<span>${isFav(i) ? "\u2605 " : ""}${esc(i.name)}</span>${state.cat === FAV ? `<small class="from">${esc(cat.name)}</small>` : ""}<em>${esc(summary)}</em></button>`;
}

const io = "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting) && !$("#more").hidden) { state.shown += PAGE; renderMore(); } }, { rootMargin: "900px" })
  : null;
function watchMore() {  // re-arm the "load more as you scroll" watcher after the list changes
  $("#more").hidden = state.found.length <= state.shown;
  if (io) { io.unobserve($("#more")); io.observe($("#more")); }
}

function render() {
  const found = sorted(state.items.filter(matches));
  state.found = found;
  $("#count").textContent = `${found.length} ${found.length === 1 ? "item" : "items"}`;
  $("#items").className = state.view;
  if (!found.length) {
    $("#more").hidden = true;
    return empty(state.cat === FAV && !state.items.length
      ? "No favorites yet. Open any item and press Add to favorites."
      : "No items match. Clear the search or filters.");
  }
  $("#items").innerHTML = found.slice(0, state.shown).map(slotHtml).join("");
  watchMore();
}
function renderMore() {  // add the next page without redrawing what is already there
  const from = $("#items").children.length;
  $("#items").insertAdjacentHTML("beforeend", state.found.slice(from, state.shown).map((i, k) => slotHtml(i, from + k)).join(""));
  watchMore();
}
function refresh() {  // after favorites change or sign-in sync
  if (!state.cat) return renderHome();
  if (state.cat === FAV) state.items = favItems();
  render();
}
function updateAdvDot() {
  const on = state.stat || state.dye || state.sort !== "name";
  $("#adv-btn").classList.toggle("active", !!on);
}
function setAdv(open) {
  $("#adv-panel").hidden = !open;
  $("#adv-btn").setAttribute("aria-expanded", open);
}
$("#adv-btn").onclick = () => setAdv($("#adv-panel").hidden);

// Stat picker: works like a normal dropdown, and when it opens there is a search box above the list
let statOpts = [], statDefault = "";
function renderStatList() {
  const q = $("#stat-q").value.trim().toLowerCase();
  const list = statOpts.filter((o) => !q || statLabel(o.name).toLowerCase().includes(q));
  const opt = (name, label) => `<button type="button" role="option" class="stat-opt" aria-selected="${name === state.stat}" data-stat="${esc(name)}">${esc(label)}</button>`;
  $("#stat-list").innerHTML = (q ? "" : opt("", "Any stat")) + list.map((o) => opt(o.name, statLabel(o.name))).join("")
    + (q && !list.length ? `<p class="gs-note">No stat matches \u201C${esc($("#stat-q").value.trim())}\u201D.</p>` : "");
}
function openStat() {
  $("#stat-q").value = "";
  renderStatList();
  $("#stat-pop").hidden = false;
  $("#stat-btn").setAttribute("aria-expanded", "true");
  $("#stat-q").focus();
}
function closeStat(refocus = false) {
  $("#stat-pop").hidden = true;
  $("#stat-btn").setAttribute("aria-expanded", "false");
  if (refocus) $("#stat-btn").focus();
}
function chooseStat(name, { focus = true } = {}) {
  state.stat = name;
  $("#stat-label").textContent = name ? statLabel(name) : "Any stat";
  if (!name && (state.sort === "hi" || state.sort === "lo")) { state.sort = "name"; $("#sort").value = "name"; }
  closeStat(focus);
  state.shown = PAGE; updateAdvDot(); render();
}
$("#stat-btn").onclick = () => ($("#stat-pop").hidden ? openStat() : closeStat());
$("#stat-q").oninput = renderStatList;
$("#stat-q").onkeydown = (e) => {
  if (e.key === "Enter") { e.preventDefault(); const first = $("#stat-list .stat-opt:not([data-stat=\"\"])"); if (first && $("#stat-q").value.trim()) chooseStat(first.dataset.stat); }
  else if (e.key === "Escape") { e.stopPropagation(); closeStat(true); }
};
$("#stat-list").onclick = (e) => { const b = e.target.closest(".stat-opt"); if (b) chooseStat(b.dataset.stat); };
document.addEventListener("click", (e) => { if (!e.target.closest(".statpick")) closeStat(); });

// ---- Content-aware popup: layouts adapt to what the scraper saved (stats table, drops with dye,
// recipe materials, appearance, sell/process, etc.). Cross-links open related items when we have them. ----
const SPECIAL_SECTIONS = new Set(["Stat/Effect", "Obtained From", "Recipe", "Appearance"]);
const DROP_PAGE = 8;

// Exact name lookup only. Coryn reuses numeric ids across types (monster id 145 ≠ item id 145),
// so we never open a link from id alone without checking the name matches.
const nameIndex = new Map(); // exact lowercased name → {item, cat}
function rebuildNameIndex() {
  nameIndex.clear();
  for (const cat of state.cats) {
    for (const i of state.cache[cat.id] || []) {
      const key = (i.name || "").trim().toLowerCase();
      if (key && !nameIndex.has(key)) nameIndex.set(key, { item: i, cat });
    }
  }
}
function namesMatch(cellText, itemName) {
  const a = String(cellText || "").trim().toLowerCase();
  const b = String(itemName || "").trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  // Allow "Name (Lv 145)" cell to match item stored as "Name"
  const stripLv = (s) => s.replace(/\s*\(lv\.?\s*\d+\)\s*$/i, "").trim();
  return stripLv(a) === b || a === stripLv(b) || stripLv(a) === stripLv(b);
}
function resolveLink(name) {
  if (!name || typeof name !== "string") return null;
  const raw = name.trim();
  if (!raw) return null;
  const key = raw.toLowerCase();
  if (nameIndex.has(key)) return nameIndex.get(key);
  const noLv = key.replace(/\s*\(lv\.?\s*\d+\)\s*$/i, "").trim();
  if (noLv && noLv !== key && nameIndex.has(noLv)) return nameIndex.get(noLv);
  return null;
}
// Optional id: only accepted if some item with that id also has the same name as the cell.
function resolveByIdAndName(id, name) {
  if (id == null || id === "" || !name) return null;
  const sid = String(id);
  for (const cat of state.cats) {
    for (const i of state.cache[cat.id] || []) {
      if (String(i.id) !== sid) continue;
      if (namesMatch(name, i.name)) return { item: i, cat };
    }
  }
  return null;
}
function linkCell(text, { id = null } = {}) {
  const t = String(text ?? "").trim();
  if (!t) return "";
  // Name first (safe). Id only confirms the same-named entry (avoids monster id → random armor).
  const hit = resolveLink(t) || resolveByIdAndName(id, t);
  if (hit) {
    return `<button type="button" class="cell-link" data-cat="${esc(hit.cat.id)}" data-id="${esc(String(hit.item.id))}">${esc(t)}</button>`;
  }
  return esc(t);
}
// Only columns Coryn actually hyperlinks. Maps are linked only when we have an id.
const LINKABLE_COLS = /^(monster|source|material|item|name|drop)$/i;
// rows: array of cell values. Optional htmlCols: Set of column names already containing safe HTML.
function tableHtml(cols, rows, { linked = false, htmlCols = null } = {}) {
  const body = rows.map((r) => `<tr>${r.map((c, i) => {
    const col = cols[i] || "";
    let cell;
    if (htmlCols && htmlCols.has(col)) cell = c ?? "";
    else if (linked && LINKABLE_COLS.test(col)) cell = linkCell(c);
    else cell = esc(c ?? "");
    return `<td>${cell}</td>`;
  }).join("")}</tr>`).join("");
  return `<div class="tbl"><table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}
// Compact pager like Coryn: « ‹ 1 2 3 › »
function dropPagerHtml(pages, current = 0) {
  if (pages <= 1) return "";
  // Show a window of up to 3 page numbers around the current page
  let start = Math.max(0, current - 1);
  let end = Math.min(pages - 1, start + 2);
  start = Math.max(0, end - 2);
  const nums = [];
  for (let i = start; i <= end; i++) {
    nums.push(`<button type="button" class="page-btn${i === current ? " active" : ""}" data-page="${i}">${i + 1}</button>`);
  }
  return `<div class="drop-pager" role="navigation" aria-label="Drop pages">
    <button type="button" class="page-btn nav" data-page="0" ${current === 0 ? "disabled" : ""} aria-label="First page">«</button>
    <button type="button" class="page-btn nav" data-page="${Math.max(0, current - 1)}" ${current === 0 ? "disabled" : ""} aria-label="Previous page">‹</button>
    ${nums.join("")}
    <button type="button" class="page-btn nav" data-page="${Math.min(pages - 1, current + 1)}" ${current >= pages - 1 ? "disabled" : ""} aria-label="Next page">›</button>
    <button type="button" class="page-btn nav" data-page="${pages - 1}" ${current >= pages - 1 ? "disabled" : ""} aria-label="Last page">»</button>
  </div>`;
}
function sectionHtml(name, sec) {
  const recs = sec.records || [];
  let body = "";
  if (recs.length && recs.every((r) => !r.values)) {
    const cols = [...new Set(recs.flatMap((r) => Object.keys(r)))].filter((c) =>
      recs.some((r) => r[c]) && !/_link$/i.test(c) && c !== "dye_chips");
    // Only auto-link columns Coryn links (not Map by name alone)
    const linked = cols.some((c) => LINKABLE_COLS.test(c));
    body = tableHtml(cols, recs.map((r) => cols.map((c) => r[c] ?? "")), { linked });
  } else if (recs.length) {
    body = `<ul>${recs.map((r) => `<li>${esc((r.values || []).filter(Boolean).join(" - "))}</li>`).join("")}</ul>`;
  } else if (sec.text) {
    const t = sec.text.startsWith(name) ? sec.text.slice(name.length).trim() : sec.text;
    // Skip broken appearance text like "Male Normal Light Heavy Female..."
    if (/^male\s+normal\s+light\s+heavy/i.test(t)) body = `<p class="muted">Appearance images were not captured by the scraper.</p>`;
    else body = t ? `<p>${esc(t)}</p>` : "";
  }
  return body ? `<h3>${esc(name.replace(/\s*\(\d+\)$/, ""))}</h3>${body}` : "";
}
function pageHtml(p) {
  const tables = (p.tables || []).filter((t) => t.length > 1).slice(0, 5)
    .map((t) => tableHtml(t[0], t.slice(1, 61).map((r) => t[0].map((_, k) => r[k] ?? ""))));
  const text = (p.text || "").slice(0, 1500);
  return tables.join("") + (text ? `<p class="muted">${esc(text)}${p.text.length > 1500 ? "\u2026" : ""}</p>` : "");
}
function statsSectionHtml(item) {
  const sec = item.sections?.["Stat/Effect"];
  if (sec?.records?.length) {
    const cols = Object.keys(sec.records[0]);
    return `<h3>Stat / Effect</h3>${tableHtml(cols, sec.records.map((r) => cols.map((c) => r[c] ?? "")))}`;
  }
  const stats = [...(item.stats || [])];
  if (item.base_def != null) stats.unshift(`Base DEF ${item.base_def}`);
  if (!stats.length) return "";
  // Prefer "Name  Value" rows when possible
  const rows = stats.map((s) => {
    const m = String(s).match(/^(.+?)\s+([+\-]?\d+(?:\.\d+)?%?)$/);
    return m ? [m[1], m[2]] : [s, ""];
  });
  return `<h3>Stat / Effect</h3>${tableHtml(["Stat/Effect", "Amount"], rows)}`;
}
function obtainedSectionHtml(item) {
  const sec = item.sections?.["Obtained From"];
  let rows = [];
  if (sec?.records?.length) {
    rows = sec.records.map((r) => ({
      monster: r.Monster || r.Source || r.source || "",
      source_id: r.Monster_link?.id || r.Source_link?.id || r.source_id || null,
      dye: r.Dye || r.dye || "",
      dye_chips: r.dye_chips || null,
      map: r.Map || r.Where || r.map || "",
      map_id: r.Map_link?.id || r.map_id || null,
    }));
  } else if (item.obtained_from?.rows?.length) {
    rows = item.obtained_from.rows.map((o) => ({
      monster: o.source || o.monster || "",
      source_id: o.source_id || null,
      dye: o.dye || "",
      dye_chips: o.dye_chips || null,
      map: o.map || o.where || "",
      map_id: o.map_id || null,
    }));
  }
  if (!rows.length) {
    if (item.obtained_from?.text) return `<h3>Obtained From</h3><p>${esc(item.obtained_from.text)}</p>`;
    return "";
  }
  const hasDye = rows.some((r) => r.dye || (r.dye_chips && r.dye_chips.length));
  const cols = hasDye ? ["Monster", "Dye", "Map"] : ["Monster", "Map"];
  // Pre-render Monster/Map with exact id or exact name only; Dye as coloured chips.
  const data = rows.map((r) => {
    const mon = linkCell(r.monster, { id: r.source_id });
    const map = r.map_id
      ? linkCell(r.map, { id: r.map_id })  // only link maps when scraper saved a real map id
      : esc(r.map || "");                   // plain text otherwise (matches Coryn when no link)
    return hasDye ? [mon, dyeCellHtml(r), map] : [mon, map];
  });
  const total = data.length;
  const pages = Math.max(1, Math.ceil(total / DROP_PAGE));
  const pageBlocks = [];
  const htmlCols = new Set(hasDye ? ["Monster", "Dye", "Map"] : ["Monster", "Map"]);
  for (let p = 0; p < pages; p++) {
    const slice = data.slice(p * DROP_PAGE, (p + 1) * DROP_PAGE);
    pageBlocks.push(`<div class="drop-page" data-page="${p}"${p ? " hidden" : ""}>${
      tableHtml(cols, slice, { linked: false, htmlCols })
    }</div>`);
  }
  return `<h3>Obtained From</h3><div class="drop-block" data-pages="${pages}">${pageBlocks.join("")}${dropPagerHtml(pages, 0)}</div>`;
}
function recipeSectionHtml(item) {
  const r = item.recipe || {};
  const sec = item.sections?.Recipe;
  let mats = r.materials || [];
  if (!mats.length && sec?.records?.length) {
    mats = sec.records.map((rec) => ({
      name: rec.Material || rec.Name || rec.name || (rec.values || [])[0] || "",
      quantity: rec.Qty || rec.Quantity || rec.quantity || (rec.values || [])[1] || "",
    })).filter((m) => m.name);
  }
  const pts = Object.entries(r.points || {}).map(([k, v]) => `<li>${esc(k)}: ${esc(v)}</li>`);
  if (r.fee) pts.push(`<li>Fee: ${esc(r.fee)}</li>`);
  if (!mats.length && !pts.length && !sec?.text) return "";
  let body = "";
  if (mats.length) {
    body += `<ul class="recipe-mats">${mats.map((m) =>
      `<li>${linkCell(m.name)}${m.quantity ? ` <span class="qty">×${esc(m.quantity)}</span>` : ""}</li>`
    ).join("")}</ul>`;
  }
  if (pts.length) body += `<ul>${pts.join("")}</ul>`;
  if (!body && sec?.text) body = `<p>${esc(sec.text)}</p>`;
  return body ? `<h3>Recipe</h3>${body}` : "";
}
function resolveAsset(cat, src) {
  // Absolute URL stays as-is; bare filenames go through the category image folder.
  if (!src) return "";
  if (/^https?:\/\//i.test(src) || src.startsWith("data:")) return src;
  const file = String(src).split(/[\\/]/).pop();
  if (!file || !cat?.images) return "";
  return remote
    ? `${CFG.supabaseUrl}/storage/v1/object/public/site/images/${encodeURIComponent(file)}`
    : `${cat.images}/${encodeURIComponent(file)}`;
}
function appearanceSectionHtml(item, cat = catOf(item)) {
  // Prefer item.appearance {male:{normal,light,heavy}, ...} then sections.Appearance.images
  const app = item.appearance;
  let images = [];
  if (app && typeof app === "object") {
    for (const gender of ["male", "female"]) {
      const variants = app[gender];
      if (!variants || typeof variants !== "object") continue;
      for (const variant of ["normal", "light", "heavy"]) {
        const src = variants[variant];
        if (!src) continue;
        images.push({ src: resolveAsset(cat, src), label: `${gender} ${variant}`.replace(/\b\w/g, (c) => c.toUpperCase()) });
      }
    }
  }
  const sec = item.sections?.Appearance;
  if (!images.length && sec?.images?.length) {
    images = sec.images.map((im) => ({
      src: resolveAsset(cat, im.src || im),
      label: im.label || "",
    })).filter((im) => im.src);
  }
  if (images.length) {
    return `<h3>Appearance</h3><div class="appear-grid">${images.map((im) =>
      `<figure><img src="${esc(im.src)}" alt="${esc(im.label || "")}" loading="lazy"><figcaption>${esc(im.label || "")}</figcaption></figure>`
    ).join("")}</div>`;
  }
  if (sec?.records?.length) return sectionHtml("Appearance", sec);
  const t = (sec?.text || "").replace(/^Appearance\s*/i, "").trim();
  if (!t || /^male\s+normal\s+light\s+heavy/i.test(t)) {
    return `<h3>Appearance</h3><p class="muted">Appearance images were not captured for this item. Re-scrape to fill this section.</p>`;
  }
  return sec ? `<h3>Appearance</h3><p>${esc(t)}</p>` : "";
}
function extraHtml(item) {
  let out = "";
  for (const [name, sec] of Object.entries(item.sections || {})) {
    if (!SPECIAL_SECTIONS.has(name) && !name.includes("Community Gallery")) out += sectionHtml(name, sec);
  }
  return out + (item.page ? pageHtml(item.page) : "");
}
function infoBadgesHtml(item, cat) {
  const bits = [];
  if (item.type && item.type.toLowerCase() !== cat.name.toLowerCase()) {
    bits.push(`<span class="badge type-badge">[${esc(item.type)}]</span>`);
  }
  const info = item.info || {};
  // Coryn-style Sell / Process pills
  for (const key of ["Sell", "Process", "Cost", "Price"]) {
    if (info[key]) bits.push(`<span class="meta-pill"><small>${esc(key)}</small><strong>${esc(info[key])}</strong></span>`);
  }
  // Any other info keys
  for (const [k, v] of Object.entries(info)) {
    if (["Sell", "Process", "Cost", "Price"].includes(k)) continue;
    bits.push(`<span class="meta-pill"><small>${esc(k)}</small><strong>${esc(v)}</strong></span>`);
  }
  for (const t of item.obtain_types || []) bits.push(`<span class="badge">${esc(t)}</span>`);
  return bits.length ? `<div class="info-row">${bits.join("")}</div>` : "";
}

// ---- Item popup, with links and compare ----
const compare = [];  // up to two {item, cat}
function detail(item, cat = catOf(item), { hash = true } = {}) {
  if (!nameIndex.size) rebuildNameIndex();
  const src = imgSrc(cat, item);
  $("#dlg-body").innerHTML = `
    <div class="head">
      ${src ? `<img src="${src}" alt="">` : `<div class="img-ph" aria-hidden="true"></div>`}
      <div class="head-text">
        <h2>${esc(item.name)}</h2>
        <p class="muted from-cat">${esc(cat.name)}</p>
        ${infoBadgesHtml(item, cat)}
      </div>
    </div>
    ${statsSectionHtml(item)}
    ${recipeSectionHtml(item)}
    ${obtainedSectionHtml(item)}
    ${appearanceSectionHtml(item)}
    ${extraHtml(item)}`;

  // Wire drop-table pager (Coryn-style « ‹ 1 2 3 › »)
  const dropBlock = $("#dlg-body").querySelector(".drop-block");
  if (dropBlock) {
    const goPage = (page) => {
      const pages = Number(dropBlock.dataset.pages) || 1;
      const p = Math.max(0, Math.min(pages - 1, page));
      dropBlock.querySelectorAll(".drop-page").forEach((el) => { el.hidden = Number(el.dataset.page) !== p; });
      const old = dropBlock.querySelector(".drop-pager");
      if (old) old.outerHTML = dropPagerHtml(pages, p);
    };
    dropBlock.addEventListener("click", (e) => {
      const btn = e.target.closest(".page-btn");
      if (!btn || btn.disabled) return;
      goPage(Number(btn.dataset.page));
    });
  }
  // Wire cross-links (monster / map / material → open that item)
  $("#dlg-body").querySelectorAll(".cell-link").forEach((btn) => {
    btn.onclick = () => {
      const c = state.cats.find((x) => x.id === btn.dataset.cat);
      const it = c && findItem(c.id, btn.dataset.id);
      if (it) detail(it, c);
    };
  });

  const actions = document.createElement("div");
  actions.className = "dlg-actions";
  const btn = (text, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "fav"; b.textContent = text; b.onclick = fn; actions.append(b); return b; };

  const fb = btn("", () => { toggleFav(item, cat); favLabel(); renderMenu(); if (state.cat) refresh(); });
  const favLabel = () => (fb.textContent = isFav(item, cat) ? "Remove from favorites" : "Add to favorites");
  favLabel();

  const inCompare = () => compare.findIndex((c) => c.item === item);
  btn(inCompare() >= 0 ? "Remove from compare" : "Add to compare", () => {
    const k = inCompare();
    if (k >= 0) compare.splice(k, 1);
    else { if (compare.length >= 2) compare.shift(); compare.push({ item, cat }); }
    renderTray();
    $("#dlg").close();
    if (k < 0 && compare.length === 2) openCompare();
  });

  $("#dlg-body").append(actions);

  openItem = { item, cat };
  document.title = `${item.name} - Codex Arcane`;
  if (hash) state.cat === FAV ? setHash(FAV.id, `${cat.id}:${item.id}`) : setHash(cat.id, String(item.id));
  if (!$("#dlg").open) $("#dlg").showModal();
}
$("#dlg").addEventListener("close", () => {
  if ($("#dlg").open) return;  // a late close event from the previous popup: another item is already open
  const was = openItem;
  openItem = null;
  updateCrumb();  // puts the page title back
  // Drop the item from the link, but only if the link still points at the item that was just closed.
  const { item } = parseHash();
  if (was && item && (item === String(was.item.id) || item === `${was.cat.id}:${was.item.id}`)) setHash(state.cat ? state.cat.id : "");
});

// Compare two items side by side
function renderTray() {
  const t = $("#cmp-tray");
  t.hidden = !compare.length;
  if (!compare.length) return;
  t.innerHTML = `<span class="tray-items">${compare.map((c, k) => `<span class="chip">${esc(c.item.name)}<button type="button" data-rm="${k}" aria-label="Remove ${esc(c.item.name)} from compare">\u00D7</button></span>`).join("")}</span>`
    + (compare.length === 2 ? `<button type="button" class="tray-go" data-go>Compare</button>` : `<span class="muted tray-hint">Pick one more item</span>`)
    + `<button type="button" data-clear>Clear</button>`;
}
$("#cmp-tray").onclick = (e) => {
  const rm = e.target.closest("[data-rm]");
  if (rm) { compare.splice(Number(rm.dataset.rm), 1); renderTray(); }
  else if (e.target.closest("[data-go]")) openCompare();
  else if (e.target.closest("[data-clear]")) { compare.length = 0; renderTray(); }
};
function openCompare() {
  if (compare.length < 2) return;
  const [A, B] = compare, sa = statsOf(A.item), sb2 = statsOf(B.item);
  const val = (m, n) => (!m.has(n) ? "\u2014" : m.get(n) === null ? "\u2713" : `${m.get(n)}${n.endsWith(" %") ? "%" : ""}`);
  const names = [...new Set([...sa.keys(), ...sb2.keys()])];
  const statRows = names.map((n) => {
    const x = sa.get(n), y = sb2.get(n), both = x != null && y != null && x !== y;
    return `<tr><th scope="row">${esc(statLabel(n))}</th><td class="${both && x > y ? "win" : ""}">${esc(val(sa, n))}</td><td class="${both && y > x ? "win" : ""}">${esc(val(sb2, n))}</td></tr>`;
  }).join("");
  const text = (fn) => [A, B].map((c) => `<td>${esc(fn(c.item) || "\u2014")}</td>`).join("");
  const head = (c) => { const s = imgSrc(c.cat, c.item); return `<th scope="col">${s ? `<img src="${s}" alt="">` : ""}<strong>${esc(c.item.name)}</strong><small>${esc(c.cat.name)}</small></th>`; };
  $("#cmp-body").innerHTML = `<h2>Compare</h2>
    <div class="cmp-scroll"><table class="cmp"><thead><tr><td></td>${head(A)}${head(B)}</tr></thead><tbody>
      <tr><th scope="row">Source</th>${text((i) => (i.obtain_types || []).join(", "))}</tr>
      ${statRows}
      <tr><th scope="row">Materials</th>${text((i) => ((i.recipe?.materials) || []).map((m) => `${m.name}${m.quantity ? ` x${m.quantity}` : ""}`).join(", "))}</tr>
      <tr><th scope="row">Obtained from</th>${text((i) => i.obtained_from?.text)}</tr>
    </tbody></table></div>
    <p class="muted cmp-note">The higher number in each stat is highlighted.</p>`;
  $("#cmp").showModal();
}
$("#cmp-clear").onclick = () => { compare.length = 0; renderTray(); $("#cmp").close(); };

$("#q").oninput = (e) => { state.q = e.target.value.trim().toLowerCase(); state.shown = PAGE; render(); };
$("#type").onchange = (e) => { state.type = e.target.value; state.shown = PAGE; render(); };
$("#sort").onchange = (e) => {
  state.sort = e.target.value;
  state.shown = PAGE; updateAdvDot(); render();
  if ((state.sort === "hi" || state.sort === "lo") && !state.stat) {
    if (statDefault) chooseStat(statDefault, { focus: false });   // stat is still changeable; sorting just needs one to compare
    else { state.sort = "name"; e.target.value = "name"; updateAdvDot(); render(); }
  }
};
$("#dye").oninput = (e) => { state.dye = e.target.value.trim().toLowerCase(); state.shown = PAGE; updateAdvDot(); render(); };
$("#more").onclick = () => { state.shown += PAGE; renderMore(); };
$("#items").onclick = (e) => {
  const card = e.target.closest(".hg-card");
  if (card) { openGroups.add(card.dataset.g); return openMenu(); }
  const b = e.target.closest(".slot");
  if (b) { const it = state.found[Number(b.dataset.n)]; if (it) detail(it, catOf(it)); }
};
for (const v of ["grid", "list"]) {
  $("#v-" + v).onclick = () => {
    state.view = v; prefs.view = v; savePrefs();
    $("#v-grid").setAttribute("aria-pressed", v === "grid");
    $("#v-list").setAttribute("aria-pressed", v === "list");
    if (state.cat) render();
  };
}
$("#favonly").onchange = (e) => { state.favOnly = prefs.favOnly = e.target.checked; savePrefs(); state.shown = PAGE; if (state.cat) render(); };

// Search the whole site: category names plus every item in every category.
const hayCache = new WeakMap();
function deepHay(i) {
  let h = hayCache.get(i);
  if (h === undefined) {
    h = [i.name, ...(i.stats || []), ...(i.obtain_types || []), i.obtained_from?.text,
      ...(i.dyes || []).map(dyeCode),
      ...((i.recipe?.materials) || []).map((m) => m.name)].join(" ").toLowerCase();
    hayCache.set(i, h);
  }
  return h;
}
const GS_MAX = 50;
let gsTimer, gsHits = [], gsActive = -1;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function mark(text, terms) {  // bold the part of a result that matched what was typed
  if (!terms.length) return esc(text);
  const re = new RegExp("(" + [...terms].sort((a, b) => b.length - a.length).map(reEsc).join("|") + ")", "gi");
  return String(text ?? "").split(re).map((p, k) => (k % 2 ? `<mark>${esc(p)}</mark>` : esc(p))).join("");
}
function snippet(i, terms) {  // when the name doesn't match, show which other detail did
  const pool = [...(i.stats || []), i.obtained_from?.text, ...((i.recipe?.materials) || []).map((m) => m.name), ...(i.obtain_types || []), ...(i.dyes || []).map(dyeCode)];
  const hit = pool.filter(Boolean).find((t) => terms.some((x) => String(t).toLowerCase().includes(x)));
  return hit ? String(hit).slice(0, 70) : "";
}
function globalSearch(terms) {
  const out = { places: [], items: [], total: 0 };
  if (!terms.length) return out;
  const all = (h) => terms.every((t) => h.includes(t));
  for (const g of state.groups) {
    if (remote && all(g.name.toLowerCase())) out.places.push({ kind: "group", g });
    for (const c of g.cats) if (all(`${c.name} ${remote ? g.name : ""}`.toLowerCase())) out.places.push({ kind: "cat", c, g });
  }
  const scored = [];
  for (const g of state.groups) for (const c of g.cats) for (const i of state.cache[c.id] || []) {
    if (!all(deepHay(i))) continue;
    const n = (i.name || "").toLowerCase();
    scored.push({ i, c, g, score: n === terms.join(" ") ? 0 : n.startsWith(terms[0]) ? 1 : n.includes(terms[0]) ? 2 : 3 });
  }
  scored.sort((a, b) => a.score - b.score);
  out.total = scored.length;
  out.items = scored.slice(0, GS_MAX);
  return out;
}
function renderGlobal() {
  const box = $("#gs-results"), text = $("#gs").value.trim();
  gsActive = -1;
  if (!text) { box.hidden = true; box.innerHTML = ""; return; }
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  const res = globalSearch(terms);
  gsHits = [...res.places, ...res.items];
  const row = (n, thumb, title, sub) => `<button type="button" role="option" aria-selected="false" class="gs-row" data-n="${n}">${thumb}<span class="gs-t"><strong>${title}</strong><small>${sub}</small></span></button>`;
  const places = res.places.map((p, n) => p.kind === "group"
    ? row(n, '<span class="gs-ph" aria-hidden="true">\u2630</span>', mark(p.g.name, terms), "Group \u2022 open in menu")
    : row(n, '<span class="gs-ph" aria-hidden="true">\u2630</span>', mark(p.c.name, terms), `Category${remote ? ` \u2022 ${esc(p.g.name)}` : ""}`));
  const items = res.items.map((h, k) => {
    const src = imgSrc(h.c, h.i), name = (h.i.name || "").toLowerCase();
    const snip = terms.every((t) => name.includes(t)) ? "" : snippet(h.i, terms);
    const sub = `${esc(h.c.name)}${remote ? ` \u2022 ${esc(h.g.name)}` : ""}${snip ? ` \u2022 ${mark(snip, terms)}` : ""}`;
    return row(res.places.length + k, src ? `<img src="${src}" alt="" loading="lazy" decoding="async">` : '<span class="gs-ph"></span>', mark(h.i.name, terms), sub);
  });
  const note = res.total > GS_MAX ? `<p class="gs-note">Showing the first ${GS_MAX} of ${res.total} items. Type more to narrow it down.</p>` : "";
  box.innerHTML = gsHits.length ? places.join("") + items.join("") + note : `<p class="gs-note">Nothing found for \u201C${esc(text)}\u201D.</p>`;
  box.hidden = false;
}
function moveActive(step) {
  if (!gsHits.length) return;
  gsActive = Math.max(0, Math.min(gsHits.length - 1, gsActive + step));
  $("#gs-results").querySelectorAll(".gs-row").forEach((r) => {
    const on = Number(r.dataset.n) === gsActive;
    r.classList.toggle("gs-active", on);
    r.setAttribute("aria-selected", on);
    if (on) r.scrollIntoView({ block: "nearest" });
  });
}
async function openHit(n) {
  const h = gsHits[n];
  if (!h) return;
  $("#gs-results").hidden = true;
  $("#gs").blur();
  if (h.kind === "group") { openGroups.add(h.g.id); return openMenu(); }
  if (h.kind === "cat") return pick(h.c.id);
  await pick(h.c.id);
  detail(h.i, h.c);
}
$("#gs").oninput = () => {
  clearTimeout(gsTimer);
  gsTimer = setTimeout(async () => { await loadAll(); renderGlobal(); }, 120);
};
$("#gs").onfocus = () => { if ($("#gs").value.trim()) renderGlobal(); else loadAll(); };
$("#gs").onkeydown = (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); if ($("#gs-results").hidden) renderGlobal(); moveActive(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moveActive(-1); }
  else if (e.key === "Enter") {
    e.preventDefault(); clearTimeout(gsTimer);
    if (gsActive >= 0 && !$("#gs-results").hidden) return openHit(gsActive);
    loadAll().then(() => { renderGlobal(); openHit(0); });
  } else if (e.key === "Escape") { $("#gs-results").hidden = true; }
};
$("#gs-results").onclick = (e) => { const b = e.target.closest(".gs-row"); if (b) openHit(Number(b.dataset.n)); };
document.addEventListener("click", (e) => { if (!e.target.closest(".gsearch")) $("#gs-results").hidden = true; });

// Account area. Signing in is optional: guests just see a reminder.
function showAccount() {
  const owner = !!user && user.email === `${CFG.ownerUsername}@${CFG.emailDomain}`.toLowerCase();
  const html = user
    ? `${owner ? '<a href="admin.html">Owner panel</a> ' : ""}<span>${esc(user.email.split("@")[0])}</span> <button class="out" type="button">Sign out</button>`
    : remote ? `<a class="btn" href="account.html?next=index.html">Sign in</a>` : "";
  $("#acct").innerHTML = html;
  $("#drawer-acct").innerHTML = html;
  let dismissed = false;
  try { dismissed = localStorage.getItem("gear-banner") === "1"; } catch {}
  $("#banner").hidden = !remote || !!user || dismissed;
}
async function syncAccount() {
  const { data } = await sb.from("user_settings").select("data").eq("user_id", user.id).maybeSingle();
  const saved = data?.data || {};
  prefs.favs = [...new Set([...(saved.favs || []), ...prefs.favs])];  // keep favorites from both
  for (const k of ["view", "favOnly"]) if (saved[k] !== undefined) prefs[k] = saved[k];
  savePrefs(); applyPrefs();
  renderMenu(); refresh();
}
document.addEventListener("click", (e) => { if (e.target.closest(".out") && sb) sb.auth.signOut(); });
$("#dismiss").onclick = () => { try { localStorage.setItem("gear-banner", "1"); } catch {} $("#banner").hidden = true; };
if (sb) {
  sb.auth.onAuthStateChange((event, session) => {
    user = session?.user || null;
    setTimeout(async () => {  // not awaited inside the callback, to avoid blocking the auth client
      if (event === "SIGNED_OUT") {
        syncedFor = null;
        Object.assign(prefs, { ...DEFAULTS, favs: [] });  // don't leave the last person's settings on this device
        try { localStorage.removeItem(LS_KEY); } catch {}
        applyPrefs();
        renderMenu(); refresh();
      } else if (user && user.id !== syncedFor) {
        syncedFor = user.id;
        await syncAccount();
      }
      showAccount();
    }, 0);
  });
}
showAccount();
applyPrefs();
boot();

// Works offline and loads faster on repeat visits (see sw.js).
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
