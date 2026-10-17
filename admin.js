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
    const dl = await store.download("config/structure.json");
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
        <div class="grp-head"><h3>${esc(g.name)}</h3>
          <span><button data-act="ren-group" data-g="${esc(g.id)}">Rename</button> <button data-act="del-group" data-g="${esc(g.id)}" class="danger">Delete</button></span></div>
        <ul class="rows">${g.categories.length ? g.categories.map((c) => `
          <li><span><strong>${esc(c.name)}</strong></span>
            <span><select data-move="${esc(c.id)}" aria-label="Move ${esc(c.name)} to group">${opts(g.id)}</select>
            <button data-act="ren-cat" data-id="${esc(c.id)}">Rename</button>
            <button data-act="replace" data-id="${esc(c.id)}">Replace JSON</button>
            <button data-act="del-cat" data-id="${esc(c.id)}" class="danger">Delete</button></span></li>`).join("")
          : `<li class="muted">No categories in this group yet.</li>`}</ul>`).join("")
      : `<p class="muted">No groups yet. Add your first group below, for example Equipment.</p>`;
    $("#newgroup").innerHTML = opts($("#newgroup").value);
  }

  const findCat = (id) => {
    for (const g of structure.groups) { const c = g.categories.find((x) => x.id === id); if (c) return { g, c }; }
  };

  async function uploadJson(id, file) {
    let items;
    try { items = JSON.parse(await file.text()); } catch { msg("That file isn't valid JSON, so nothing was uploaded."); return false; }
    if (!Array.isArray(items)) { msg("Expected a JSON list of items (like additionalgear.json). Nothing was uploaded."); return false; }
    msg(`Uploading ${items.length} items...`);
    const { error } = await store.upload(`data/${id}.json`, file, { upsert: true, contentType: "application/json", cacheControl: "60" });
    if (error) { msg(`Upload failed: ${error.message}`); return false; }
    if (!files.includes(id)) files.push(id);
    return items.length;
  }

  $("#tree").onclick = async (e) => {
    const { act, g: gid, id } = e.target.dataset;
    if (!act) return;
    const grp = structure.groups.find((x) => x.id === gid);
    if (act === "ren-group") {
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
    saveStructure(`${c.name} moved to ${to.name}.`);
  };

  $("#gbtn").onclick = () => {
    const name = $("#gname").value.trim(), id = slug(name);
    if (!id) return msg("Type a group name first.");
    if (structure.groups.some((g) => g.id === id)) return msg("A group with that name already exists.");
    structure.groups.push({ id, name, categories: [] });
    $("#gname").value = "";
    saveStructure(`Group ${name} added.`);
  };

  $("#newbtn").onclick = () => {
    if (!slug($("#newname").value)) return msg("Type a category name first.");
    if (!structure.groups.length) return msg("Add a group first, for example Equipment.");
    if (files.includes(slug($("#newname").value))) return msg("A category with that name already exists. Use Replace JSON on it instead.");
    $("#newfile").click();
  };
  $("#newfile").onchange = async (e) => {
    const file = e.target.files[0], name = $("#newname").value.trim(), id = slug(name);
    e.target.value = "";
    if (!file) return;
    const n = await uploadJson(id, file);
    if (!n) return;
    const grp = structure.groups.find((g) => g.id === $("#newgroup").value) || structure.groups[0];
    grp.categories.push({ id, name });
    $("#newname").value = "";
    saveStructure(`Saved ${n} items to ${name} in ${grp.name}.`);
  };

  // Images: one folder for all categories
  $("#imgbtn").onclick = () => $("#imgfile").click();
  $("#imgfile").onchange = async (e) => {
    const list = [...e.target.files].filter((f) => /\.(webp|png|jpe?g|gif|svg)$/i.test(f.name));
    if (!list.length) return msg("No images found in that folder.");
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
    msg(`Images done: ${done} uploaded${failed ? `, ${failed} failed. Choose the folder again to retry.` : "."}`);
    e.target.value = "";
  };
}
