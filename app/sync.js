/* sync.js — メタデータだけを GAS へ同期する。
 *
 * 守っている約束:
 *   保存は今までどおりローカルへ即確定する。通信は一切待たない。
 *   同期は背景で勝手に進み、失敗しても保存は無かったことにならない。
 *   圏外で撮っても、後で自動的に上がる。
 *
 * 送るのはメタ（メモ・日付・URL・タグ・フォルダ名・ハッシュ）だけ。画像は送らない。
 */
(function (g) {
  'use strict';

  var KEY = 'photomemo.sync';
  var 送信中 = false, 予約 = null;
  var 直近 = { at: null, error: null, pushed: 0, pulled: 0 };

  /* ---------- 設定（この端末のブラウザにだけ置く） ----------
     合言葉は秘密情報なので、コードにもリポジトリにも書かない。 */
  function 設定() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || '{}');
      return { url: v.url || '', token: v.token || '' };
    } catch (e) { return { url: '', token: '' }; }
  }

  function 設定を保存(url, token) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ url: String(url || '').trim(), token: String(token || '').trim() }));
      return true;
    } catch (e) { return false; }
  }

  function 使える() { var c = 設定(); return !!(c.url && c.token); }

  /* ---------- 通信 ----------
     Content-Type を text/plain にすると単純リクエストになり、
     GAS が応えられない OPTIONS(preflight) が飛ばない。ここが肝。 */
  function 呼ぶ(action, 追加) {
    var c = 設定();
    if (!c.url || !c.token) return Promise.reject(new Error('同期先が設定されていません'));
    var body = Object.assign({ token: c.token, action: action }, 追加 || {});
    return fetch(c.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow'
    }).then(function (r) {
      return r.text().then(function (t) {
        var o;
        try { o = JSON.parse(t); }
        catch (e) { throw new Error('応答が読めません（URL とデプロイ設定を確認）'); }
        if (!o.ok) throw new Error(o.error || '拒否されました');
        return o;
      });
    });
  }

  /* ---------- 行の形（GAS のシートの列と一致させる） ---------- */
  function 行にする(item, フォルダ名) {
    return {
      id: item.id,
      folder: フォルダ名 || '',
      tags: (item.tags || []).join(','),
      memo: item.memo || '',
      date: item.date || '',
      url: item.url || '',
      hash: item.hash || '',
      name: item.name || '',
      mime: item.mime || '',
      createdAt: item.createdAt || '',
      updatedAt: item.updatedAt || '',
      deletedAt: '',
      tasting: (item.tasting && Object.keys(item.tasting).length)
        ? JSON.stringify(item.tasting) : ''
    };
  }

  /** まだ送っていない、あるいは送った後に書き換えられたもの。 */
  function 未送信(item) {
    return !item.syncedAt || String(item.updatedAt || '') > String(item.syncedAt);
  }

  function 待ち件数(items, graves) {
    return items.filter(未送信).length + (graves || []).length;
  }

  /* ---------- 送る ---------- */
  function 送る(items, folders) {
    var 名前 = {};
    folders.forEach(function (f) { 名前[f.id] = f.name; });

    return DB.allGraves().then(function (graves) {
      var 対象 = items.filter(未送信);
      var rows = 対象.map(function (i) { return 行にする(i, 名前[i.folderId]); });
      graves.forEach(function (gr) {
        rows.push({ id: gr.id, folder: '', tags: '', memo: '', date: '', url: '',
                    hash: '', name: '', mime: '', createdAt: '', updatedAt: gr.deletedAt,
                    deletedAt: gr.deletedAt, tasting: '' });
      });
      if (!rows.length) return { pushed: 0 };

      return 呼ぶ('push', { rows: rows }).then(function (res) {
        var t = res.serverTime || new Date().toISOString();
        return Promise.all(
          対象.map(function (i) { i.syncedAt = t; return DB.putItem(i, null); })
            .concat(graves.map(function (gr) { return DB.delGrave(gr.id); }))
        ).then(function () { return { pushed: rows.length }; });
      });
    });
  }

  /* ---------- 受け取る ----------
     こちらに無い行は「画像待ち」として置く。
     あとで同じ画像を選び直すと、ハッシュ一致でメモが戻る（app.js 側で拾う）。 */
  function 受け取る(items, folders) {
    return 呼ぶ('pull').then(function (res) {
      var rows = res.rows || [];
      if (!rows.length) return { pulled: 0 };

      var 手元 = {};
      items.forEach(function (i) { 手元[i.id] = i; });
      var 名前引き = {};
      folders.forEach(function (f) { 名前引き[f.name] = f.id; });

      var 作業 = [], 新フォルダ = [], 増えた = 0;
      var now = new Date().toISOString();

      rows.forEach(function (r) {
        var 手元の = 手元[r.id];

        if (r.deletedAt) {                       // 向こうで消された
          if (手元の && String(手元の.updatedAt || '') <= String(r.deletedAt)) {
            作業.push(DB.delItem(r.id, false));
            増えた++;
          }
          return;
        }

        // フォルダは名前で引き当てる。無ければ作る。
        var fid = 名前引き[r.folder];
        if (!fid && r.folder) {
          fid = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          名前引き[r.folder] = fid;
          新フォルダ.push({ id: fid, name: r.folder, order: folders.length + 新フォルダ.length, createdAt: now });
        }
        if (!fid) fid = (folders[0] && folders[0].id);

        var tags = r.tags ? String(r.tags).split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
        var tasting = null;
        if (r.tasting) {
          try { tasting = JSON.parse(r.tasting); } catch (e) { tasting = null; }
        }

        if (手元の) {
          // 新しいほうを採る
          if (String(r.updatedAt || '') <= String(手元の.updatedAt || '')) return;
          手元の.folderId = fid; 手元の.tags = tags;
          手元の.memo = r.memo || ''; 手元の.date = r.date || 手元の.date;
          手元の.url = r.url || ''; 手元の.updatedAt = r.updatedAt || now;
          if (tasting) 手元の.tasting = tasting; else delete 手元の.tasting;
          手元の.syncedAt = res.serverTime || now;
          作業.push(DB.putItem(手元の, null));
          増えた++;
        } else {
          // 画像がこちらに無い。メモだけ先に受け取っておく。
          作業.push(DB.putItem({
            id: r.id, folderId: fid, tags: tags,
            memo: r.memo || '', date: r.date || '', url: r.url || '',
            createdAt: r.createdAt || now, updatedAt: r.updatedAt || now,
            syncedAt: res.serverTime || now,
            mime: r.mime || '', name: r.name || '', hash: r.hash || '',
            tasting: tasting || undefined,
            w: 0, h: 0, thumb: null, waiting: true
          }, null));
          増えた++;
        }
      });

      return Promise.all(新フォルダ.map(DB.putFolder))
        .then(function () { return Promise.all(作業); })
        .then(function () { return { pulled: 増えた }; });
    });
  }

  /* ---------- ひと回し ---------- */
  function 回す(items, folders) {
    if (!使える()) return Promise.resolve({ skipped: true });
    if (送信中) return Promise.resolve({ busy: true });
    送信中 = true;
    return 送る(items, folders)
      .then(function (a) {
        return 受け取る(items, folders).then(function (b) {
          直近 = { at: new Date().toISOString(), error: null, pushed: a.pushed, pulled: b.pulled };
          return 直近;
        });
      })
      .catch(function (e) {
        直近 = { at: 直近.at, error: (e && e.message) || String(e), pushed: 0, pulled: 0 };
        throw e;
      })
      .then(function (r) { 送信中 = false; return r; },
            function (e) { 送信中 = false; throw e; });
  }

  /** 保存・削除のたびに呼ばれる。まとめて1回にする。 */
  function あとで(実行) {
    if (!使える()) return;
    clearTimeout(予約);
    予約 = setTimeout(実行, 1500);
  }

  g.SYNC = {
    設定: 設定, 設定を保存: 設定を保存, 使える: 使える,
    呼ぶ: 呼ぶ, 回す: 回す, あとで: あとで,
    未送信: 未送信, 待ち件数: 待ち件数,
    直近: function () { return 直近; }
  };
})(window);
