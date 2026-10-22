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

  // Always read the newest saved copy (the normal download can come from a cache that is up to a minute old).
  async function download(path) {
    try {
      const r = await fetch(`${cfg.supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/site/${path}?t=${Date.now()}`, { cache: "no-store" });
      return r.ok ? { data: await r.blob() } : { error: { message: `${r.status} ${r.statusText}`.trim() } };
    } catch (err) { return { error: { message: err.message || String(err) } }; }
  }
  // Puts a category in exactly one group (removing it from any other, such as Unsorted).
  function placeCategory(id, name, groupId) {
    structure.groups.forEach((g) => { g.categories = g.categories.filter((c) => c.id !== id); });
    const grp = structure.groups.find((g) => g.id === groupId) || structure.groups.find((g) => g.id !== "unsorted") || structure.groups[0];
    grp.categories.push({ id, name });
    open.add(grp.id);
    return grp;
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
  document.querySelectorAll(".signout").forEach((b) => (b.onclick = () => sb.auth.signOut()));

  async function load() {
    const { data, error } = await store.list("data", { limit: 500 });
    if (error) return msg(`Couldn't list categories: ${error.message}`);
    files = data.filter((f) => f.name.endsWith(".json")).map((f) => f.name.replace(/\.json$/, ""));
    const dl = await download("config/structure.json");
    structure = { groups: [] };
    if (!dl.error) { try { structure = JSON.parse(await dl.data.text()); } catch {} }
    structure.groups = (structure.groups || []).map((g) => ({ ...g, categories: (g.categories || []).filter((c) => files.includes(c.id)) }));
    // Categories with a JSON file but no group yet go into "Unsorted" until you move them.
    const known = new Set(structure.groups.flatMap((g) => g.categories.map((c) => c.id)));
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
            <span><select data-move="${esc(c.id)}" aria-label="Move ${esc(c.name)} to group">${opts(g.id)}</select>
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
      dlg.addEventListener("close", () => resolve(dlg.returnValue === "go"), { once: true });
      $("#pv-go").onclick = () => dlg.close("go");
      $("#pv-cancel").onclick = () => dlg.close("cancel");
      dlg.returnValue = "cancel";
      dlg.showModal();
    });
  }

  async function uploadJson(id, file, groupId) {
    let items;
    try { items = JSON.parse(await file.text()); } catch { msg("That file isn't valid JSON, so nothing was uploaded."); return false; }
    if (!Array.isArray(items)) { msg("Expected a JSON list of items (like additionalgear.json). Nothing was uploaded."); return false; }
    if (!(await confirmPreview(id, items, file, groupId))) { msg("Upload cancelled. Nothing was changed."); return false; }
    msg(`Uploading ${items.length} items...`);
    const { error } = await store.upload(`data/${id}.json`, file, { upsert: true, contentType: "application/json", cacheControl: "60" });
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
    await saveStructure(`Group ${name} added. New categories will go in it.`);
    setAddGroup(id);
  };

  $("#newbtn").onclick = () => {
    if (!slug($("#newname").value)) return msg("Type a category name first.");
    if (!structure.groups.length) return msg("Add a group first, for example Equipment.");
    if (files.includes(slug($("#newname").value))) return msg("A category with that name already exists. Use its JSON button to replace it instead.");
    $("#newfile").click();
  };
  $("#newfile").onchange = async (e) => {
    const file = e.target.files[0], name = $("#newname").value.trim(), id = slug(name);
    const groupId = $("#newgroup").value;          // the group chosen right now, before any waiting
    e.target.value = "";
    if (!file) return;
    const n = await uploadJson(id, file, groupId);
    if (!n) return;
    const grp = placeCategory(id, name, groupId);
    $("#newname").value = "";
    saveStructure(`Saved ${n} items to ${name} in ${grp.name}.`);
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
  $("#newimg").onclick = () => chooseImages($("#newname").value.trim());

  // ---- Backup and restore ----
  $("#backup").onclick = async () => {
    if (!files.length) return msg("There are no categories to back up yet.");
    msg("Collecting your data...");
    const out = { app: "codex-arcane", version: 1, saved: new Date().toISOString(), structure: { groups: structure.groups.filter((g) => g.id !== "unsorted" || g.categories.length) }, categories: {} };
    let total = 0;
    for (const id of files) {
      const dl = await download(`data/${id}.json`);
      if (dl.error) return msg(`Backup stopped: couldn't read ${pretty(id)} (${dl.error.message}). Nothing was downloaded.`);
      try { out.categories[id] = JSON.parse(await dl.data.text()); } catch { return msg(`Backup stopped: ${pretty(id)} isn't valid JSON.`); }
      total += out.categories[id].length;
      msg(`Collecting... ${Object.keys(out.categories).length}/${files.length}`);
    }
    const link = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob([JSON.stringify(out)], { type: "application/json" })),
      download: `codex-arcane-backup-${new Date().toISOString().slice(0, 10)}.json`,
    });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    msg(`Backup downloaded: ${files.length} categories, ${total} items. Pictures are not included.`);
  };

  $("#restore").onclick = () => $("#restorefile").click();
  $("#restorefile").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { return msg("That file isn't valid JSON. Nothing was restored."); }
    const ids = data && data.app === "codex-arcane" && data.categories && typeof data.categories === "object" ? Object.keys(data.categories) : null;
    if (!ids) return msg("That doesn't look like a Codex Arcane backup file. Nothing was restored.");
    if (ids.some((id) => !/^[A-Za-z0-9_-]+$/.test(id) || !Array.isArray(data.categories[id]))) return msg("The backup file has a category that can't be read. Nothing was restored.");
    const total = ids.reduce((n, id) => n + data.categories[id].length, 0);
    const clash = ids.filter((id) => files.includes(id)).length;
    if (!confirm(`Restore ${ids.length} categories (${total} items) from ${file.name}?${clash ? `\n\n${clash} of them already exist and will be replaced.` : ""}\n\nMake a fresh backup first if you aren't sure.`)) return msg("Restore cancelled. Nothing was changed.");
    let done = 0;
    for (const id of ids) {
      const { error } = await store.upload(`data/${id}.json`, new Blob([JSON.stringify(data.categories[id])], { type: "application/json" }), { upsert: true, contentType: "application/json", cacheControl: "60" });
      if (error) return msg(`Restore stopped at ${pretty(id)}: ${error.message}. ${done} categories were restored before that.`);
      msg(`Restoring... ${++done}/${ids.length}`);
    }
    if (data.structure && Array.isArray(data.structure.groups)) {
      const { error } = await store.upload("config/structure.json", new Blob([JSON.stringify(data.structure)], { type: "application/json" }), { upsert: true, contentType: "application/json", cacheControl: "30" });
      if (error) msg(`Items were restored, but the menu layout wasn't: ${error.message}`);
    }
    await load();
    msg(`Restored ${ids.length} categories (${total} items).`);
  };

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
  let depth = 0, busy = false;

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
    if (busy) return msg("Still uploading the last drop. Wait for it to finish, then drop again.");
    busy = true;
    try {
      msg("Reading dropped files...");
      const dropped = await filesFromDrop(dt);
      const jsons = target.mode === "images" ? [] : dropped.filter((f) => /\.json$/i.test(f.name));
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
        } else {                                       // new category, named after the file (or the name box if filled in)
          name = (jsons.length === 1 && $("#newname").value.trim()) || pretty(file.name.replace(/\.json$/i, ""));
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
        const n = await uploadJson(id, file, groupId);
        if (n === false) { report.push(`${file.name}: ${$("#msg").textContent}`); continue; }
        if (!replacing || !findCat(id)) {
          placeCategory(id, name, groupId);
          $("#newname").value = "";
          await saveStructure();
        }
        report.push(`${replacing ? "Replaced" : "Added"} ${name} (${n} items).`);
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
    return b.dataset.drop === "cat" ? { mode: "cat", id: b.dataset.id } : { mode: b.dataset.drop };
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
}
