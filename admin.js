const cfg = window.GEAR_CONFIG || {};
const $ = (s) => document.querySelector(s);

// Pack measure / publish — bound with delegation so it works even if the panel was hidden at boot.
const CODEX_MEASURE_BOUND = true;
let codexLastMeasure = null;

function codexNextVersion(prev) {
  const m = String(prev || "").trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (m) return `${+m[1]}.${+m[2]}.${+m[3] + 1}`;
  return "1.0.0";
}

function codexMeasureOut(text) {
  const el = document.getElementById("measure-out");
  if (el) el.textContent = text;
  else console.log("[measure]", text);
}

async function codexLoadPublishedMeta() {
  try {
    const base = (cfg.supabaseUrl || "").replace(/\/+$/, "");
    const r = await fetch(`${base}/storage/v1/object/public/site/config/app-version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function codexRefreshPubVer() {
  const elV = document.getElementById("pub-ver");
  const elB = document.getElementById("pub-bytes");
  if (!elV) return;
  const meta = await codexLoadPublishedMeta();
  if (!meta) { elV.textContent = "none yet"; if (elB) elB.textContent = ""; return; }
  elV.textContent = meta.version || "—";
  if (elB) elB.textContent = meta.total_bytes ? `${(meta.total_bytes / 1048576).toFixed(1)} MB` : "";
}

async function codexMeasurePack() {
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    codexMeasureOut("Missing Supabase config in config.js");
    return;
  }
  const btnM = document.getElementById("btn-measure-pack");
  if (btnM) btnM.disabled = true;
  codexMeasureOut("Measuring lists and images… this can take a few minutes. Leave this tab open.");
  try {
    const base = `${cfg.supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/site`;
    const listRes = await fetch(`${cfg.supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/list/site`, {
      method: "POST",
      headers: {
        apikey: cfg.supabaseAnonKey,
        Authorization: `Bearer ${cfg.supabaseAnonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prefix: "data", limit: 500 }),
    });
    if (!listRes.ok) {
      // Fallback: structure.json category list
      const st = await fetch(`${base}/config/structure.json?t=${Date.now()}`, { cache: "no-store" });
      if (!st.ok) throw new Error("Could not list storage (" + listRes.status + ") and no structure.json");
      const structure = await st.json();
      var files = [];
      for (const g of structure.groups || []) {
        for (const c of g.categories || []) {
          if (c && c.id) files.push({ name: c.id + ".json" });
        }
      }
    } else {
      var files = (await listRes.json()).filter((f) => f.name && f.name.endsWith(".json"));
    }
    if (!files.length) throw new Error("No category JSON files found");
    let dataBytes = 0, imgBytes = 0, miss = 0;
    const names = new Set();
    for (let fi = 0; fi < files.length; fi++) {
      const f = files[fi];
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
              } else if (v && typeof v === "object") walk(v);
            }
          };
          walk(items);
        }
      } catch {}
      codexMeasureOut(`Measuring lists… ${fi + 1}/${files.length}`);
    }
    const arr = [...names];
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
        if (i % 30 === 0) codexMeasureOut(`Measuring images… ${i}/${arr.length}`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(12, Math.max(arr.length, 1)) }, () => worker()));
    const total = dataBytes + imgBytes;
    codexLastMeasure = {
      total_bytes: total,
      data_bytes: dataBytes,
      image_bytes: imgBytes,
      image_count: arr.length,
      missing: miss,
    };
    codexMeasureOut(
      `Measured ~${(total / 1048576).toFixed(1)} MB ` +
      `(lists ${(dataBytes / 1048576).toFixed(1)} + images ${(imgBytes / 1048576).toFixed(1)}, ` +
      `${arr.length} image files, ${miss} missing). Press “Publish new version”.`
    );
  } catch (err) {
    console.error(err);
    codexMeasureOut("Measure failed: " + (err.message || err));
  }
  if (btnM) btnM.disabled = false;
}

async function codexPublishVersion() {
  const btnP = document.getElementById("btn-publish-ver");
  if (btnP) btnP.disabled = true;
  try {
    const prev = await codexLoadPublishedMeta();
    const version = codexNextVersion(prev && prev.version);
    const total_bytes = (codexLastMeasure && codexLastMeasure.total_bytes) || (prev && prev.total_bytes) || 0;
    if (!total_bytes) {
      alert("Measure pack size first.");
      if (btnP) btnP.disabled = false;
      return;
    }
    const body = {
      version,
      total_bytes,
      data_bytes: codexLastMeasure ? codexLastMeasure.data_bytes : null,
      image_bytes: codexLastMeasure ? codexLastMeasure.image_bytes : null,
      image_count: codexLastMeasure ? codexLastMeasure.image_count : null,
      missing: codexLastMeasure ? codexLastMeasure.missing : null,
      updated_at: new Date().toISOString(),
    };
    // Prefer signed-in client if start() created one
    let token = cfg.supabaseAnonKey;
    try {
      if (window.__codexSb) {
        const session = (await window.__codexSb.auth.getSession()).data.session;
        if (session) token = session.access_token;
      }
    } catch {}
    const up = await fetch(`${cfg.supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/site/config/app-version.json`, {
      method: "POST",
      headers: {
        apikey: cfg.supabaseAnonKey,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-upsert": "true",
      },
      body: JSON.stringify(body, null, 2),
    });
    if (!up.ok) throw new Error(await up.text());
    codexMeasureOut(`Published version ${version} · ${(total_bytes / 1048576).toFixed(1)} MB`);
    await codexRefreshPubVer();
  } catch (err) {
    console.error(err);
    alert("Publish failed: " + (err.message || err));
  }
  if (btnP) btnP.disabled = false;
}


async function codexLoadJSZip() {
  if (window.JSZip) return window.JSZip;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Could not load JSZip"));
    document.head.append(s);
  });
  return window.JSZip;
}

function codexDownloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** Owner-only: build full pack zip and save to this computer's Downloads. */
async function codexListStoragePrefix(prefix, limit = 1000) {
  const root = cfg.supabaseUrl.replace(/\/+$/, "");
  const out = [];
  let offset = 0;
  for (;;) {
    const listRes = await fetch(`${root}/storage/v1/object/list/site`, {
      method: "POST",
      headers: {
        apikey: cfg.supabaseAnonKey,
        Authorization: `Bearer ${cfg.supabaseAnonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prefix, limit: Math.min(limit, 1000), offset }),
    });
    if (!listRes.ok) break;
    const batch = await listRes.json();
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < Math.min(limit, 1000)) break;
    offset += batch.length;
    if (offset > 20000) break;
  }
  return out;
}

function codexCollectImageNamesFromValue(value, into) {
  if (value == null) return;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return;
    // Any path/url that ends with an image extension
    const m = s.match(/([^\s"'<>]+\.(?:png|jpe?g|gif|webp|svg|avif))(?:\?[^"'<>]*)?$/i);
    if (m) {
      const base = m[1].split(/[\\/]/).pop().split("?")[0];
      if (base) into.add(base);
      return;
    }
    // Bare filename sometimes stored without checking extension in odd fields
    if (/^[\w.\-()]+\.(?:png|jpe?g|gif|webp|svg)$/i.test(s)) into.add(s.split(/[\\/]/).pop());
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v) => codexCollectImageNamesFromValue(v, into));
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value)) codexCollectImageNamesFromValue(v, into);
  }
}

/** Owner-only: full capture of structure + all category JSON + every available content image. */
async function codexBuildDownloadPackZip() {
  // Full capture + publish to Supabase in ≤45MB parts so users get one-tap install (CORS works).
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    codexMeasureOut("Missing Supabase config");
    return;
  }
  const btn = document.getElementById("btn-build-pack-zip");
  if (btn) btn.disabled = true;
  const PART_MAX = 45 * 1024 * 1024;
  codexMeasureOut("Full capture for one-tap offline install…");
  try {
    const base = `${cfg.supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/site`;
    const root = cfg.supabaseUrl.replace(/\/+$/, "");

    let structure = { groups: [] };
    try {
      const sr = await fetch(`${base}/config/structure.json?t=${Date.now()}`, { cache: "no-store" });
      if (sr.ok) structure = await sr.json();
    } catch {}

    const dataFiles = new Map();
    try {
      const listed = await codexListStoragePrefix("data");
      for (const f of listed) {
        if (!f.name || !f.name.endsWith(".json")) continue;
        const raw = f.name.includes("/") ? f.name.split("/").pop() : f.name;
        const id = raw.replace(/\.json$/i, "");
        if (id) dataFiles.set(id, raw);
      }
    } catch (err) { console.warn(err); }
    for (const g of structure.groups || []) {
      for (const c of g.categories || []) {
        if (c && c.id) dataFiles.set(c.id, c.id + ".json");
      }
    }
    if (!dataFiles.size) throw new Error("No category JSON found");

    const categories = [];
    const imageNames = new Set();
    const ids = [...dataFiles.keys()];
    for (let fi = 0; fi < ids.length; fi++) {
      const id = ids[fi];
      const fname = dataFiles.get(id);
      codexMeasureOut(`Lists ${fi + 1}/${ids.length}: ${id}`);
      let items = [];
      try {
        const r = await fetch(`${base}/data/${encodeURIComponent(fname)}?t=${Date.now()}`, { cache: "no-store" });
        if (r.ok) {
          const json = await r.json();
          items = Array.isArray(json) ? json : (json && Array.isArray(json.items) ? json.items : []);
        }
      } catch {}
      codexCollectImageNamesFromValue(items, imageNames);
      let name = id, section = "";
      for (const g of structure.groups || []) {
        const hit = (g.categories || []).find((c) => c.id === id);
        if (hit) { name = hit.name || id; section = hit.section || ""; break; }
      }
      categories.push({ id, name, section, items });
    }

    codexMeasureOut("Listing images folder…");
    try {
      const imgs = await codexListStoragePrefix("images");
      for (const f of imgs) {
        if (!f.name) continue;
        const raw = f.name.includes("/") ? f.name.split("/").pop() : f.name;
        if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(raw)) imageNames.add(raw);
      }
    } catch (err) { console.warn(err); }

    const payload = {
      version: 1,
      built_at: new Date().toISOString(),
      slim: true,
      structure,
      categories,
    };
    const dataJson = JSON.stringify(payload);

    const JSZip = await codexLoadJSZip();
    const arr = [...imageNames];
    const imageBlobs = [];
    let ok = 0, miss = 0, i = 0;
    const concurrency = 16;
    async function worker() {
      while (i < arr.length) {
        const idx = i++;
        const name = arr[idx];
        try {
          const r = await fetch(`${base}/images/${encodeURIComponent(name)}`, { cache: "no-cache" });
          if (!r.ok) { miss++; continue; }
          const blob = await r.blob();
          if (!blob || !blob.size) { miss++; continue; }
          imageBlobs.push({ name, blob, size: blob.size });
          ok++;
        } catch { miss++; }
        if (idx % 25 === 0) codexMeasureOut(`Images ${idx + 1}/${arr.length} (saved ${ok}, not on server ${miss})…`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(arr.length, 1)) }, () => worker()));

    // Part 1: data only; more parts: images under PART_MAX
    const partBlobs = [];
    {
      const z = new JSZip();
      z.file("data.json", dataJson);
      codexMeasureOut("Compressing part 1 (data)…");
      partBlobs.push(await z.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } }));
    }
    let batch = [], est = 0;
    const batches = [];
    for (const img of imageBlobs) {
      const add = Math.ceil(img.size * 0.92) + 64;
      if (batch.length && est + add > PART_MAX) {
        batches.push(batch);
        batch = [];
        est = 0;
      }
      batch.push(img);
      est += add;
      if (est >= PART_MAX) {
        batches.push(batch);
        batch = [];
        est = 0;
      }
    }
    if (batch.length) batches.push(batch);
    for (let bi = 0; bi < batches.length; bi++) {
      const z = new JSZip();
      const folder = z.folder("images");
      for (const img of batches[bi]) folder.file(img.name, img.blob);
      codexMeasureOut(`Compressing part ${bi + 2}/${batches.length + 1}…`);
      partBlobs.push(await z.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } }));
    }

    const token = await codexOwnerToken();
    const partUrls = [];
    let totalBytes = 0;
    for (let pi = 0; pi < partBlobs.length; pi++) {
      const blob = partBlobs[pi];
      totalBytes += blob.size;
      const path = `pack/offline-part-${pi + 1}.zip`;
      codexMeasureOut(`Uploading ${path} (${(blob.size / 1048576).toFixed(1)} MB)…`);
      if (blob.size > 15 * 1024 * 1024 && typeof codexUploadPackZipResumable === "function") {
        // reuse tus by temporarily using offline-full path — upload each part via simple PUT if small enough
      }
      // Always use direct upload for parts under ~50MB (Supabase limit)
      const up = await fetch(`${root}/storage/v1/object/site/${path}`, {
        method: "POST",
        headers: {
          apikey: cfg.supabaseAnonKey,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/zip",
          "x-upsert": "true",
        },
        body: blob,
      });
      if (!up.ok) {
        const txt = await up.text();
        throw new Error(`Upload ${path} failed: ${txt}`);
      }
      partUrls.push(`${root}/storage/v1/object/public/site/${path}`);
    }

    const prev = (await codexLoadPublishedMeta()) || {};
    const version = prev.version || codexNextVersion(null);
    const body = {
      ...prev,
      version,
      total_bytes: totalBytes,
      pack_url: partUrls[0],
      pack_parts: partUrls,
      updated_at: new Date().toISOString(),
    };
    const up2 = await fetch(`${root}/storage/v1/object/site/config/app-version.json`, {
      method: "POST",
      headers: {
        apikey: cfg.supabaseAnonKey,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-upsert": "true",
      },
      body: JSON.stringify(body, null, 2),
    });
    if (!up2.ok) throw new Error(await up2.text());

    // Also offer local download of part 1 note
    codexLastMeasure = { total_bytes: totalBytes, image_count: ok, missing: miss, parts: partBlobs.length };
    await codexRefreshPubVer();
    const msg =
      `Published for one-tap install.\n\n` +
      `${partBlobs.length} parts · ${(totalBytes / 1048576).toFixed(1)} MB\n` +
      `${categories.length} categories · ${ok} images · ${miss} not on server\n` +
      `Version ${version}\n\n` +
      `Users can press Install offline version once. Also copy pack_parts into your repo app-version.json if you use GitHub Pages meta.`;
    codexMeasureOut(
      `Published ${partBlobs.length} parts · ${(totalBytes / 1048576).toFixed(1)} MB · v${version} · ${ok} images. One-tap install ready.`
    );
    alert(msg);
  } catch (err) {
    console.error(err);
    codexMeasureOut("Build/publish failed: " + (err.message || err));
    alert("Build/publish failed: " + (err.message || err));
  }
  if (btn) btn.disabled = false;
}






document.addEventListener("click", (e) => {
  const t = e.target.closest("#btn-measure-pack, #btn-publish-ver, #btn-upload-pack-zip, #btn-build-pack-zip");
  if (!t) return;
  e.preventDefault();
  if (t.id === "btn-measure-pack") codexMeasurePack();
  else if (t.id === "btn-publish-ver") codexPublishVersion();
  else if (t.id === "btn-build-pack-zip") codexBuildDownloadPackZip();
  else if (t.id === "btn-upload-pack-zip") {
    alert(
      "Do NOT upload the pack to Supabase (you will get 413 Maximum size exceeded).\n\n" +
      "Publish offline pack like this:\n" +
      "1. Build & download pack zip (saves the file on your PC)\n" +
      "2. GitHub repo → Releases → Draft a new release\n" +
      "3. Tag e.g. v1.0.0 → attach the zip → Publish\n" +
      "4. Copy the asset download URL\n" +
      "5. Commit app-version.json in the repo root with version + pack_url\n\n" +
      "Users install offline from that GitHub file, not from Supabase."
    );
  }
});

async function codexLoadTus() {
  if (window.tus) return window.tus;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tus-js-client@4.1.0/dist/tus.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Could not load tus upload library"));
    document.head.append(s);
  });
  return window.tus;
}

async function codexOwnerToken() {
  let token = cfg.supabaseAnonKey;
  try {
    if (window.__codexSb) {
      const session = (await window.__codexSb.auth.getSession()).data.session;
      if (session) token = session.access_token;
    }
  } catch {}
  return token;
}

async function codexAfterPackUploaded(fileSize) {
  const token = await codexOwnerToken();
  const base = cfg.supabaseUrl.replace(/\/+$/, "");
  const prev = (await codexLoadPublishedMeta()) || {};
  const body = {
    ...prev,
    version: prev.version || codexNextVersion(null),
    total_bytes: fileSize,
    pack_url: `${base}/storage/v1/object/public/site/pack/offline-full.zip`,
    updated_at: new Date().toISOString(),
  };
  const up2 = await fetch(`${base}/storage/v1/object/site/config/app-version.json`, {
    method: "POST",
    headers: {
      apikey: cfg.supabaseAnonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-upsert": "true",
    },
    body: JSON.stringify(body, null, 2),
  });
  if (!up2.ok) throw new Error(await up2.text());
  codexMeasureOut(
    `Pack zip uploaded (${(fileSize / 1048576).toFixed(1)} MB). Users can Download offline pack as one fast file. Version ${body.version}.`
  );
  await codexRefreshPubVer();
}

/** Large zips: resumable (chunked) upload — avoids Supabase 413 Payload too large. */
async function codexUploadPackZipResumable(file) {
  const tus = await codexLoadTus();
  const token = await codexOwnerToken();
  const endpoint = `${cfg.supabaseUrl.replace(/\/+$/, "")}/storage/v1/upload/resumable`;
  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      headers: {
        authorization: `Bearer ${token}`,
        apikey: cfg.supabaseAnonKey,
        "x-upsert": "true",
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: 6 * 1024 * 1024,
      metadata: {
        bucketName: "site",
        objectName: "pack/offline-full.zip",
        contentType: "application/zip",
        cacheControl: "3600",
      },
      onError: (err) => reject(err),
      onProgress: (sent, total) => {
        const pct = total ? Math.round((sent / total) * 100) : 0;
        codexMeasureOut(`Uploading pack zip… ${pct}% (${(sent / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB)`);
      },
      onSuccess: () => resolve(),
    });
    upload.findPreviousUploads().then((prev) => {
      if (prev.length) upload.resumeFromPreviousUpload(prev[0]);
      upload.start();
    }).catch(() => upload.start());
  });
}

document.addEventListener("change", async (e) => {
  if (e.target.id !== "pack-zip-file") return; // unused: packs go to GitHub Releases, not Supabase
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  codexMeasureOut("Uploading pack zip (" + file.name + ", " + (file.size / 1048576).toFixed(1) + " MB)…");
  try {
    // Always use resumable upload for packs over ~15 MB (simple POST hits 413)
    if (file.size > 15 * 1024 * 1024) {
      await codexUploadPackZipResumable(file);
    } else {
      const token = await codexOwnerToken();
      const path = "pack/offline-full.zip";
      const up = await fetch(`${cfg.supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/site/${path}`, {
        method: "POST",
        headers: {
          apikey: cfg.supabaseAnonKey,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/zip",
          "x-upsert": "true",
        },
        body: file,
      });
      if (!up.ok) {
        // fallback to resumable if server still rejects
        if (up.status === 413) await codexUploadPackZipResumable(file);
        else throw new Error(await up.text());
      }
    }
    await codexAfterPackUploaded(file.size);
  } catch (err) {
    console.error(err);
    const msg = String(err.message || err);
    codexMeasureOut("Zip upload failed: " + msg);
    alert(
      "Zip upload failed: " + msg +
      "\n\nAlso check Supabase → Project Settings → Storage → raise “Maximum file size” (e.g. 500 MB or 1 GB)."
    );
  }
});
document.addEventListener("DOMContentLoaded", () => { codexRefreshPubVer(); });
// If script loads after DOMContentLoaded already fired:
if (document.readyState !== "loading") setTimeout(() => codexRefreshPubVer(), 0);

const msg = (t) => ($("#msg").textContent = t);
const pretty = (id) => id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
// Name shown on the website for a dropped file: items_enhancercrysta_armor.json -> "Enhancer Crysta (Armor)"
const nameFromFile = (stem) => {
  const m = String(stem).match(/^(?:items[-_ ]?)?enhancer[-_ ]?crysta[-_ ]*\(?([a-z]+)\)?$/i);
  return m ? `Enhancer Crysta (${m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()})` : pretty(stem);
};
const slug = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// A group named "Skill Database" is split into sections; each category in it is filed under one of them.
const SKILL_SECTIONS = ["Assist", "Buff", "Other", "Weapon"];
const isSectioned = (g) => !!g && (Array.isArray(g.sections) || /^skill database$/i.test(g.name || ""));
const sectionsOf = (g) => (Array.isArray(g.sections) && g.sections.length ? g.sections : SKILL_SECTIONS);
const matchSection = (g, name) => sectionsOf(g).find((x) => x.toLowerCase() === String(name || "").trim().toLowerCase()) || "Other";

if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !cfg.ownerUsername) {
  msg("Fill in config.js first (see SETUP.md).");
} else {
  start();
}

function start() {
  const sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  window.__codexSb = sb;
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
  // In a sectioned group (Skill Database) it also gets a section; without one given, the old section is kept.
  function placeCategory(id, name, groupId, section) {
    if (!id) return null;
    if (!Array.isArray(structure.groups)) structure.groups = [];
    let prev = null;
    structure.groups.forEach((g) => {
      if (g && Array.isArray(g.categories)) {
        prev = prev || g.categories.find((c) => c.id === id) || null;
        g.categories = g.categories.filter((c) => c.id !== id);
      }
    });
    let grp = structure.groups.find((g) => g && g.id === groupId)
      || structure.groups.find((g) => g && g.id !== "unsorted")
      || structure.groups[0];
    if (!grp) {
      grp = { id: groupId || "unsorted", name: groupId ? pretty(groupId) : "Unsorted", categories: [] };
      structure.groups.push(grp);
    }
    if (!Array.isArray(grp.categories)) grp.categories = [];
    const entry = { id, name: name || prev?.name || pretty(id) };
    if (isSectioned(grp)) entry.section = matchSection(grp, section ?? prev?.section);
    grp.categories.push(entry);
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

  /** The Skill Database group (with its Assist / Buff / Other / Weapon sections). Created if missing. */
  function ensureSkillDb() {
    let g = structure.groups.find((x) => x.id === "skill-database" || /^skill database$/i.test(x.name || ""));
    if (!g) {
      g = { id: "skill-database", name: "Skill Database", sections: [...SKILL_SECTIONS], categories: [] };
      structure.groups.push(g);
    }
    if (!Array.isArray(g.sections)) g.sections = [...SKILL_SECTIONS];
    return g.id;
  }

  /**
   * Upload each SkillTree as its own category in Skill Database, filed under the section the scraper recorded
   * (Weapon / Buff / Assist / Other). Used for skilldatabase_all.json and for any JSON that is a list of skill trees.
   */
  async function uploadSkillTreesSplit(items, report) {
    const gid = ensureSkillDb();
    const db = structure.groups.find((x) => x.id === gid);
    let ok = 0;
    for (const tree of items) {
      const name = tree.name || tree.id || "Skill Tree";
      const id = slug(String(name));
      if (!id) { report.push(`Skipped tree with no name`); continue; }
      const section = matchSection(db, tree.group || tree.skill_group);
      const file2 = new File([JSON.stringify([tree])], `${id}.json`, { type: "application/json" });
      const n = await uploadJson(id, file2, gid, { skipPreview: true });
      if (n === false) { report.push(`${name}: failed`); continue; }
      placeCategory(id, name, gid, section);
      ok++;
      report.push(`Added/updated ${name} \u2192 ${db.name} \u203A ${section}`);
    }
    try { await saveStructure(); } catch {}
    return ok;
  }

  const setAddGroup = (id) => { const s = $("#newgroup"); if ([...s.options].some((o) => o.value === id)) s.value = id; syncSection(); };

  // The Section picker next to Group only shows when the chosen group is sectioned (Skill Database).
  function syncSection() {
    const g = structure.groups.find((x) => x.id === $("#newgroup").value);
    const on = isSectioned(g);
    $("#secwrap").hidden = !on;
    if (on) {
      const cur = $("#newsection").value;
      $("#newsection").innerHTML = sectionsOf(g).map((x) => `<option${x === cur ? " selected" : ""}>${esc(x)}</option>`).join("");
    }
  }

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
    const secOpts = (g, sel) => [...new Set([...sectionsOf(g), ...(sel ? [sel] : [])])].map((x) => `<option${x === sel ? " selected" : ""}>${esc(x)}</option>`).join("");
    const row = (g, c) => `
          <li data-cat="${esc(c.id)}"><span><strong>${esc(c.name)}</strong></span>
            <span><select data-move="${esc(c.id)}" aria-label="Move ${esc(c.name)} to group" title="Move to group">${opts(g.id)}</select>
            ${isSectioned(g) ? `<select data-sec-of="${esc(c.id)}" aria-label="Section for ${esc(c.name)}" title="Section (Assist / Buff / Other / Weapon)">${secOpts(g, c.section || "Other")}</select>` : ""}
            <button data-act="ren-cat" data-id="${esc(c.id)}">Rename</button>
            <button class="dropbtn" data-act="replace" data-drop="cat" data-id="${esc(c.id)}" title="Drop a JSON file here, or press to choose one" aria-label="Replace ${esc(c.name)} items: drop a JSON file here or press to choose one">JSON</button>
            <button class="dropbtn" data-act="images" data-drop="images" data-id="${esc(c.id)}" title="Drop image files or a folder here, or press to choose images" aria-label="Upload images for ${esc(c.name)}: drop image files here or press to choose them">Image</button>
            <button data-act="del-cat" data-id="${esc(c.id)}" class="danger">Delete</button></span></li>`;
    const rowsOf = (g) => {
      if (!g.categories.length) return `<li class="muted">No categories in this group yet.</li>`;
      if (!isSectioned(g)) return g.categories.map((c) => row(g, c)).join("");
      const names = [...new Set([...sectionsOf(g), ...g.categories.map((c) => c.section).filter(Boolean)])];
      let out = g.categories.filter((c) => !c.section).map((c) => row(g, c)).join("");
      for (const n of names) {
        const list = g.categories.filter((c) => (c.section || "").toLowerCase() === n.toLowerCase());
        if (list.length) out += `<li class="sec-label">${esc(n)} <small>${list.length}</small></li>${list.map((c) => row(g, c)).join("")}`;
      }
      return out;
    };
    $("#tree").innerHTML = structure.groups.length
      ? structure.groups.map((g) => `
        <div class="grp">
        <div class="grp-head">
          <button type="button" class="grp-toggle" data-act="toggle" data-g="${esc(g.id)}" aria-expanded="${open.has(g.id)}">
            <svg class="chev" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span>${esc(g.name)}</span><small>${g.categories.length}<span class="w"> ${g.categories.length === 1 ? "category" : "categories"}</span></small></button>
          <span><button data-act="ren-group" data-g="${esc(g.id)}">Rename</button> <button data-act="del-group" data-g="${esc(g.id)}" class="danger">Delete</button></span></div>
        <ul class="rows"${open.has(g.id) ? "" : " hidden"}>${rowsOf(g)}</ul></div>`).join("")
      : `<p class="muted">No groups yet. Add your first group below, for example Equipment.</p>`;
    $("#newgroup").innerHTML = opts($("#newgroup").value);
    syncSection();
    $("#migrate-skills").hidden = !oldSkillGroups().length;
  }

  // Older uploads put Weapon, Buff, Assist and Other at the top level. This finds them so they can be moved into Skill Database.
  const oldSkillGroups = () => structure.groups.filter((g) => !/^skill database$/i.test(g.name || "") && g.id !== "skill-database"
    && SKILL_SECTIONS.some((x) => x.toLowerCase() === (g.name || "").trim().toLowerCase()) && g.categories.length);

  const findCat = (id) => {
    for (const g of structure.groups) { const c = g.categories.find((x) => x.id === id); if (c) return { g, c }; }
  };

  // Which category of your site a scraped file belongs to: items_armor.json -> Armor, items_1handedsword.json ->
  // 1 Handed Sword, items_enhancercrysta_armor.json -> Enhancer Crysta (Armor). Compares the file name with the ids and names
  // of your categories (ignoring spaces, case and punctuation). A scraped item list never matches a Skill Database tree.
  const nk = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const stemOf = (fileName) => String(fileName).replace(/\.json$/i, "").replace(/^(items|monsters|maps|quests)_/i, "").replace(/^skilldatabase_/i, "");
  function matchExistingCat(fileName) {
    const stem = stemOf(fileName);
    const keys = new Set([nk(stem), nk(nameFromFile(stem))]);
    const isSkillDb = (g) => g.id === "skill-database" || /^skill database$/i.test(g.name || "");
    for (const g of structure.groups) {
      if (isSkillDb(g)) continue;
      const c = g.categories.find((x) => keys.has(nk(x.id)) || keys.has(nk(x.name)));
      if (c) return { g, c };
    }
    return null;
  }

  // Category ids are file names (data/<id>.json) shared by the whole site. Two categories with the same
  // name in different groups (Equipment > Dagger and Skill Database > Dagger) must not share one file,
  // so a name that is taken by ANOTHER group gets the group's name in front: equipment-dagger.
  function freeId(name, groupId) {
    const base = slug(name);
    if (!base) return "";
    const taken = (id) => files.includes(id) || !!findCat(id);
    const mine = (id) => findCat(id)?.g.id === groupId;
    if (!taken(base) || mine(base)) return base;
    const g = structure.groups.find((x) => x.id === groupId);
    const prefix = slug(g?.name || groupId || "");
    let id = prefix ? slug(`${prefix} ${name}`) : `${base}-2`;
    for (let n = 2; taken(id) && !mine(id); n++) id = slug(`${prefix} ${name} ${n}`);
    return id;
  }

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
    const sid = e.target.dataset.secOf;
    if (sid) {  // change which section (Assist / Buff / Other / Weapon) a category is filed under
      const { g, c } = findCat(sid);
      c.section = e.target.value;
      open.add(g.id);
      return saveStructure(`${c.name} moved to ${g.name} \u203A ${c.section}.`);
    }
    const id = e.target.dataset.move;
    if (!id) return;
    const { g, c } = findCat(id);
    const to = structure.groups.find((x) => x.id === e.target.value);
    g.categories = g.categories.filter((x) => x !== c);
    if (isSectioned(to)) c.section = matchSection(to, c.section); else delete c.section;
    to.categories.push(c);
    open.add(to.id);
    saveStructure(`${c.name} moved to ${to.name}${c.section ? ` \u203A ${c.section}` : ""}.`);
  };

  $("#newgroup").onchange = syncSection;
  $("#migrate-skills").onclick = async () => {
    const old = oldSkillGroups();
    const n = old.reduce((t, g) => t + g.categories.length, 0);
    if (!old.length || !confirm(`Move ${n} categories from the groups ${old.map((g) => g.name).join(", ")} into Skill Database, filed under sections with the same names?`)) return;
    const dbId = ensureSkillDb();
    const db = structure.groups.find((x) => x.id === dbId);
    for (const g of old) for (const c of g.categories) db.categories.push({ id: c.id, name: c.name, section: matchSection(db, g.name) });
    structure.groups = structure.groups.filter((g) => !old.includes(g));
    open.add(db.id);
    await saveStructure(`Moved ${n} categories into Skill Database.`);
    setAddGroup(db.id);
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
  async function stageJson(file) {
    if (!file) return;
    stagedJson = file;
    const box = $("#newname");
    let items = null;
    try { items = JSON.parse(await file.text()); } catch {}
    const tree = Array.isArray(items) && isSkillTreeList(items) ? items : null;
    if (!box.value.trim()) box.value = tree && tree.length === 1 && tree[0].name ? tree[0].name : nameFromFile(file.name.replace(/\.json$/i, "").replace(/^skilldatabase_/, ""));
    if (tree) {  // a skill tree goes to Skill Database under the section the scraper recorded; both can still be changed before pressing Add
      const gid = ensureSkillDb();
      render();
      setAddGroup(gid);
      $("#newsection").value = matchSection(structure.groups.find((x) => x.id === gid), tree[0].group || tree[0].skill_group);
    }
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
    const name = $("#newname").value.trim(), groupId = $("#newgroup").value, sectionId = $("#secwrap").hidden ? undefined : $("#newsection").value;
    if (!slug(name)) return msg("Type a category name first.");
    if (!structure.groups.length || !groupId) return msg("Add a group first, for example Equipment.");
    const id = freeId(name, groupId);
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
      const grp = placeCategory(id, name, groupId, sectionId);
      let extra = "";
      if (stagedImages.length) {
        const { done, failed } = await uploadImages(stagedImages);
        extra = ` Images: ${done} uploaded${failed ? `, ${failed} failed` : ""}.`;
      }
      stagedJson = null; stagedImages = [];
      $("#newname").value = "";
      showStaged();
      const added = grp.categories.find((c) => c.id === id);
      await saveStructure(`${name} added to ${grp.name}${added?.section ? ` \u203A ${added.section}` : ""}.${extra}`);
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
            if (!confirm(`Upload ${jsonFiles.length} JSON files now? Categories you already have (matched by name) will be replaced; new ones are added. (One confirmation — you will not be asked for each file.)`)) {
              msg("Bulk upload cancelled.");
              return;
            }
          }
          for (const file of jsonFiles) {
            let items = null;
            try { items = JSON.parse(await file.text()); } catch { report.push(`Skipped ${file.name}: invalid JSON`); continue; }
            if (!Array.isArray(items)) { report.push(`Skipped ${file.name}: not a JSON list`); continue; }
            // skilldatabase_all (or any list of skill trees) → one category per tree, filed in Skill Database by section
            if (isSkillTreeList(items)) {
              report.push(`Splitting ${file.name} into ${items.length} skill trees by group...`);
              await uploadSkillTreesSplit(items, report);
              continue;
            }
            const file2 = new File([JSON.stringify(items)], file.name, { type: "application/json" });
            const gName = groupFromItems(items);
            const match = matchExistingCat(file.name);           // a category you already have: replace its items, keep its place
            let id, name, targetGroup;
            if (match) {
              id = match.c.id; name = match.c.name; targetGroup = match.g.id;
            } else {
              name = nameFromFile(stemOf(file.name));
              targetGroup = gName ? ensureGroup(gName) : groupId;
              if (!targetGroup && !structure.groups.length) { report.push(`Skipped ${file.name}: add a group first`); continue; }
              id = freeId(name, targetGroup);               // never reuse a file name that belongs to another group
              if (!id) { report.push(`Skipped ${file.name}`); continue; }
            }
            const exists = !!match;
            const n = await uploadJson(id, file2, targetGroup, { skipPreview: jsonFiles.length > 1 });
            if (n === false) { report.push(`${file.name}: cancelled or failed`); continue; }
            if (!match) placeCategory(id, name, targetGroup || groupId);
            report.push(`${exists ? "Updated" : "Added"} ${name} (${n} items).`);
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
        let id, name, replacing = false, match = null;
        let parsed = null;
        try { parsed = JSON.parse(await file.text()); } catch {}
        const file2 = parsed ? new File([JSON.stringify(parsed)], file.name, { type: "application/json" }) : file;
        const skillList = Array.isArray(parsed) && isSkillTreeList(parsed);
        const gName = Array.isArray(parsed) && !skillList ? groupFromItems(parsed) : null;
        let targetGroup = gName ? ensureGroup(gName) : groupId;
        let targetSection = $("#secwrap").hidden ? undefined : $("#newsection").value;
        if (rowId) {                                   // dropped on a category's Drop file button: replace that category
          id = rowId;
          name = findCat(id)?.c.name || pretty(id);
          replacing = true;
        } else {
          name = (jsons.length === 1 && ($("#newname").value.trim())) || nameFromFile(file.name.replace(/\.json$/i, "").replace(/^skilldatabase_/, ""));
          const typed = jsons.length === 1 && $("#newname").value.trim();
          match = !typed && !skillList ? matchExistingCat(file.name) : null;   // e.g. items_armor.json -> your Armor
          if (match) { id = match.c.id; name = match.c.name; targetGroup = match.g.id; }
          else {
            if (skillList) targetGroup = ensureSkillDb();   // skill trees always belong in Skill Database
            id = freeId(name, targetGroup);                 // a name used by another group gets its own file
          }
          if (!id) { report.push(`Skipped ${file.name}: couldn't make a category name from it.`); continue; }
          if (files.includes(id)) {
            if (jsons.length === 1 && !confirm(`${name} already exists. Replace its items with ${file.name}?`)) { report.push(`Skipped ${file.name}.`); continue; }
            replacing = true;
          } else if (!structure.groups.length) {
            report.push(`Skipped ${file.name}: add a group first, for example Equipment.`);
            continue;
          }
        }
        if (skillList && !findCat(id)) {  // a new skill tree: section from the scrape
          targetSection = matchSection(structure.groups.find((x) => x.id === targetGroup), parsed[0].group || parsed[0].skill_group);
        }
        const n = await uploadJson(id, file2, targetGroup);
        if (n === false) { report.push(`${file.name}: ${$("#msg").textContent}`); continue; }
        if (!replacing || !findCat(id)) {
          placeCategory(id, name, targetGroup, targetSection);
          $("#newname").value = "";
          await saveStructure();
        } else if (gName && !match) {
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

  // (pack measure tools use document click delegation above)
unlockUi();
}
