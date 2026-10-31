const cfg = window.GEAR_CONFIG || {};
const $ = (s) => document.querySelector(s);
const msg = (t) => ($("#msg").textContent = t);
const pretty = (id) => id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const slug = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !cfg.ownerUsername) {
  msg("Fill in config.js first (see SETUP.md).");
} else {
  start();
}

function start() {
  const sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const store = sb.storage.from("site");
  const isOwner = (u) => u?.email === `${cfg.ownerUsername}@${cfg.emailDomain}`.toLowerCase();
  let structure = { groups: [] };   // saved as config/structure.json: groups -> categories
  let files = [];                    // category ids that have a data/<id>.json
  const open = new Set();            // groups currently expanded (all start collapsed)
  let busy = false;                  // true while an upload is running
  let depth = 0;

  function unlockUi() {
    busy = false;
    depth = 0;
    try { document.body.classList.remove("dragging"); } catch {}
    try {
      document.querySelectorAll(".dropbtn.over").forEach((el) => el.classList.remove("over"));
    } catch {}
    const dlg = document.getElementById("preview");
    try { if (dlg && dlg.open) dlg.close(); } catch {}
  }

  let stagedJson = null;             // JSON file chosen for the new category (uploaded when Add category is pressed)
  let stagedImages = [];             // pictures chosen for the new category

  // Always read the newest saved copy (the normal download can come from a cache that is up to a minute old).
  async function download(path) {
    try {
      const r = await fetch(`${cfg.supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/site/${path}?t=${Date.now()}`, { cache: "no-store" });
      return r.ok ? { data: await r.blob() } : { error: { message: `${r.status} ${r.statusText}`.trim() } };
    } catch (err) { return { error: { message: err.message || String(err) } }; }
  }
  // Puts a category in exactly one group (removing it from any other, such as Unsorted).
  function placeCategory(id, name, groupId) {
    if (!id) return null;
    if (!Array.isArray(structure.groups)) structure.groups = [];
    structure.groups.forEach((g) => {
      if (g && Array.isArray(g.categories)) g.categories = g.categories.filter((c) => c.id !== id);
    });
    let grp = structure.groups.find((g) => g && g.id === groupId)
      || structure.groups.find((g) => g && g.id !== "unsorted")
      || structure.groups[0];
    if (!grp) {
      grp = { id: groupId || "unsorted", name: groupId ? pretty(groupId) : "Unsorted", categories: [] };
      structure.groups.push(grp);
    }
    if (!Array.isArray(grp.categories)) grp.categories = [];
    if (!grp.categories.some((c) => c.id === id)) grp.categories.push({ id, name: name || pretty(id) });
    else {
      const c = grp.categories.find((x) => x.id === id);
      if (c && name) c.name = name;
    }
    open.add(grp.id);
    return grp;
  }

  /** Create a group if missing (used when JSON carries group: "Weapon" etc.). */
  function ensureGroup(name) {
    const n = (name || "").trim();
    if (!n) return structure.groups.find((g) => g.id !== "unsorted")?.id || structure.groups[0]?.id || "";
    const id = slug(n);
    let g = structure.groups.find((x) => x.id === id || x.name.toLowerCase() === n.toLowerCase());
    if (!g) {
      g = { id, name: n, categories: [] };
      structure.groups.push(g);
    }
    return g.id;
  }

  /** Read preferred group from scraped JSON (SkillTree.group or _meta.group). */
  function groupFromItems(items) {
    if (!Array.isArray(items) || !items.length) return null;
    const hit = items.find((it) => it && (it.group || it.skill_group));
    const name = hit?.group || hit?.skill_group;
    return name ? String(name) : null;
  }

  /** True when this JSON is a list of skill trees (each with skills[]). */
  function isSkillTreeList(items) {
    if (!Array.isArray(items) || !items.length) return false;
    const n = items.filter((it) => it && (it.type === "SkillTree" || Array.isArray(it.skills))).length;
    return n >= 1 && n === items.length;
  }

  /** Ensure the four Coryn skill groups exist for the owner panel. */
  function ensureSkillGroups() {
    for (const name of ["Weapon", "Buff", "Assist", "Other"]) ensureGroup(name);
  }

  /**
   * Upload each SkillTree as its own category under Weapon/Buff/Assist/Other.
   * Used when the scraper file is skilldatabase_all.json (many trees in one list).
   */
  async function uploadSkillTreesSplit(items, report) {
    ensureSkillGroups();
    let ok = 0;
    for (const tree of items) {
      const name = tree.name || tree.id || "Skill Tree";
      const id = slug(String(name));
      if (!id) { report.push(`Skipped tree with no name`); continue; }
      const gName = tree.group || tree.skill_group || "Other";
      const targetGroup = ensureGroup(gName);
      const one = [tree];
      const file2 = new File([JSON.stringify(one)], `${id}.json`, { type: "application/json" });
      const n = await uploadJson(id, file2, targetGroup, { skipPreview: true });
      if (n === false) { report.push(`${name}: failed`); continue; }
      placeCategory(id, name, targetGroup);
      ok++;
      report.push(`Added/updated ${name} → ${gName}`);
    }
    try { await saveStructure(); } catch {}
    return ok;
  }

  const setAddGroup = (id) => { const s = $("#newgroup"); if ([...s.options].some((o) => o.value === id)) s.value = id; };

  sb.auth.onAuthStateChange((_event, session) => {
    const user = session?.user;
    if (!user) return location.replace("account.html?next=admin.html");
    $("#denied").hidden = isOwner(user);
    $("#panel").hidden = !isOwner(user);
    $("#who").textContent = `Signed in as ${user.email.split("@")[0]}`;
    if (isOwner(user)) setTimeout(load, 0);
  });
  document.querySelectorAll(".signout").forEach((b) => (b.onclick = async () => {
    unlockUi();
    try { await sb.auth.signOut(); } catch {}
    location.replace("account.html");
  }));
  const forceExit = document.getElementById("force-exit");
  if (forceExit) forceExit.onclick = () => { unlockUi(); location.href = "index.html"; };
  const exitPanel = document.getElementById("exit-panel");
  if (exitPanel) exitPanel.addEventListener("click", (e) => { unlockUi(); });

  async function load() {
    const { data, error } = await store.list("data", { limit: 500 });
    if (error) return msg(`Couldn't list categories: ${error.message}`);
    files = data.filter((f) => f.name.endsWith(".json")).map((f) => f.name.replace(/\.json$/, ""));
    const dl = await download("config/structure.json");
    structure = { groups: [] };
    if (!dl.error) { try { structure = JSON.parse(await dl.data.text()); } catch {} }
    structure.groups = (structure.groups || []).map((g) => ({ ...g, categories: (g.categories || []).filter((c) => files.includes(c.id)) }));
    // Categories with a JSON file but no group yet go into "Unsorted" until you move them.
    const known = new Set(structure.groups.flatMap((g) => (g && g.categories) ? g.categories.map((c) => c.id) : []));
    const loose = files.filter((id) => !known.has(id));
    if (loose.length) {
      let u = structure.groups.find((g) => g.id === "unsorted");
      if (!u) structure.groups.push((u = { id: "unsorted", name: "Unsorted", categories: [] }));
      loose.forEach((id) => u.categories.push({ id, name: pretty(id) }));
    }
    render();
  }

  async function saveStructure(done) {
    const out = { groups: structure.groups.filter((g) => g.id !== "unsorted" || g.categories.length) };
    const { error } = await store.upload("config/structure.json", new Blob([JSON.stringify(out)], { type: "application/json" }), {
      upsert: true, contentType: "application/json", cacheControl: "30",
    });
    if (error) return msg(`Couldn't save: ${error.message}`);
    if (done) msg(done);
    render();
  }

  function render() {
    const opts = (sel) => structure.groups.map((g) => `<option value="${esc(g.id)}"${g.id === sel ? " selected" : ""}>${esc(g.name)}</option>`).join("");
    $("#tree").innerHTML = structure.groups.length
      ? structure.groups.map((g) => `
        <div class="grp">
        <div class="grp-head">
          <button type="button" class="grp-toggle" data-act="toggle" data-g="${esc(g.id)}" aria-expanded="${open.has(g.id)}">
            <svg class="chev" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span>${esc(g.name)}</span><small>${g.categories.length}<span class="w"> ${g.categories.length === 1 ? "category" : "categories"}</span></small></button>
          <span><button data-act="ren-group" data-g="${esc(g.id)}">Rename</button> <button data-act="del-group" data-g="${esc(g.id)}" class="danger">Delete</button></span></div>
        <ul class="rows"${open.has(g.id) ? "" : " hidden"}>${g.categories.length ? g.categories.map((c) => `
          <li data-cat="${esc(c.id)}"><span><strong>${esc(c.name)}</strong></span>
            <span><select data-move="${esc(c.id)}" aria-label="Move ${esc(c.name)} to group" title="Move to group (Weapon / Buff / Assist / Other)">${opts(g.id)}</select>
            <button data-act="ren-cat" data-id="${esc(c.id)}">Rename</button>
            <button class="dropbtn" data-act="replace" data-drop="cat" data-id="${esc(c.id)}" title="Drop a JSON file here, or press to choose one" aria-label="Replace ${esc(c.name)} items: drop a JSON file here or press to choose one">JSON</button>
            <button class="dropbtn" data-act="images" data-drop="images" data-id="${esc(c.id)}" title="Drop image files or a folder here, or press to choose images" aria-label="Upload images for ${esc(c.name)}: drop image files here or press to choose them">Image</button>
            <button data-act="del-cat" data-id="${esc(c.id)}" class="danger">Delete</button></span></li>`).join("")
          : `<li class="muted">No categories in this group yet.</li>`}</ul></div>`).join("")
      : `<p class="muted">No groups yet. Add your first group below, for example Equipment.</p>`;
    $("#newgroup").innerHTML = opts($("#newgroup").value);
  }

  const findCat = (id) => {
    for (const g of structure.groups) { const c = g.categories.find((x) => x.id === id); if (c) return { g, c }; }
  };

  // Shows what is about to be uploaded and warns about common problems before anything is replaced.
  async function confirmPreview(id, items, file, groupId) {
    const dlg = $("#preview");
    const name = findCat(id)?.c.name || pretty(id);
    const replacing = files.includes(id);
    let before = null;
    if (replacing) {
      try { const dl = await download(`data/${id}.json`); if (!dl.error) before = JSON.parse(await dl.data.text()).length; } catch {}
    }
    const rows = items.filter((i) => i && typeof i === "object");
    const noName = items.length - rows.filter((i) => String(i.name ?? "").trim()).length;
    const noId = items.length - rows.filter((i) => i.id != null).length;
    const ids = rows.map((i) => i.id).filter((x) => x != null).map(String);
    const dupes = ids.length - new Set(ids).size;
    const warn = [];
    if (!items.length) warn.push("This file has no items, so there is nothing to upload.");
    if (noName) warn.push(`${noName} item${noName > 1 ? "s have" : " has"} no name.`);
    if (noId) warn.push(`${noId} item${noId > 1 ? "s have" : " has"} no id, so favorites and links won't work for ${noId > 1 ? "them" : "it"}.`);
    if (dupes) warn.push(`${dupes} item${dupes > 1 ? "s share" : " shares"} an id with another item.`);
    if (before && items.length < before * 0.5) warn.push(`The current category has ${before} items. This file has far fewer.`);
    const sample = rows.slice(0, 5).map((i) => `<li>${esc(i.name ?? "(no name)")}</li>`).join("");
    $("#preview-body").innerHTML = `<h2>${replacing ? "Replace" : "Add"} ${esc(name)}?</h2>
      <p><strong>${items.length}</strong> item${items.length === 1 ? "" : "s"} in <code>${esc(file.name)}</code>${before != null ? `, replacing the current <strong>${before}</strong>` : ""}.</p>
      ${replacing ? "" : `<p>It will be added to the group <strong>${esc((structure.groups.find((g) => g.id === groupId) || structure.groups[0])?.name || "")}</strong>.</p>`}
      ${warn.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
      ${sample ? `<p class="muted">First items:</p><ul>${sample}</ul>` : ""}`;
    $("#pv-go").disabled = !items.length;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        try {
          dlg.returnValue = ok ? "go" : "cancel";
          if (dlg.open) dlg.close();
        } catch {}
        resolve(!!ok);
      };
      dlg.addEventListener("close", () => finish(dlg.returnValue === "go"), { once: true });
      // Do NOT preventDefault on cancel — Escape must dismiss the modal or the page stays locked
      dlg.addEventListener("cancel", () => { dlg.returnValue = "cancel"; }, { once: true });
      $("#pv-go").onclick = () => finish(true);
      $("#pv-cancel").onclick = () => finish(false);
      dlg.returnValue = "cancel";
      try { dlg.showModal(); } catch { finish(false); }
    });
  }

  async function uploadJson(id, file, groupId, { skipPreview = false } = {}) {
    let items;
    try { items = JSON.parse(await file.text()); } catch { msg("That file isn't valid JSON, so nothing was uploaded."); return false; }
    if (!Array.isArray(items)) { msg("Expected a JSON list of items (like additionalgear.json). Nothing was uploaded."); return false; }
    if (!skipPreview && !(await confirmPreview(id, items, file, groupId))) {
      msg("Upload cancelled. Nothing was changed.");
      return false;
    }
    msg(`Uploading ${items.length} items...`);
    const blob = new Blob([JSON.stringify(items)], { type: "application/json" });
    const { error } = await store.upload(`data/${id}.json`, blob, { upsert: true, contentType: "application/json", cacheControl: "60" });
    if (error) { msg(`Upload failed: ${error.message}`); return false; }
    if (!files.includes(id)) files.push(id);
    return items.length;
  }

  $("#tree").onclick = async (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const { act, g: gid, id } = el.dataset;
    const grp = structure.groups.find((x) => x.id === gid);
    if (act === "toggle") {
      open.has(gid) ? open.delete(gid) : open.add(gid);
      render();
      if (open.has(gid)) setAddGroup(gid);
      $("#tree").querySelector(`.grp-toggle[data-g="${CSS.escape(gid)}"]`)?.focus();
    } else if (act === "ren-group") {
      const name = prompt("New group name:", grp.name)?.trim();
      if (name) { grp.name = name; saveStructure(`Group renamed to ${name}.`); }
    } else if (act === "del-group") {
      if (grp.categories.length) return msg("Move or delete this group's categories first.");
      if (confirm(`Delete the group ${grp.name}?`)) { structure.groups = structure.groups.filter((x) => x !== grp); saveStructure("Group deleted."); }
    } else if (act === "ren-cat") {
      const { c } = findCat(id);
      const name = prompt("New category name:", c.name)?.trim();
      if (name) { c.name = name; saveStructure(`Category renamed to ${name}.`); }
    } else if (act === "replace") {
      const input = Object.assign(document.createElement("input"), { type: "file", accept: ".json,application/json" });
      input.onchange = async () => {
        const n = input.files[0] && (await uploadJson(id, input.files[0]));
        if (n) msg(`Saved ${n} items to ${findCat(id).c.name}.`);
      };
      input.click();
    } else if (act === "images") {
      chooseImages(findCat(id)?.c.name || pretty(id));
    } else if (act === "del-cat") {
      const { g, c } = findCat(id);
      if (!confirm(`Delete ${c.name} from the site? Images are kept.`)) return;
      const { error } = await store.remove([`data/${id}.json`]);
      if (error) return msg(`Delete failed: ${error.message}`);
      files = files.filter((x) => x !== id);
      g.categories = g.categories.filter((x) => x !== c);
      saveStructure(`${c.name} deleted.`);
    }
  };

  $("#tree").onchange = (e) => {
    const id = e.target.dataset.move;
    if (!id) return;
    const { g, c } = findCat(id);
    const to = structure.groups.find((x) => x.id === e.target.value);
    g.categories = g.categories.filter((x) => x !== c);
    to.categories.push(c);
    open.add(to.id);
    saveStructure(`${c.name} moved to ${to.name}.`);
  };

  $("#expand-all").onclick = () => { structure.groups.forEach((g) => open.add(g.id)); render(); };
  $("#collapse-all").onclick = () => { open.clear(); render(); };

  $("#gbtn").onclick = async () => {
    const name = $("#gname").value.trim(), id = slug(name);
    if (!id) return msg("Type a group name first.");
    if (structure.groups.some((g) => g.id === id)) return msg("A group with that name already exists.");
    structure.groups.push({ id, name, categories: [] });
    $("#gname").value = "";
    open.add(id);
    await saveStructure(`Group ${name} added. Now add a category to it below.`);
    setAddGroup(id);
    $("#tree").querySelector(".newcat-name")?.focus();
  };

  // ---- Add a category: name + group + (optional) JSON + (optional) pictures, then press "Add category" ----
  function showStaged() {
    $("#newbtn").textContent = stagedJson ? "JSON \u2713" : "JSON";
    $("#newbtn").title = stagedJson ? stagedJson.name : "Drop a JSON file here, or press to choose one";
    $("#newimg").textContent = stagedImages.length ? `Image (${stagedImages.length})` : "Image";
    $("#newimg").title = stagedImages.length ? `${stagedImages.length} picture(s) chosen` : "Drop image files or a folder here, or press to choose images";
  }
  function stageJson(file) {
    if (!file) return;
    stagedJson = file;
    const box = $("#newname");
    if (!box.value.trim()) box.value = pretty(file.name.replace(/\.json$/i, ""));
    showStaged();
    msg(`${file.name} chosen. Press Add category to save it.`);
  }
  function stageImages(list) {
    const pics = list.filter(isImage);
    if (!pics.length) return msg("No pictures were chosen.");
    stagedImages = pics;
    showStaged();
    msg(`${pics.length} picture${pics.length > 1 ? "s" : ""} chosen. Press Add category to upload ${pics.length > 1 ? "them" : "it"}.`);
  }
  const pick = (accept, multiple, cb) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept, multiple });
    input.onchange = () => cb([...input.files]);
    input.click();
  };
  $("#newbtn").onclick = () => pick(".json,application/json", false, (f) => stageJson(f[0]));
  $("#newimg").onclick = () => pick("image/*", true, stageImages);

  $("#addcat").onclick = async () => {
    if (busy) return msg("Still uploading. Wait for it to finish.");
    const name = $("#newname").value.trim(), id = slug(name), groupId = $("#newgroup").value;
    if (!id) return msg("Type a category name first.");
    if (!structure.groups.length || !groupId) return msg("Add a group first, for example Equipment.");
    if (files.includes(id)) return msg("A category with that name already exists. Use its JSON button in the list to replace it instead.");
    busy = true;
    try {
      if (stagedJson) {
        if (!(await uploadJson(id, stagedJson, groupId))) return;
      } else {
        // No JSON chosen: create the category empty so it is registered in its group right away.
        const { error } = await store.upload(`data/${id}.json`, new Blob(["[]"], { type: "application/json" }), { upsert: true, contentType: "application/json", cacheControl: "60" });
        if (error) return msg(`Couldn't create the category: ${error.message}`);
        files.push(id);
      }
      const grp = placeCategory(id, name, groupId);
      let extra = "";
      if (stagedImages.length) {
        const { done, failed } = await uploadImages(stagedImages);
        extra = ` Images: ${done} uploaded${failed ? `, ${failed} failed` : ""}.`;
      }
      stagedJson = null; stagedImages = [];
      $("#newname").value = "";
      showStaged();
      await saveStructure(`${name} added to ${grp.name}.${extra}`);
      setAddGroup(grp.id);
    } finally { busy = false; }
  };

  function chooseImages(label) {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: "image/*", multiple: true });
    input.onchange = async () => {
      const list = [...input.files].filter(isImage);
      if (!list.length) return msg("No pictures were chosen.");
      const { done, failed } = await uploadImages(list);
      msg(`Images${label ? ` for ${label}` : ""}: ${done} uploaded${failed ? `, ${failed} failed. Press Image to try again.` : "."}`);
    };
    input.click();
  }
  // ---- Images: one folder for all categories ----
  const isImage = (f) => /\.(webp|png|jpe?g|gif|svg)$/i.test(f.name);

  async function uploadImages(list) {
    let done = 0, failed = 0, next = 0;
    const worker = async () => {
      while (next < list.length) {
        const f = list[next++];
        const { error } = await store.upload(`images/${f.name}`, f, { upsert: true, contentType: f.type || "image/webp", cacheControl: "31536000" });
        error ? failed++ : done++;
        msg(`Uploading images: ${done + failed}/${list.length}${failed ? ` (${failed} failed)` : ""}`);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return { done, failed };
  }

  // ---- Drag and drop: JSON files and images (single files or whole folders) ----
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");

  function endDrag() {
    depth = 0;
    document.body.classList.remove("dragging");
    document.querySelectorAll(".dropbtn.over").forEach((el) => el.classList.remove("over"));
  }

  // Reads everything that was dropped, including the contents of dropped folders.
  // The scraper's "cache" folder is skipped because the site doesn't need it.
  async function filesFromDrop(dt) {
    const fallback = [...dt.files];   // collected right away: the drop data is only valid during the event
    const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length) return fallback;
    const out = [];
    const walk = async (entry) => {
      if (entry.isFile) {
        out.push(await new Promise((ok, fail) => entry.file(ok, fail)));
      } else if (entry.isDirectory && entry.name !== "cache") {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((ok, fail) => reader.readEntries(ok, fail));
          if (!batch.length) break;
          for (const child of batch) await walk(child);
        }
      }
    };
    for (const entry of entries) await walk(entry);
    return out;
  }

  // target: { mode: "cat", id } (replace one category), { mode: "new" } (add a category) or { mode: "images" }
  async function handleDrop(dt, target) {
    if (target.mode === "stage-json" || target.mode === "stage-img") {
      const got = await filesFromDrop(dt);
      if (target.mode === "stage-img") return stageImages(got);
      // Whole scraper output folder (many JSON + images) → bulk upload
      const j = got.filter((f) => /\.json$/i.test(f.name) && !/needs_review/i.test(f.name));
      const imgs = got.filter(isImage);
      if (j.length > 1 || (j.length >= 1 && imgs.length > 0)) {
        if (busy) return msg("Still uploading the last drop. Wait for it to finish, then drop again.");
        busy = true;
        try {
          const groupId = $("#newgroup").value;
          const report = [];
          const jsonFiles = j.filter((f) => !/structure_hint|needs_review/i.test(f.name));
          if (jsonFiles.length > 1) {
            if (!confirm(`Upload ${jsonFiles.length} JSON files now? Categories with the same name will be replaced. (One confirmation — you will not be asked for each file.)`)) {
              msg("Bulk upload cancelled.");
              return;
            }
          }
          for (const file of jsonFiles) {
            let rawName = file.name.replace(/\.json$/i, "").replace(/^items_/, "").replace(/^monsters_/, "").replace(/^maps_/, "").replace(/^quests_/, "").replace(/^skilldatabase_/, "");
            let name = pretty(rawName);
            let id = slug(name);
            if (!id) { report.push(`Skipped ${file.name}`); continue; }
            let items = null;
            try { items = JSON.parse(await file.text()); } catch { report.push(`Skipped ${file.name}: invalid JSON`); continue; }
            if (!Array.isArray(items)) { report.push(`Skipped ${file.name}: not a JSON list`); continue; }
            // skilldatabase_all: one file, many trees → split into Weapon/Buff/Assist/Other
            if (isSkillTreeList(items) && items.length > 1) {
              report.push(`Splitting ${file.name} into ${items.length} skill trees by group...`);
              await uploadSkillTreesSplit(items, report);
              continue;
            }
            const file2 = new File([JSON.stringify(items)], file.name, { type: "application/json" });
            const gName = groupFromItems(items);
            const targetGroup = gName ? ensureGroup(gName) : groupId;
            if (!targetGroup && !structure.groups.length) {
              report.push(`Skipped ${file.name}: add a group first`); continue;
            }
            const exists = files.includes(id);
            const n = await uploadJson(id, file2, targetGroup, { skipPreview: jsonFiles.length > 1 });
            if (n === false) { report.push(`${file.name}: cancelled or failed`); continue; }
            placeCategory(id, name, targetGroup || groupId);
            report.push(`${exists ? "Updated" : "Added"} ${name} (${n} items)${gName ? ` → ${gName}` : ""}.`);
          }
          try { await saveStructure(); } catch {}
          if (imgs.length) {
            const { done, failed } = await uploadImages(imgs);
            report.push(`Images: ${done} uploaded${failed ? `, ${failed} failed` : ""}.`);
          }
          msg(report.join(" ") || "Nothing uploaded.");
        } catch (err) {
          msg(`Something went wrong: ${err.message || err}`);
        } finally {
          busy = false;
        }
        return;
      }
      if (j.length === 1) return stageJson(j[0]);
      return msg("Nothing to use. Drop a .json file, or the whole scraper output folder.");
    }
    if (busy) return msg("Still uploading the last drop. Wait for it to finish, then drop again.");
    busy = true;
    try {
      msg("Reading dropped files...");
      const dropped = await filesFromDrop(dt);
      const jsons = target.mode === "images" ? [] : dropped.filter((f) => /\.json$/i.test(f.name) && !/needs_review/i.test(f.name));
      const images = target.mode === "images" ? dropped.filter(isImage) : [];
      if (!jsons.length && !images.length) return msg(target.mode === "images" ? "Nothing to upload. Drop image files, or a folder that has them." : "Nothing to upload. Drop a .json file here.");
      if (target.mode === "cat" && jsons.length > 1) return msg("Drop just one JSON file on a category.");
      const rowId = target.mode === "cat" ? target.id : null;
      const groupId = $("#newgroup").value;
      const report = [];

      for (const file of jsons) {
        let id, name, replacing = false;
        if (rowId) {                                   // dropped on a category's Drop file button: replace that category
          id = rowId;
          name = findCat(id)?.c.name || pretty(id);
          replacing = true;
        } else {
          name = (jsons.length === 1 && ($("#newname").value.trim())) || pretty(file.name.replace(/\.json$/i, "").replace(/^skilldatabase_/, ""));
          id = slug(name);
          if (!id) { report.push(`Skipped ${file.name}: couldn't make a category name from it.`); continue; }
          if (files.includes(id)) {
            if (!confirm(`${name} already exists. Replace its items with ${file.name}?`)) { report.push(`Skipped ${file.name}.`); continue; }
            replacing = true;
          } else if (!structure.groups.length) {
            report.push(`Skipped ${file.name}: add a group first, for example Equipment.`);
            continue;
          }
        }
        let parsed = null;
        try { parsed = JSON.parse(await file.text()); } catch {}
        const file2 = parsed ? new File([JSON.stringify(parsed)], file.name, { type: "application/json" }) : file;
        const gName = Array.isArray(parsed) ? groupFromItems(parsed) : null;
        const targetGroup = gName ? ensureGroup(gName) : groupId;
        const n = await uploadJson(id, file2, targetGroup);
        if (n === false) { report.push(`${file.name}: ${$("#msg").textContent}`); continue; }
        if (!replacing || !findCat(id)) {
          placeCategory(id, name, targetGroup);
          $("#newname").value = "";
          await saveStructure();
        } else if (gName) {
          placeCategory(id, findCat(id)?.c.name || name, targetGroup);
          await saveStructure();
        }
        report.push(`${replacing ? "Replaced" : "Added"} ${name} (${n} items)${gName ? ` → ${gName}` : ""}.`);
      }

      if (images.length) {
        const { done, failed } = await uploadImages(images);
        report.push(`Images: ${done} uploaded${failed ? `, ${failed} failed (drop them again to retry)` : ""}.`);
      }
      const ignored = dropped.length - jsons.length - images.length;
      if (ignored > 0) report.push(`Ignored ${ignored} other file${ignored > 1 ? "s" : ""}.`);
      msg(report.join(" "));
    } catch (err) {
      msg(`Something went wrong: ${err.message || err}`);
    } finally {
      busy = false;
    }
  }

  const targetOf = (e) => {
    const b = e.target.closest?.(".dropbtn[data-drop]");
    if (!b) return null;
    if (b.dataset.drop === "cat") return { mode: "cat", id: b.dataset.id };
    return { mode: b.dataset.drop };
  };
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    document.body.classList.add("dragging");
  });
  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const btn = targetOf(e) && e.target.closest(".dropbtn");
    e.dataTransfer.dropEffect = btn ? "copy" : "none";
    document.querySelectorAll(".dropbtn.over").forEach((el) => el !== btn && el.classList.remove("over"));
    btn?.classList.add("over");
  });
  window.addEventListener("dragleave", (e) => {
    if (hasFiles(e) && --depth <= 0) endDrag();
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();                 // stops the browser from opening the file instead
    const target = targetOf(e);
    endDrag();
    if (!target || $("#panel").hidden) return;
    handleDrop(e.dataTransfer, target);
  });
  // If a drag was cancelled outside the window, depth can stick — clear it
  window.addEventListener("dragend", endDrag);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") endDrag(); });
  // Escape always unlocks UI (stuck modal / drag overlay)
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") unlockUi();
  });
  // Safety: never leave the page locked after load
  unlockUi();
}


  // ---- App version + pack size (owner only) ----
  function nextAppVersion(prev) {
    const m = String(prev || "").trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (m) return `${+m[1]}.${+m[2]}.${+m[3] + 1}`;
    // date-based first version
    const d = new Date();
    return `1.0.0`;
  }
  async function loadPublishedMeta() {
    try {
      const r = await download("config/app-version.json");
      if (!r) return null;
      return await r.json();
    } catch { return null; }
  }
  async function refreshPubVer() {
    const elV = $("#pub-ver"), elB = $("#pub-bytes");
    if (!elV) return;
    const meta = await loadPublishedMeta();
    if (!meta) { elV.textContent = "none yet"; if (elB) elB.textContent = ""; return; }
    elV.textContent = meta.version || "—";
    if (elB) elB.textContent = meta.total_bytes ? `${(meta.total_bytes/1048576).toFixed(1)} MB` : "";
  }
  let lastMeasure = null;
  const btnM = $("#btn-measure-pack");
  const btnP = $("#btn-publish-ver");
  const out = $("#measure-out");
  if (btnM) {
    btnM.onclick = async () => {
      if (!window.opener && !location.pathname.includes("admin")) { /* ok */ }
      btnM.disabled = true;
      if (out) out.textContent = "Measuring… open the main site in another tab if this fails (needs app helpers).";
      try {
        // Measure using public HEAD from admin context — duplicate light estimate
        const base = `${cfg.supabaseUrl}/storage/v1/object/public/site`;
        const listRes = await fetch(`${cfg.supabaseUrl}/storage/v1/object/list/site`, {
          method: "POST",
          headers: { apikey: cfg.supabaseAnonKey, Authorization: `Bearer ${cfg.supabaseAnonKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ prefix: "data", limit: 500 }),
        });
        const files = (await listRes.json()).filter((f) => f.name.endsWith(".json"));
        let dataBytes = 0, imgBytes = 0, imgN = 0, miss = 0;
        const names = new Set();
        for (const f of files) {
          const url = `${base}/data/${encodeURIComponent(f.name)}`;
          try {
            const h = await fetch(url, { method: "HEAD", cache: "no-cache" });
            const len = parseInt(h.headers.get("content-length") || "0", 10);
            dataBytes += len > 0 ? len : 150000;
            const r = await fetch(url, { cache: "force-cache" });
            if (r.ok) {
              const items = await r.json();
              const walk = (o) => {
                if (!o || typeof o !== "object") return;
                if (Array.isArray(o)) return o.forEach(walk);
                for (const [k, v] of Object.entries(o)) {
                  if (/image|icon|src|file/i.test(k) && typeof v === "string" && /\.(png|jpe?g|gif|webp|svg)$/i.test(v)) {
                    names.add(v.split(/[\\/]/).pop().split("?")[0]);
                  } else if (typeof v === "object") walk(v);
                }
              };
              walk(items);
            }
          } catch {}
          if (out) out.textContent = `Lists… ${files.indexOf(f)+1}/${files.length}`;
        }
        const arr = [...names];
        imgN = arr.length;
        let i = 0;
        async function worker() {
          while (i < arr.length) {
            const name = arr[i++];
            try {
              const h = await fetch(`${base}/images/${encodeURIComponent(name)}`, { method: "HEAD", cache: "no-cache" });
              if (!h.ok) { miss++; continue; }
              const len = parseInt(h.headers.get("content-length") || "0", 10);
              imgBytes += len > 0 ? len : 8000;
            } catch { miss++; }
            if (out && i % 40 === 0) out.textContent = `Images… ${i}/${arr.length}`;
          }
        }
        await Promise.all(Array.from({ length: 12 }, () => worker()));
        const total = dataBytes + imgBytes;
        lastMeasure = { total_bytes: total, data_bytes: dataBytes, image_bytes: imgBytes, image_count: imgN, missing: miss };
        if (out) out.textContent = `Measured ~${(total/1048576).toFixed(1)} MB (lists ${(dataBytes/1048576).toFixed(1)} + images ${(imgBytes/1048576).toFixed(1)}, ${imgN} files, ${miss} missing). Press Publish new version.`;
      } catch (err) {
        if (out) out.textContent = `Measure failed: ${err.message || err}`;
      }
      btnM.disabled = false;
    };
  }
  if (btnP) {
    btnP.onclick = async () => {
      btnP.disabled = true;
      try {
        const prev = await loadPublishedMeta();
        const version = nextAppVersion(prev && prev.version);
        const total_bytes = (lastMeasure && lastMeasure.total_bytes) || (prev && prev.total_bytes) || 0;
        if (!total_bytes) {
          alert("Measure pack size first (or a previous total is missing).");
          btnP.disabled = false;
          return;
        }
        const body = {
          version,
          total_bytes,
          data_bytes: lastMeasure?.data_bytes || null,
          image_bytes: lastMeasure?.image_bytes || null,
          image_count: lastMeasure?.image_count || null,
          missing: lastMeasure?.missing || null,
          updated_at: new Date().toISOString(),
        };
        const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
        const path = "config/app-version.json";
        // upload via supabase storage
        const up = await fetch(`${cfg.supabaseUrl}/storage/v1/object/site/${path}`, {
          method: "POST",
          headers: {
            apikey: cfg.supabaseAnonKey,
            Authorization: `Bearer ${(await sb.auth.getSession()).data.session?.access_token || cfg.supabaseAnonKey}`,
            "Content-Type": "application/json",
            "x-upsert": "true",
          },
          body: blob,
        });
        if (!up.ok) throw new Error(await up.text());
        if (out) out.textContent = `Published version ${version} · ${(total_bytes/1048576).toFixed(1)} MB`;
        await refreshPubVer();
      } catch (err) {
        alert("Publish failed: " + (err.message || err));
      }
      btnP.disabled = false;
    };
  }
  refreshPubVer();
