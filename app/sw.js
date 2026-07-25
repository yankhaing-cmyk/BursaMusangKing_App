/* Cache the shell so the app opens instantly; always fetch data fresh. */
const CACHE = "bmk-shell-v2";
const SHELL = ["./", "./index.html", "./app.js", "./charts.js", "./config.js",
               "./manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never cache API responses — stale scan results are worse than no results.
  if (url.pathname.match(/\/(latest|history|weekly|status|run|publish)$/)) return;
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
