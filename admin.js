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

  // Fires once on load with the current session, then on every sign in or out.
  sb.auth.onAuthStateChange((_event, session) => {
    const user = session?.user;
    if (!user) return location.replace("account.html?next=admin.html");
    $("#denied").hidden = isOwner(user);
    $("#panel").hidden = !isOwner(user);
    $("#who").textContent = `Signed in as ${user.email.split("@")[0]}`;
    if (isOwner(user)) setTimeout(refresh, 0);
  });

  document.querySelectorAll(".signout").forEach((b) => (b.onclick = () => sb.auth.signOut()));

  async function refresh() {
    const { data, error } = await store.list("data", { limit: 200 });
    if (error) return msg(`Couldn't list categories: ${error.message}`);
    const files = data.filter((f) => f.name.endsWith(".json"));
    $("#cats").innerHTML = files.length
      ? files.map((f) => {
          const id = f.name.replace(/\.json$/, "");
          const kb = f.metadata?.size ? `${Math.round(f.metadata.size / 1024)} KB` : "";
          return `<li><span><strong>${esc(pretty(id))}</strong> <small class="muted">${kb}</small></span>
            <span><button data-replace="${esc(id)}">Replace JSON</button> <button data-delete="${esc(id)}" class="danger">Delete</button></span></li>`;
        }).join("")
      : `<li class="muted">No categories yet. Add the first one below.</li>`;
  }

  async function uploadJson(id, file) {
    let items;
    try {
      items = JSON.parse(await file.text());
    } catch {
      return msg("That file isn't valid JSON, so nothing was uploaded.");
    }
    if (!Array.isArray(items)) return msg("Expected a JSON list of items (like additionalgear.json). Nothing was uploaded.");
    msg(`Uploading ${items.length} items...`);
    const { error } = await store.upload(`data/${id}.json`, file, {
      upsert: true,
      contentType: "application/json",
      cacheControl: "60",
    });
    if (error) return msg(`Upload failed: ${error.message}`);
    msg(`Saved ${items.length} items to ${pretty(id)}.`);
    refresh();
  }

  // Replace / delete buttons for existing categories
  $("#cats").onclick = async (e) => {
    const rep = e.target.dataset.replace, del = e.target.dataset.delete;
    if (rep) {
      const input = Object.assign(document.createElement("input"), { type: "file", accept: ".json,application/json" });
      input.onchange = () => input.files[0] && uploadJson(rep, input.files[0]);
      input.click();
    } else if (del && confirm(`Delete ${pretty(del)} from the site? Images are kept.`)) {
      const { error } = await store.remove([`data/${del}.json`]);
      msg(error ? `Delete failed: ${error.message}` : `${pretty(del)} deleted.`);
      refresh();
    }
  };

  // New category
  $("#newbtn").onclick = () => {
    if (!slug($("#newname").value)) return msg("Type a category name first.");
    $("#newfile").click();
  };
  $("#newfile").onchange = async (e) => {
    const file = e.target.files[0];
    if (file) await uploadJson(slug($("#newname").value), file);
    e.target.value = "";
    $("#newname").value = "";
  };

  // Images: one folder for all categories
  $("#imgbtn").onclick = () => $("#imgfile").click();
  $("#imgfile").onchange = async (e) => {
    const files = [...e.target.files].filter((f) => /\.(webp|png|jpe?g|gif|svg)$/i.test(f.name));
    if (!files.length) return msg("No images found in that folder.");
    let done = 0, failed = 0, next = 0;
    const worker = async () => {
      while (next < files.length) {
        const f = files[next++];
        const { error } = await store.upload(`images/${f.name}`, f, {
          upsert: true,
          contentType: f.type || "image/webp",
          cacheControl: "31536000",
        });
        error ? failed++ : done++;
        msg(`Uploading images: ${done + failed}/${files.length}${failed ? ` (${failed} failed)` : ""}`);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    msg(`Images done: ${done} uploaded${failed ? `, ${failed} failed. Choose the folder again to retry.` : "."}`);
    e.target.value = "";
  };
}
