const CACHE = 'studio-lh-v3';
const ASSETS = ['./','./index.html','./styles.css','./app.js','./manifest.webmanifest'];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e=>{
  const req = e.request;
  if (req.mode === 'navigate'){
    e.respondWith(fetch(req).catch(()=>caches.match('./index.html')));
  } else {
    e.respondWith(caches.match(req).then(r=>r||fetch(req)));
  }
});
