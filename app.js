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
$(".brand").onclick = (e) => { e.preventDefault(); setHash(""); };

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

// Home page: a card for every category, grouped like the menu.
function renderHome() {
  const total = state.cats.reduce((n, c) => n + c.count, 0);
  const favN = prefs.favs.length;
  const card = (c, extra = "") => {
    const first = (state.cache[c.id] || [])[0], src = first ? imgSrc(c, first) : "";
    return `<button class="card" type="button" data-id="${esc(c.id)}">${src ? `<img src="${src}" alt="" loading="lazy" decoding="async" width="48" height="48">` : '<span class="card-ph" aria-hidden="true"></span>'}<strong>${esc(c.name)}</strong><small>${extra || `${c.count.toLocaleString()} items`}</small></button>`;
  };
  $("#items").className = "home";
  $("#items").innerHTML = `<p class="home-lead">${total.toLocaleString()} items in ${state.cats.length} ${state.cats.length === 1 ? "category" : "categories"}. Pick one below, or use the search bar to find anything.</p>`
    + (favN ? `<section class="home-grp"><h2>Your favorites</h2><div class="cards"><button class="card" type="button" data-id="favorites"><span class="card-ph star" aria-hidden="true">\u2605</span><strong>Favorites</strong><small>${favN} ${favN === 1 ? "item" : "items"}</small></button></div></section>` : "")
    + state.groups.filter((g) => g.cats.length).map((g) => `<section class="home-grp">${remote ? `<h2>${esc(g.name)}</h2>` : ""}<div class="cards">${g.cats.map((c) => card(c)).join("")}</div></section>`).join("");
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
  // Stats that have a number (ATK +12) can be sorted; the most common ones come first.
  const counts = new Map();
  for (const i of items) for (const [n, v] of statsOf(i)) if (v !== null) counts.set(n, (counts.get(n) || 0) + 1);
  const names = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 80).map((x) => x[0]);
  $("#stat").innerHTML = `<option value="">Any stat</option>` + names.map((n) => `<option value="${esc(n)}">${esc(statLabel(n))}</option>`).join("");
  const dyes = [...new Set(items.flatMap((i) => (i.dyes || []).map(dyeCode)))].sort().slice(0, 600);
  $("#dye-list").innerHTML = dyes.map((d) => `<option value="${esc(d)}">`).join("");
  $(".dyef").hidden = !dyes.length;
  $(".adv").open = false;
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

// Dye chips: colored boxes like RaffyDB. Works with {code,color} objects or plain "A30" strings.
function readable(hex) { // black or white text, whichever is easier to read on this color
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#1b1206" : "#fff";
}
function dyeChips(item) {
  return (item.dyes || []).map((d) => {
    const code = typeof d === "string" ? d : d.code;
    const color = typeof d === "object" && /^#[0-9a-f]{6}$/i.test(d.color || "") ? d.color : "";
    const style = color ? ` style="background:${color};color:${readable(color)}"` : "";
    return `<i class="dye"${style}>${esc(code)}</i>`;
  }).join("");
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
  return `<button class="slot" data-n="${n}">${src ? `<img src="${src}" alt="" width="64" height="64" loading="lazy" decoding="async">` : ""}<span>${isFav(i) ? "\u2605 " : ""}${esc(i.name)}</span>${state.cat === FAV ? `<small class="from">${esc(cat.name)}</small>` : ""}<em>${esc(summary)}</em>${i.dyes?.length ? `<small class="dyes">${dyeChips(i)}</small>` : ""}</button>`;
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
  $(".adv summary").classList.toggle("active", !!on);
}

// ---- Item popup, with links and compare ----
const compare = [];  // up to two {item, cat}
function detail(item, cat = catOf(item), { hash = true } = {}) {
  const r = item.recipe || {};
  const src = imgSrc(cat, item);
  const list = (arr) => (arr.length ? `<ul>${arr.join("")}</ul>` : "");
  const mats = (r.materials || []).map((m) => `<li>${esc(m.name)}${m.quantity ? ` x${m.quantity}` : ""}</li>`);
  const pts = Object.entries(r.points || {}).map(([k, v]) => `<li>${esc(k)}: ${esc(v)}</li>`);
  if (r.fee) pts.push(`<li>Fee: ${esc(r.fee)}</li>`);
  const stats = (item.stats || []).map((s) => `<li>${esc(s)}</li>`);
  if (item.base_def != null) stats.unshift(`<li>Base DEF: ${item.base_def}</li>`);
  $("#dlg-body").innerHTML = `
    <div class="head">${src ? `<img src="${src}" alt="">` : ""}<div><h2>${esc(item.name)}</h2><p class="muted from-cat">${esc(cat.name)}</p>${(item.obtain_types || []).map((t) => `<span class="badge">${esc(t)}</span>`).join("")}</div></div>
    ${item.dyes?.length ? `<h3>Dyes</h3><div class="dyes">${dyeChips(item)}</div>` : ""}
    ${stats.length ? `<h3>Stats</h3>${list(stats)}` : ""}
    ${mats.length || pts.length ? `<h3>Recipe</h3>${list(mats.concat(pts))}` : ""}
    ${item.obtained_from?.text ? `<h3>Obtained from</h3><p>${esc(item.obtained_from.text)}</p>` : ""}`;
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

  const link = location.origin + location.pathname + location.search + `#${encodeURIComponent(cat.id)}/${encodeURIComponent(item.id)}`;
  const lb = btn(navigator.share && matchMedia("(pointer: coarse)").matches ? "Share link" : "Copy link", async () => {
    try {
      if (navigator.share && matchMedia("(pointer: coarse)").matches) { await navigator.share({ title: `${item.name} - Codex Arcane`, url: link }); return; }
      await navigator.clipboard.writeText(link);
      lb.textContent = "Link copied";
    } catch (err) { if (err?.name !== "AbortError") prompt("Copy this link:", link); }
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
$("#stat").onchange = (e) => { state.stat = e.target.value; if (!state.stat && (state.sort === "hi" || state.sort === "lo")) { state.sort = "name"; $("#sort").value = "name"; } state.shown = PAGE; updateAdvDot(); render(); };
$("#sort").onchange = (e) => {
  state.sort = e.target.value;
  if ((state.sort === "hi" || state.sort === "lo") && !state.stat && $("#stat").options.length > 1) { state.stat = $("#stat").options[1].value; $("#stat").value = state.stat; }
  if ((state.sort === "hi" || state.sort === "lo") && !state.stat) { state.sort = "name"; e.target.value = "name"; }
  state.shown = PAGE; updateAdvDot(); render();
};
$("#dye").oninput = (e) => { state.dye = e.target.value.trim().toLowerCase(); state.shown = PAGE; updateAdvDot(); render(); };
$("#more").onclick = () => { state.shown += PAGE; renderMore(); };
$("#items").onclick = (e) => {
  const card = e.target.closest(".card");
  if (card) return pick(card.dataset.id);
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
  $("#acct").innerHTML = user
    ? `${owner ? '<a href="admin.html">Owner panel</a> ' : ""}<span>${esc(user.email.split("@")[0])}</span> <button id="out">Sign out</button>`
    : remote ? `<a class="btn" href="account.html?next=index.html">Sign in</a>` : "";
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
$("#acct").onclick = (e) => { if (e.target.id === "out") sb.auth.signOut(); };
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
