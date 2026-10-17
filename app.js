const $ = (s) => document.querySelector(s);
const PAGE = 60;
const CFG = window.GEAR_CONFIG || {};
const remote = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);
const state = { cats: [], cat: null, cache: {}, items: [], q: "", type: "", shown: PAGE, view: "grid", favOnly: false, groups: [], group: null };
// Settings and favorites. Guests: saved in this browser. Signed in: also saved to the account.
const LS_KEY = "gear-prefs", DEFAULTS = { view: "grid", favOnly: false, favs: [] };
const prefs = (() => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS_KEY) || "{}") }; } catch { return { ...DEFAULTS }; } })();
state.view = prefs.view; state.favOnly = prefs.favOnly;
const sb = remote && window.supabase ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey) : null;
let user = null, saveTimer, syncedFor = null;
const favKey = (i) => `${state.cat.id}:${i.id}`;
const isFav = (i) => prefs.favs.includes(favKey(i));
function toggleFav(i) {
  const k = favKey(i);
  prefs.favs = isFav(i) ? prefs.favs.filter((x) => x !== k) : [...prefs.favs, k];
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
    state.cache[id] = items.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return { id, name: id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), count: items.length, files: [url], images: true };
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
  $("#tabs").onclick = (e) => { const b = e.target.closest("button"); if (b) pick(b.dataset.id); };
  $("#groups").onclick = (e) => { const b = e.target.closest("button"); if (b) pickGroup(b.dataset.g); };
  const start = state.cats.find((c) => c.id === location.hash.slice(1));
  start ? pick(start.id) : showHome();
}

// Two rows of tabs: groups (like Equipment) on top, the categories inside the open group below.
function renderTabs() {
  const g = state.group;
  $("#groups").hidden = !remote;
  $("#groups").innerHTML = state.groups
    .map((x) => `<button data-g="${esc(x.id)}" aria-current="${x === g}">${esc(x.name)}</button>`)
    .join("");
  $("#tabs").hidden = !g;
  $("#tabs").innerHTML = (g ? g.cats : [])
    .map((c) => `<button data-id="${esc(c.id)}" aria-current="${c === state.cat}">${esc(c.name)}<small>${c.count}</small></button>`)
    .join("");
}

// Nothing is open at first: categories stay hidden until their group is pressed.
function closeCategory(text) {
  state.cat = null; state.items = [];
  $(".tools").hidden = true;
  $("#more").hidden = true;
  empty(text);
}

function showHome() {
  state.group = remote ? null : state.groups[0];
  renderTabs();
  closeCategory(remote ? "Choose a group above to see its categories." : "Choose a category above.");
}

function pickGroup(gid) {
  const g = state.groups.find((x) => x.id === gid);
  if (!g) return;
  history.replaceState(null, "", location.pathname + location.search);
  if (state.group === g) return showHome();  // pressing the open group again hides its categories
  state.group = g;
  renderTabs();
  closeCategory(g.cats.length ? `Choose a category in ${g.name}.` : "No categories in this group yet.");
}

async function pick(id) {
  const cat = state.cats.find((c) => c.id === id) || state.cats[0];
  state.cat = cat;
  $(".tools").hidden = false;
  prefs.cat = cat.id; savePrefs();
  location.hash = cat.id;
  state.group = state.groups.find((g) => g.cats.includes(cat));
  renderTabs();
  if (!state.cache[cat.id]) {
    const lists = await Promise.all(cat.files.map((f) => fetch(f).then((r) => r.json())));
    state.cache[cat.id] = lists.flat().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }
  state.items = state.cache[cat.id];
  state.q = ""; state.type = ""; state.shown = PAGE;
  $("#q").value = "";
  const types = [...new Set(state.items.flatMap((i) => i.obtain_types || []))].sort();
  $("#type").innerHTML = `<option value="">All sources</option>` + types.map((t) => `<option>${esc(t)}</option>`).join("");
  render();
}

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
  if (state.favOnly && !isFav(i)) return false;
  if (state.type && !(i.obtain_types || []).includes(state.type)) return false;
  if (!state.q) return true;
  const hay = [i.name, ...(i.stats || []), ...(i.obtain_types || []), i.obtained_from?.text, ...(i.dyes || []).map((d) => (typeof d === "string" ? d : d.code))].join(" ").toLowerCase();
  return hay.includes(state.q);
}

function render() {
  const found = state.items.filter(matches);
  const cat = state.cat;
  $("#count").textContent = `${found.length} items`;
  $("#items").className = state.view;
  if (!found.length) { $("#more").hidden = true; return empty("No items match. Clear the search or pick another source."); }
  $("#items").innerHTML = found.slice(0, state.shown).map((i) => {
    const src = imgSrc(cat, i);
    const summary = (i.stats || []).slice(0, 4).join(", ");
    return `<button class="slot" data-id="${i.id}">${src ? `<img src="${src}" alt="" loading="lazy" decoding="async">` : ""}<span>${isFav(i) ? "\u2605 " : ""}${esc(i.name)}</span><em>${esc(summary)}</em>${i.dyes?.length ? `<small class="dyes">${dyeChips(i)}</small>` : ""}</button>`;
  }).join("");
  $("#more").hidden = found.length <= state.shown;
}

function detail(item) {
  const cat = state.cat, r = item.recipe || {};
  const src = imgSrc(cat, item);
  const list = (arr) => (arr.length ? `<ul>${arr.join("")}</ul>` : "");
  const mats = (r.materials || []).map((m) => `<li>${esc(m.name)}${m.quantity ? ` x${m.quantity}` : ""}</li>`);
  const pts = Object.entries(r.points || {}).map(([k, v]) => `<li>${esc(k)}: ${esc(v)}</li>`);
  if (r.fee) pts.push(`<li>Fee: ${esc(r.fee)}</li>`);
  const stats = (item.stats || []).map((s) => `<li>${esc(s)}</li>`);
  if (item.base_def != null) stats.unshift(`<li>Base DEF: ${item.base_def}</li>`);
  $("#dlg-body").innerHTML = `
    <div class="head">${src ? `<img src="${src}" alt="">` : ""}<div><h2>${esc(item.name)}</h2>${(item.obtain_types || []).map((t) => `<span class="badge">${esc(t)}</span>`).join("")}</div></div>
    ${item.dyes?.length ? `<h3>Dyes</h3><div class="dyes">${dyeChips(item)}</div>` : ""}
    ${stats.length ? `<h3>Stats</h3>${list(stats)}` : ""}
    ${mats.length || pts.length ? `<h3>Recipe</h3>${list(mats.concat(pts))}` : ""}
    ${item.obtained_from?.text ? `<h3>Obtained from</h3><p>${esc(item.obtained_from.text)}</p>` : ""}`;
  const fb = document.createElement("button");
  fb.type = "button"; fb.className = "fav";
  const label = () => (fb.textContent = isFav(item) ? "Remove from favorites" : "Add to favorites");
  label();
  fb.onclick = () => { toggleFav(item); label(); render(); };
  $("#dlg-body").append(fb);
  $("#dlg").showModal();
}

$("#q").oninput = (e) => { state.q = e.target.value.trim().toLowerCase(); state.shown = PAGE; render(); };
$("#type").onchange = (e) => { state.type = e.target.value; state.shown = PAGE; render(); };
$("#more").onclick = () => { state.shown += PAGE; render(); };
$("#items").onclick = (e) => {
  const b = e.target.closest(".slot");
  if (b) detail(state.items.find((i) => String(i.id) === b.dataset.id));
};
for (const v of ["grid", "list"]) {
  $("#v-" + v).onclick = () => {
    state.view = v; prefs.view = v; savePrefs();
    $("#v-grid").setAttribute("aria-pressed", v === "grid");
    $("#v-list").setAttribute("aria-pressed", v === "list");
    render();
  };
}
$("#favonly").onchange = (e) => { state.favOnly = prefs.favOnly = e.target.checked; savePrefs(); state.shown = PAGE; if (state.cat) render(); };

// Account area. Signing in is optional: guests just see a reminder.
function showAccount() {
  const owner = !!user && user.email === `${CFG.ownerUsername}@${CFG.emailDomain}`.toLowerCase();
  $("#acct").innerHTML = user
    ? `${owner ? '<a href="admin.html">Owner panel</a> ' : ""}<span>${esc(user.email.split("@")[0])}</span> <button id="out">Sign out</button>`
    : remote ? `<a href="account.html?next=index.html">Sign in</a>` : "";
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
  if (state.cat) render();
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
        if (state.cat) render();
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
