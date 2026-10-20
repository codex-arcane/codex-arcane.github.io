// Makes repeat visits fast and lets the site open without a connection.
// Pages and scripts always try the network first, so a new upload or update shows up right away.
// Item pictures are kept after the first load.
const VER = "v1";
const SHELL = `shell-${VER}`, DATA = `data-${VER}`, IMG = `img-${VER}`, LIB = `lib-${VER}`;
const KEEP = [SHELL, DATA, IMG, LIB];
const SHELL_FILES = ["./", "index.html", "style.css", "app.js", "ui.js", "config.js", "manifest.webmanifest",
  "assets/logo.png", "assets/favicon.png", "assets/background.jpg", "assets/icon-192.png"];
const MAX_IMAGES = 900;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => Promise.allSettled(SHELL_FILES.map((f) => c.add(f)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const storable = (res) => res && (res.ok || res.type === "opaque");

async function networkFirst(req, name) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(req);
    if (storable(res)) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: false }) || await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}
async function cacheFirst(req, name, limit) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (storable(res)) {
    cache.put(req, res.clone());
    if (limit) cache.keys().then((keys) => { if (keys.length > limit) keys.slice(0, keys.length - limit).forEach((k) => cache.delete(k)); });
  }
  return res;
}
async function staleWhileRevalidate(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => { if (storable(res)) cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || fresh;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const path = url.pathname;
  if (url.origin === location.origin) {
    if (/\/(admin|account)\.(html|js)$/.test(path)) return;           // owner and sign-in pages are never cached
    e.respondWith(networkFirst(req, SHELL));
  } else if (path.includes("/storage/v1/object/public/site/images/")) {
    e.respondWith(cacheFirst(req, IMG, MAX_IMAGES));
  } else if (path.includes("/storage/v1/object/public/site/")) {
    e.respondWith(networkFirst(req, DATA));                              // item lists and menu layout: fresh first, saved copy when offline
  } else if (url.hostname === "cdn.jsdelivr.net" || url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(staleWhileRevalidate(req, LIB));
  }
});
