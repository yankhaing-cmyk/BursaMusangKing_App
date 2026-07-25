/* Service worker — offline fallback for the installed app.
 *
 * Network-first for everything, cache purely as an offline fallback.
 *
 * The previous version was cache-first for shell files, which meant a deployed
 * change to app.js was invisible until the CACHE constant below happened to be
 * bumped — forget that once and the installed app is frozen on old code with
 * no obvious symptom. Serving from the network first costs a few hundred
 * milliseconds on open and removes that entire failure mode.
 *
 * Other rules kept from before:
 *   - respondWith() must never reject; a rejected navigation is ERR_FAILED,
 *     which in a standalone PWA is a blank unusable window.
 *   - cache.addAll() is atomic, so one not-yet-deployed file fails the whole
 *     install and leaves the previous worker in charge. Add individually.
 */
const CACHE = "bmk-shell-v5";
const SHELL = ["./", "./index.html", "./app.js", "./charts.js", "./config.js",
               "./manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .catch(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  // Leave the Worker API (different origin) completely alone.
  if (url.origin !== self.location.origin) return;

  // Scan data is never cached — stale results are worse than no results.
  if (/\/(latest|history|weekly|backtest|status)\.json$/.test(url.pathname)) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => {
        if (hit) return hit;
        if (req.mode === "navigate") {
          return caches.match("./index.html")
            .then((h) => h || caches.match("./"))
            .then((h) => h || new Response(
              "<h1>Offline</h1><p>Reconnect and reopen the app.</p>",
              { headers: { "Content-Type": "text/html" }, status: 200 }));
        }
        return Response.error();
      }))
  );
});
