/* sw.js — 外に出ずに開けるようにするだけ。画像は IndexedDB 側にある。 */
var CACHE = 'photomemo-v2';
var SHELL = ['./', 'index.html', 'style.css', 'lib.js', 'db.js', 'tasting.js', 'sync.js', 'app.js',
             'manifest.webmanifest', 'icon.svg']
  // 香りの写真。1枚10KB弱なので、まとめて先に持っておく（圏外でも選べる）
  .concat(["aroma/apple.webp", "aroma/bellpepper.webp", "aroma/blackcurrant.webp", "aroma/blackpepper.webp", "aroma/blossom.webp", "aroma/blueberry.webp", "aroma/bread.webp", "aroma/butter.webp", "aroma/caramel.webp", "aroma/cedar.webp", "aroma/chocolate.webp", "aroma/cinnamon.webp", "aroma/clove.webp", "aroma/coffee.webp", "aroma/fig.webp", "aroma/forestfloor.webp", "aroma/hay.webp", "aroma/honey.webp", "aroma/iron.webp", "aroma/leather.webp", "aroma/lemon.webp", "aroma/lychee.webp", "aroma/mint.webp", "aroma/mushroom.webp", "aroma/nuts.webp", "aroma/oak.webp", "aroma/peach.webp", "aroma/pear.webp", "aroma/pineapple.webp", "aroma/plum.webp", "aroma/raspberry.webp", "aroma/rose.webp", "aroma/smoke.webp", "aroma/strawberry.webp", "aroma/tea.webp", "aroma/vanilla.webp", "aroma/violet.webp", "aroma/wetstone.webp", "aroma/yogurt.webp"]);

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(function (r) {
      var copy = r.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return r;
    }).catch(function () {
      return caches.match(e.request).then(function (m) {
        return m || caches.match('index.html');
      });
    })
  );
});
