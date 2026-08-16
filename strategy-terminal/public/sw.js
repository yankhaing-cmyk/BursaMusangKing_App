const C='bursa-strategy-terminal-v1';
const CORE=['/','/app.css','/app.js','/manifest.webmanifest','/icon.svg'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(C).then(c=>c.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==C).map(k=>caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET'||new URL(e.request.url).pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(r=>{
        const copy=r.clone();
        caches.open(C).then(c=>c.put(e.request,copy));
        return r;
      })
      .catch(()=>caches.match(e.request).then(r=>r||caches.match('/')))
  );
});
