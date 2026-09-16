const CACHE = '2letters-v7';
const ASSETS = ['./','./index.html','./styles.css','./app.v2.js','./calendar.js','./manifest.webmanifest','./logo-2l.jpg'];
self.addEventListener('install', e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e=>{ e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e=>{
  const req=e.request;
  if(req.method!=='GET') return;
  if(req.mode==='navigate') e.respondWith(fetch(req).then(r=>{const copy=r.clone(); caches.open(CACHE).then(c=>c.put('./index.html',copy)); return r;}).catch(()=>caches.match('./index.html')));
  else e.respondWith(caches.match(req).then(r=>r||fetch(req)));
});
