/* db.js — IndexedDB。
   items にサムネだけ入れ、原寸は blobs に分ける。
   グリッドは items だけ読めばよく、原寸を引きずらない。 */
(function (g) {
  'use strict';

  var NAME = 'photomemo', VER = 2, _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (res, rej) {
      var r = indexedDB.open(NAME, VER);
      r.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains('items')) {
          var s = db.createObjectStore('items', { keyPath: 'id' });
          s.createIndex('folderId', 'folderId');
          s.createIndex('createdAt', 'createdAt');
          s.createIndex('hash', 'hash');
        }
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('tags')) db.createObjectStore('tags', { keyPath: 'name' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
        // 削除したことを同期先へ伝えるための墓標。同期が済んだら消す。
        if (!db.objectStoreNames.contains('graves')) db.createObjectStore('graves', { keyPath: 'id' });
      };
      r.onsuccess = function () { _db = r.result; res(_db); };
      r.onerror = function () { rej(r.error); };
    });
  }

  function tx(stores, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(stores, mode), out;
        t.oncomplete = function () { res(out); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error || new Error('abort')); };
        out = fn(t);
      });
    });
  }

  function req(r) {
    return new Promise(function (res, rej) {
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }

  function all(store, index, range) {
    return tx([store], 'readonly', function (t) {
      var s = t.objectStore(store), src = index ? s.index(index) : s, acc = [];
      var r = src.openCursor(range || null);
      r.onsuccess = function () { var c = r.result; if (c) { acc.push(c.value); c.continue(); } };
      return acc;
    });
  }

  /* 1件取り。tx の完了まで待ってから box の中身を返す。 */
  function one(store, key, pick) {
    return tx([store], 'readonly', function (t) {
      var box = {};
      req(t.objectStore(store).get(key)).then(function (v) { box.v = v; });
      return box;
    }).then(function (box) { return pick ? pick(box.v) : (box.v || null); });
  }

  var DB = {
    open: open,
    req: req,

    /* ---- items ---- */
    allItems: function () { return all('items'); },
    getItem: function (id) { return one('items', id); },
    getBlob: function (id) { return one('blobs', id, function (v) { return v ? v.blob : null; }); },

    putItem: function (item, blob) {
      return tx(['items', 'blobs'], 'readwrite', function (t) {
        t.objectStore('items').put(item);
        if (blob) t.objectStore('blobs').put({ id: item.id, blob: blob });
        return item;
      });
    },

    delItem: function (id, 墓標を立てる) {
      return tx(['items', 'blobs', 'graves'], 'readwrite', function (t) {
        t.objectStore('items').delete(id);
        t.objectStore('blobs').delete(id);
        if (墓標を立てる) t.objectStore('graves').put({ id: id, deletedAt: new Date().toISOString() });
      });
    },

    findByHash: function (hash) {
      return tx(['items'], 'readonly', function (t) {
        var acc = [], r = t.objectStore('items').index('hash').openCursor(IDBKeyRange.only(hash));
        r.onsuccess = function () { var c = r.result; if (c) { acc.push(c.value); c.continue(); } };
        return acc;
      });
    },

    /* ---- folders ---- */
    allFolders: function () {
      return all('folders').then(function (a) {
        return a.sort(function (x, y) { return (x.order - y.order) || x.createdAt.localeCompare(y.createdAt); });
      });
    },
    putFolder: function (f) { return tx(['folders'], 'readwrite', function (t) { t.objectStore('folders').put(f); return f; }); },
    delFolder: function (id) { return tx(['folders'], 'readwrite', function (t) { t.objectStore('folders').delete(id); }); },

    /* ---- tags ---- */
    allTags: function () { return all('tags'); },
    putTag: function (tg) { return tx(['tags'], 'readwrite', function (t) { t.objectStore('tags').put(tg); return tg; }); },
    delTag: function (name) { return tx(['tags'], 'readwrite', function (t) { t.objectStore('tags').delete(name); }); },

    /* 使うたびに count と lastUsed を上げる。モーダルの並び順の元になる。 */
    bumpTags: function (names) {
      if (!names || !names.length) return Promise.resolve();
      var now = new Date().toISOString();
      return tx(['tags'], 'readwrite', function (t) {
        var s = t.objectStore('tags');
        names.forEach(function (n) {
          var r = s.get(n);
          r.onsuccess = function () {
            var v = r.result || { name: n, count: 0, lastUsed: now };
            v.count = (v.count || 0) + 1; v.lastUsed = now;
            s.put(v);
          };
        });
      });
    },

    /* ---- graves（削除の墓標） ---- */
    allGraves: function () { return all('graves'); },
    putGrave: function (g2) { return tx(['graves'], 'readwrite', function (t) { t.objectStore('graves').put(g2); }); },
    delGrave: function (id) { return tx(['graves'], 'readwrite', function (t) { t.objectStore('graves').delete(id); }); },

    /* ---- meta ---- */
    getMeta: function (k) { return one('meta', k, function (v) { return v ? v.v : null; }); },
    setMeta: function (k, v) { return tx(['meta'], 'readwrite', function (t) { t.objectStore('meta').put({ k: k, v: v }); }); },

    /* ---- 全消し（試作なので用意しておく） ---- */
    wipe: function () {
      return tx(['items', 'blobs', 'folders', 'tags', 'meta', 'graves'], 'readwrite', function (t) {
        ['items', 'blobs', 'folders', 'tags', 'meta', 'graves'].forEach(function (s) { t.objectStore(s).clear(); });
      });
    },

    bulkPut: function (items, blobs, folders, tags) {
      return tx(['items', 'blobs', 'folders', 'tags'], 'readwrite', function (t) {
        (items || []).forEach(function (i) { t.objectStore('items').put(i); });
        (blobs || []).forEach(function (b) { t.objectStore('blobs').put(b); });
        (folders || []).forEach(function (f) { t.objectStore('folders').put(f); });
        (tags || []).forEach(function (g2) { t.objectStore('tags').put(g2); });
      });
    }
  };

  g.DB = DB;
})(window);
