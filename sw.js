// Light PWA cache: small shell, few images, capped JSON. Network-first so the live site stays fast.
const VER = "v3";
const SHELL = `shell-${VER}`;
const DATA = `data-${VER}`;
const IMG = `img-${VER}`;
const LIB = `lib-${VER}`;
const KEEP = [SHELL, DATA, IMG, LIB];

// Keep the install package small (no large background photo in the mandatory shell).
const SHELL_FILES = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "ui.js",
  "config.js",
  "changelog.json",
  "manifest.webmanifest",
  "assets/logo.png",
  "assets/favicon.png",
  "assets/icon-192.png",
];

// Hard caps so storage stays modest on phones.
const MAX_IMAGES = 180;       // item icons only after you view them
const MAX_DATA_FILES = 40;    // category JSON files kept offline

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => Promise.allSettled(SHELL_FILES.map((f) => c.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const storable = (res) => res && res.ok && res.type !== "opaque";

async function trimCache(name, maxKeys) {
  if (!maxKeys) return;
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= maxKeys) return;
  // Delete oldest first (start of list).
  await Promise.all(keys.slice(0, keys.length - maxKeys).map((k) => cache.delete(k)));
}

async function networkFirst(req, name, maxKeys) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(req);
    if (storable(res)) {
      await cache.put(req, res.clone());
      await trimCache(name, maxKeys);
    }
    return res;
  } catch (err) {
    const hit =
      (await cache.match(req, { ignoreSearch: false })) ||
      (await cache.match(req, { ignoreSearch: true }));
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req, name, maxKeys) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (storable(res)) {
    await cache.put(req, res.clone());
    await trimCache(name, maxKeys);
  }
  return res;
}

async function staleWhileRevalidate(req, name, maxKeys) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  const fresh = fetch(req)
    .then(async (res) => {
      if (storable(res)) {
        await cache.put(req, res.clone());
        await trimCache(name, maxKeys);
      }
      return res;
    })
    .catch(() => hit);
  return hit || fresh;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const path = url.pathname;

  if (url.origin === location.origin) {
    // Never cache owner / account (privacy + always fresh).
    if (/\/(admin|account)\.(html|js)$/.test(path)) return;
    // Large decorative assets: network only (don't fill disk).
    if (/\/assets\/background\.(jpe?g|png|webp)$/i.test(path)) return;
    e.respondWith(networkFirst(req, SHELL, 30));
    return;
  }
  if (url.searchParams.has("t")) return;

  if (path.includes("/storage/v1/object/public/site/images/")) {
    e.respondWith(cacheFirst(req, IMG, MAX_IMAGES));
    return;
  }
  if (path.includes("/storage/v1/object/public/site/")) {
    // Cap how many JSON lists stay on disk.
    e.respondWith(networkFirst(req, DATA, MAX_DATA_FILES));
    return;
  }
  if (
    url.hostname === "cdn.jsdelivr.net" ||
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "fonts.gstatic.com"
  ) {
    e.respondWith(staleWhileRevalidate(req, LIB, 20));
  }
});
