/* app.js — 画面と流れ。
   背骨は1つだけ: 「保存」は常に1タップで、常に成功する。
   必須項目を作らない / 保存後に何も聞かない / あとから直せる。この3つを崩さない。 */
(function (g) {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var VISIBLE_TAGS = 12;
  var DEFAULT_FOLDERS = ['未分類', '場所', 'もの', '資料', 'あとで見る'];

  var S = {
    view: 'folders',      // folders | grid | search
    folderId: null,
    folders: [],
    tags: [],
    items: [],
    urls: [],             // 生きている ObjectURL。描き直すたびに回収する
    pendingUrl: null,     // 共有シート等で受け取った URL
    undo: null
  };

  var M = {               // モーダルの状態
    mode: 'new',          // new | edit
    drafts: [],           // [{id, blob, thumb, ...}]
    idx: 0,
    folderId: null,
    tags: [],
    tagsOpen: false
  };

  /* ================= 小物 ================= */
  function uid() {
    return (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  }
  function today() { return new Date().toISOString().slice(0, 10); }
  function ymd(ms) {
    var d = new Date(ms);
    return isNaN(d) ? today() :
      d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function url(blob) { var u = URL.createObjectURL(blob); S.urls.push(u); return u; }
  function freeUrls() { S.urls.forEach(URL.revokeObjectURL); S.urls = []; }

  /* 削除。向こうへ既に送ってあるものだけ墓標を立てる。
     一度も送っていないものは、向こうに無いので墓標が要らない。 */
  function 消す(id) {
    return DB.getItem(id).then(function (it) {
      return DB.delItem(id, !!(it && it.syncedAt));
    });
  }

  var toastTimer = null;
  function toast(msg, undoFn) {
    $('#toast-msg').textContent = msg;
    $('#toast-undo').hidden = !undoFn;
    S.undo = undoFn || null;
    $('#toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $('#toast').hidden = true; S.undo = null; }, 5000);
  }

  /* ================= 起動 ================= */
  function boot() {
    if (!sessionStorage.getItem('warn-dismissed')) $('#sandbox-warn').hidden = false;
    領域を確保する();

    DB.open()
      .then(seedFolders)
      .then(reload)
      .then(function () {
        takeSharedUrl();
        render();
        同期する(true);   // 起動時に一度。失敗しても黙って次の機会に。
      })
      .catch(function (e) {
        document.body.insertAdjacentHTML('afterbegin',
          '<p class="fatal">保存領域を開けませんでした: ' + esc(e && e.message) + '</p>');
      });

    wire();
    if (g.isSecureContext && navigator.serviceWorker) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  function seedFolders() {
    return DB.allFolders().then(function (fs) {
      if (fs.length) return fs;
      var now = new Date().toISOString();
      return Promise.all(DEFAULT_FOLDERS.map(function (n, i) {
        return DB.putFolder({ id: uid(), name: n, order: i, createdAt: now });
      }));
    });
  }

  function reload() {
    return Promise.all([DB.allFolders(), DB.allTags(), DB.allItems()]).then(function (r) {
      S.folders = r[0];
      S.tags = r[1];
      S.items = r[2].sort(function (a, b) {
        return (b.date || '').localeCompare(a.date || '') || b.createdAt.localeCompare(a.createdAt);
      });
    });
  }

  /* 共有シート / ?url= で飛んできた URL を拾う。画像は付いてこないので預かるだけ。 */
  function takeSharedUrl() {
    var p = new URLSearchParams(location.search);
    var u = p.get('url') || p.get('text') || '';
    var m = String(u).match(/https?:\/\/\S+/);
    if (m) {
      S.pendingUrl = m[0];
      history.replaceState(null, '', location.pathname);
    }
  }

  /* ================= 描画 ================= */
  function render() {
    freeUrls();
    $('#btn-back').hidden = (S.view === 'folders');
    $('#view-folders').hidden = (S.view !== 'folders');
    $('#view-grid').hidden = (S.view === 'folders');
    if (S.view === 'folders') renderFolders(); else renderGrid();
    renderPending();
    知らせを書く();
  }

  function renderPending() {
    var el = document.getElementById('pending');
    if (!S.pendingUrl) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'pending';
      $('#main').insertAdjacentElement('beforebegin', el);
    }
    el.innerHTML = '<span>URL を預かっています。次に保存する画像に入ります。<br><code>' +
      esc(S.pendingUrl) + '</code></span><button type="button" id="pending-x" aria-label="捨てる">×</button>';
    $('#pending-x').onclick = function () { S.pendingUrl = null; renderPending(); };
  }

  function countIn(fid) {
    return S.items.filter(function (i) { return i.folderId === fid; }).length;
  }

  function renderFolders() {
    $('#title').textContent = 'フォルダ';
    var v = $('#view-folders');
    v.innerHTML = '';
    S.folders.forEach(function (f) {
      var n = countIn(f.id);
      var cover = S.items.find(function (i) { return i.folderId === f.id && i.thumb; });
      var d = document.createElement('button');
      d.type = 'button';
      d.className = 'folder';
      d.innerHTML =
        '<div class="fcover">' + (cover ? '<img alt="" src="' + url(cover.thumb) + '">' : '<span class="fempty">—</span>') + '</div>' +
        '<div class="fname">' + esc(f.name) + '</div>' +
        '<div class="fcount">' + n + ' 枚</div>';
      d.onclick = function () { S.folderId = f.id; S.view = 'grid'; render(); };
      v.appendChild(d);
    });
  }

  function currentItems() {
    if (S.view === 'search') return filterItems($('#q').value);
    return S.items.filter(function (i) { return i.folderId === S.folderId; });
  }

  function renderGrid() {
    var list = currentItems();
    if (S.view === 'search') {
      $('#title').textContent = '検索 (' + list.length + ')';
    } else {
      var f = S.folders.find(function (x) { return x.id === S.folderId; });
      $('#title').textContent = (f ? f.name : 'フォルダ') + ' (' + list.length + ')';
    }
    var v = $('#view-grid');
    v.innerHTML = '';
    if (!list.length) {
      v.innerHTML = '<p class="empty">' +
        (S.view === 'search' ? '見つかりません' : 'まだ何もありません。<br>下の「写真から」か「カメラ」で足します。') + '</p>';
      return;
    }
    list.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tile';
      if (it.waiting) b.classList.add('waiting');
      var 画;
      if (it.thumb) 画 = '<img alt="" loading="lazy" src="' + url(it.thumb) + '">';
      else if (it.waiting) 画 = '<span class="noimg wait">画像待ち<br><small>' +
        esc((it.memo || '').slice(0, 24) || 'メモのみ') + '</small></span>';
      else 画 = '<span class="noimg">' + esc(it.name || '画像') +
        '<br><small>この環境で開けない形式</small></span>';

      b.innerHTML = 画 +
        '<span class="badges">' +
          (SYNC.未送信(it) ? '<span class="b b-sync" title="未同期">•</span>' : '') +
          (it.memo ? '<span class="b b-memo" title="メモあり">✎</span>' : '') +
          (it.url ? '<span class="b b-url" title="URLあり">🔗</span>' : '') +
          (中身あり(it.tasting) ? '<span class="b b-wine" title="シートあり">🍷</span>' : '') +
          (手のタグ(it.tags).length ? '<span class="b">' + 手のタグ(it.tags).length + '</span>' : '') +
        '</span>' +
        '<span class="tdate">' + esc(it.date || '') + '</span>';
      b.onclick = function () { openEdit(it); };
      v.appendChild(b);
    });
  }

  function filterItems(q) {
    q = (q || '').trim().toLowerCase();
    if (!q) return [];
    var terms = q.split(/\s+/);
    var fname = {};
    S.folders.forEach(function (f) { fname[f.id] = f.name.toLowerCase(); });
    return S.items.filter(function (i) {
      var hay = [i.memo || '', i.url || '', (i.tags || []).join(' '), fname[i.folderId] || '', i.date || '',
                 味の言葉(i)].join(' ').toLowerCase();
      return terms.every(function (t) { return hay.indexOf(t) >= 0; });
    });
  }

  /* ================= 取り込み ================= */
  function intake(files) {
    var arr = Array.prototype.slice.call(files || []).filter(function (f) { return f && f.size; });
    if (!arr.length) return;
    return Promise.all(arr.map(prepare)).then(function (drafts) {
      openNew(drafts.filter(Boolean));
    });
  }

  /* 1枚ぶんの下ごしらえ。ここで EXIF・サムネ・ハッシュまで済ませ、
     「保存」を叩いたあとに重い仕事を残さない。 */
  function prepare(file) {
    return file.arrayBuffer().then(function (buf) {
      var ex = LIB.readExif(buf);
      return Promise.all([LIB.makeThumb(file), LIB.hashBuf(buf)]).then(function (r) {
        var t = r[0];
        var date, src;
        if (ex.date) { date = ex.date; src = '撮影日(EXIF)'; }
        else if (file.lastModified) { date = ymd(file.lastModified); src = 'ファイルの日時'; }
        else { date = today(); src = '今日'; }
        // 同期で「画像待ち」として先に届いていたメモがあれば、ここで引き取る
        var 待ち = S.items.filter(function (i) {
          return i.waiting && i.hash && i.hash === r[1];
        })[0];

        return {
          id: 待ち ? 待ち.id : uid(), blob: file, thumb: t.thumb, w: t.w, h: t.h,
          mime: file.type || '', name: file.name || '', hash: r[1],
          date: 待ち && 待ち.date ? 待ち.date : date,
          dateSrc: 待ち ? 'メモから復元' : src,
          memo: 待ち ? (待ち.memo || '') : '',
          url: 待ち ? (待ち.url || '') : (S.pendingUrl || ''),
          tasting: 待ち ? (待ち.tasting || null) : null,
          dup: false, 復元: 待ち || null
        };
      });
    }).catch(function () { return null; });
  }

  /* ================= モーダル ================= */
  function openNew(drafts) {
    if (!drafts.length) return;
    M.mode = 'new'; M.drafts = drafts; M.idx = 0; M.tags = []; M.tagsOpen = false;
    if (S.pendingUrl) S.pendingUrl = null;

    // 既定のフォルダは「今いるフォルダ → 前回使ったフォルダ → 先頭」。必ず1つ選択済みで開く。
    var pick = function (last) {
      var ok = function (id) { return id && S.folders.some(function (f) { return f.id === id; }); };
      var 復元 = (drafts.length === 1 && drafts[0].復元) ? drafts[0].復元 : null;
      if (復元) {
        M.folderId = ok(復元.folderId) ? 復元.folderId : (S.folders[0] && S.folders[0].id);
        M.tags = 手のタグ(復元.tags);
      } else {
        M.folderId = ok(S.folderId) ? S.folderId : (ok(last) ? last : (S.folders[0] && S.folders[0].id));
      }
      // 重複の目印。保存は止めない。
      return Promise.all(drafts.map(function (d) {
        return DB.findByHash(d.hash).then(function (hit) {
          d.dup = hit.some(function (h) { return !h.waiting && h.id !== d.id; });
        });
      }));
    };

    DB.getMeta('lastFolder').then(pick).then(function () {
      paintModal();
      モーダルを開く();
    });
  }

  function openEdit(item) {
    DB.getBlob(item.id).then(function (b) {
      M.mode = 'edit'; M.idx = 0; M.tagsOpen = false;
      M.folderId = item.folderId;
      M.tags = 手のタグ(item.tags);
      M.drafts = [{
        id: item.id, blob: b, thumb: item.thumb, w: item.w, h: item.h,
        mime: item.mime, name: item.name, hash: item.hash,
        date: item.date, dateSrc: '', memo: item.memo || '', url: item.url || '',
        tasting: item.tasting || null,
        dup: false, createdAt: item.createdAt
      }];
      paintModal();
      モーダルを開く();
    });
  }

  function paintModal() {
    var d = M.drafts[M.idx], multi = M.drafts.length > 1;
    paintTasting();

    $('#m-count').textContent = M.mode === 'edit' ? '' :
      (multi ? (M.idx + 1) + ' / ' + M.drafts.length + ' 枚目' : '1 枚');
    $('#m-del').hidden = (M.mode !== 'edit');
    $('#m-scope-all').hidden = !multi;
    $('#m-scope-all2').hidden = !multi;
    Array.prototype.forEach.call(document.querySelectorAll('.lab .one'), function (e) { e.hidden = !multi; });

    // プレビュー
    var pv = $('#m-preview');
    pv.classList.remove('big');
    pv.innerHTML = '';
    var show = d.blob || d.thumb;
    if (show) {
      var im = document.createElement('img');
      im.alt = ''; im.src = url(show);
      pv.appendChild(im);
    } else {
      pv.innerHTML = '<span class="noimg">' + esc(d.name || '画像') + '</span>';
    }

    // 複数枚のときだけ、切り替え用の帯
    var st = $('#m-strip');
    st.hidden = !multi;
    st.innerHTML = '';
    if (multi) {
      M.drafts.forEach(function (x, i) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'sth' + (i === M.idx ? ' on' : '');
        b.innerHTML = x.thumb ? '<img alt="" src="' + url(x.thumb) + '">' : '<span>?</span>';
        b.onclick = function () { stash(); M.idx = i; paintModal(); };
        st.appendChild(b);
      });
    }

    $('#m-dup').hidden = !d.dup;
    if (d.dup) $('#m-dup').textContent = '同じ画像が既にあります（保存はできます）';

    paintFolders();
    paintTags();

    $('#m-memo').value = d.memo || '';
    $('#m-date').value = d.date || today();
    $('#m-date-src').textContent = d.dateSrc ? ('既定: ' + d.dateSrc) : '';
    $('#m-url').value = d.url || '';
  }

  function paintFolders() {
    var w = $('#m-folders');
    w.innerHTML = '';
    S.folders.forEach(function (f) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (f.id === M.folderId ? ' on' : '');
      b.textContent = f.name;
      b.onclick = function () { M.folderId = f.id; paintFolders(); };
      w.appendChild(b);
    });
  }

  /* タグの並び: よく使う順（回数、次に直近）。
     withDraft が真のときだけ、まだ保存されていない入力中のタグを頭に足す。
     整理画面がこれを引きずると、消したタグが残って見えるので既定は false。 */
  function tagOrder(withDraft) {
    var known = S.tags.slice().sort(function (a, b) {
      return (b.count || 0) - (a.count || 0) ||
             String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')) ||
             a.name.localeCompare(b.name);
    }).map(function (t) { return t.name; });
    if (!withDraft) return known;
    var sel = M.tags.filter(function (n) { return known.indexOf(n) < 0; });
    return sel.concat(known);
  }

  function paintTags() {
    var w = $('#m-tags');
    w.innerHTML = '';
    var all = tagOrder(true);
    var head = all.filter(function (n) { return M.tags.indexOf(n) >= 0; });
    var rest = all.filter(function (n) { return M.tags.indexOf(n) < 0; });
    var ordered = head.concat(rest);
    var shown = M.tagsOpen ? ordered : ordered.slice(0, Math.max(VISIBLE_TAGS, head.length));

    shown.forEach(function (n) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (M.tags.indexOf(n) >= 0 ? ' on' : '');
      b.textContent = n;
      b.onclick = function () {
        var i = M.tags.indexOf(n);
        if (i >= 0) M.tags.splice(i, 1); else M.tags.push(n);
        paintTags();
      };
      w.appendChild(b);
    });

    if (!M.tagsOpen && ordered.length > shown.length) {
      var more = document.createElement('button');
      more.type = 'button';
      more.className = 'chip more';
      more.textContent = 'すべて (' + ordered.length + ')';
      more.onclick = function () { M.tagsOpen = true; paintTags(); };
      w.appendChild(more);
    }
    if (!ordered.length) {
      w.innerHTML = '<span class="hint">まだタグがありません。下で足せます。</span>';
    }
  }

  /* 画面の入力を、今見ている1枚へ書き戻す */
  function stash() {
    var d = M.drafts[M.idx];
    if (!d) return;
    d.memo = $('#m-memo').value;
    d.date = $('#m-date').value || today();
    d.url = $('#m-url').value.trim();
  }

  function addNewTag() {
    var i = $('#m-newtag'), n = i.value.trim();
    if (!n) return;
    if (M.tags.indexOf(n) < 0) M.tags.push(n);
    if (!S.tags.some(function (t) { return t.name === n; })) {
      S.tags.push({ name: n, count: 0, lastUsed: new Date().toISOString() });
    }
    i.value = '';
    M.tagsOpen = true;
    paintTags();
  }

  /* ================= テイスティングシート =================
     面は横スクロールで並べているだけ。書いた内容はその場で下書きへ入れる。
     「保存」は共通の足元にあるので、どちらの面からでも1タップで終わる。 */
  var 詳しく開く = false;
  try { 詳しく開く = localStorage.getItem('photomemo.tasting.more') === '1'; } catch (e) {}

  function 今のシート() {
    var d = M.drafts[M.idx];
    if (!d) return {};
    if (!d.tasting) d.tasting = {};
    return d.tasting;
  }

  function シートに書く(鍵, 値) {
    var t = 今のシート();
    if (値 === null || 値 === undefined || 値 === '' || (Array.isArray(値) && !値.length)) delete t[鍵];
    else t[鍵] = 値;
  }

  function 項目を作る(項) {
    var wrap = document.createElement('div');
    wrap.className = 't-row';
    wrap.dataset.key = 項.鍵;

    var lab = document.createElement('label');
    lab.className = 'lab';
    lab.textContent = 項.鍵;
    var one = document.createElement('small');
    one.className = 'one'; one.textContent = 'この1枚に';
    lab.appendChild(one);
    wrap.appendChild(lab);

    if (項.型 === '選択' || 項.型 === '複数') {
      var chips = document.createElement('div');
      chips.className = 'chips';
      項.候補.forEach(function (n) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'chip'; b.dataset.val = n;
        var 写 = 項.写真 && TASTING.香りの写真 && TASTING.香りの写真[n];
        if (写) {
          // 写真のある語は絵で選ぶ。無い語は文字のまま混ざる（欠けて見えないように）
          b.className = 'chip photo';
          var im = document.createElement('img');
          im.src = 'aroma/' + 写 + '.webp'; im.alt = ''; im.loading = 'lazy'; im.width = 64; im.height = 64;
          var cap = document.createElement('span');
          cap.textContent = n;
          b.appendChild(im); b.appendChild(cap);
        } else {
          b.textContent = n;
        }
        b.onclick = function () {
          var t = 今のシート(), cur = t[項.鍵];
          if (項.型 === '選択') {
            シートに書く(項.鍵, cur === n ? null : n);
          } else {
            var arr = Array.isArray(cur) ? cur.slice() : [];
            var i = arr.indexOf(n);
            if (i >= 0) arr.splice(i, 1); else arr.push(n);
            シートに書く(項.鍵, arr);
          }
          paintTasting();
        };
        chips.appendChild(b);
      });
      if (項.候補.length > 14) {
        wrap.dataset.limit = '12';
        var more = document.createElement('button');
        more.type = 'button'; more.className = 'chip more t-more';
        more.textContent = 'すべて';
        more.onclick = function () {
          wrap.dataset.open = wrap.dataset.open === '1' ? '' : '1';
          paintTasting();
        };
        chips.appendChild(more);
      }
      wrap.appendChild(chips);

    } else if (項.型 === '星') {
      var box = document.createElement('div');
      box.className = 't-stars';
      for (var i = 1; i <= 5; i++) (function (n) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 't-star'; b.textContent = '★';
        b.dataset.val = String(n);
        b.setAttribute('aria-label', n + ' / 5');
        b.onclick = function () {
          シートに書く(項.鍵, 今のシート()[項.鍵] === n ? null : n);
          paintTasting();
        };
        box.appendChild(b);
      })(i);
      wrap.appendChild(box);

    } else {
      var el = document.createElement(項.型 === '長文' ? 'textarea' : 'input');
      if (項.型 === '長文') el.rows = 2;
      else { el.type = 'text'; if (項.数字) el.inputMode = 'numeric'; }
      el.placeholder = 項.例 || '';
      el.autocomplete = 'off';
      el.oninput = function () { シートに書く(項.鍵, el.value.trim()); };
      wrap.appendChild(el);
    }
    return wrap;
  }

  function 面を組む(箱, 並び) {
    箱.innerHTML = '';
    var 組 = null, 入れ物 = null;
    並び.forEach(function (項) {
      if (項.組 !== 組) {
        組 = 項.組;
        入れ物 = document.createElement('section');
        入れ物.className = 't-group';
        var h = document.createElement('h3');
        h.textContent = 組;
        入れ物.appendChild(h);
        箱.appendChild(入れ物);
      }
      入れ物.appendChild(項目を作る(項));
    });
  }

  function buildTasting() {
    面を組む($('#m-tasting'), TASTING.簡易);
    面を組む($('#m-tasting-more-box'), TASTING.詳しく);
    $('#m-tasting-more-box').hidden = !詳しく開く;
    $('#m-tasting-more').classList.toggle('on', 詳しく開く);
    $('#m-tasting-more').setAttribute('aria-expanded', String(詳しく開く));
  }

  /** 下書きの中身を画面へ映す。押すたびにここを通るので、状態は1か所に集まる。 */
  function paintTasting() {
    var t = 今のシート(), multi = M.drafts.length > 1;
    Array.prototype.forEach.call(document.querySelectorAll('#m-pane-1 .t-row'), function (row) {
      var 鍵 = row.dataset.key, v = t[鍵];
      var 上限 = Number(row.dataset.limit || 0), 開く = row.dataset.open === '1', 出した = 0;
      Array.prototype.forEach.call(row.querySelectorAll('.chip'), function (b) {
        if (b.classList.contains('t-more')) {
          b.textContent = 開く ? '閉じる' : 'すべて';
          return;
        }
        var on = Array.isArray(v) ? v.indexOf(b.dataset.val) >= 0 : v === b.dataset.val;
        b.classList.toggle('on', on);
        if (上限) { b.hidden = !(開く || on || 出した < 上限); if (!b.hidden) 出した++; }
      });
      Array.prototype.forEach.call(row.querySelectorAll('.t-star'), function (b) {
        b.classList.toggle('on', Number(v || 0) >= Number(b.dataset.val));
      });
      var el = row.querySelector('input, textarea');
      if (el && el.value !== (v || '')) el.value = v || '';
      var one = row.querySelector('.lab .one');
      if (one) one.hidden = !multi;
    });
  }

  /** 開くときは必ずメモの面から。前に見ていた面を引きずらない。 */
  function モーダルを開く() {
    var tr = $('#m-track');
    tr.scrollLeft = 0;
    面の印(0);
    $('#modal').showModal();
    tr.scrollLeft = 0;
  }

  /** 面の移動。タブでもスワイプでも、行き先は同じ。 */
  function 面へ(n) {
    var tr = $('#m-track');
    tr.scrollTo({ left: tr.clientWidth * n, behavior: 'smooth' });
    面の印(n);
  }

  function 面の印(n) {
    Array.prototype.forEach.call(document.querySelectorAll('.m-tab'), function (b, i) {
      b.classList.toggle('on', i === n);
      b.setAttribute('aria-pressed', String(i === n));
    });
  }

  /* シートに書いた言葉を平らにする。項目が増えても手を入れなくて済むよう、
     鍵ではなく値だけを拾う。 */
  function 味の言葉(item) {
    var t = item && item.tasting;
    if (!t) return '';
    var out = [];
    Object.keys(t).forEach(function (k) {
      var v = t[k];
      if (Array.isArray(v)) out.push(v.join(' '));
      else if (v || v === 0) out.push(String(v));
    });
    return out.join(' ');
  }

  function 中身あり(t) { return !!(t && Object.keys(t).length); }

  /* ---- シートの値をタグへ写す ----
     形は「鍵:値」（例 酸味:やや高い）。値だけだと、やや高いが酸味か渋みか分からなくなる。
     これは計算で作るタグなので、手で編むタグ（M.tags）とは分けて扱う。
     ・タグ欄・タグ整理には出さない（手で直すとシートの値と食い違うため）
     ・スプレッドシートの tags 列と メタ.json には、そのまま並んで載る */
  function シートの鍵() {
    var out = {};
    [].concat(TASTING.簡易, TASTING.詳しく).forEach(function (項) {
      if (項.タグ !== false) out[項.鍵] = true;
    });
    return out;
  }

  function シート由来のタグ(t) {
    if (!中身あり(t)) return [];
    var 対象 = シートの鍵(), out = [];
    Object.keys(t).forEach(function (k) {
      if (!対象[k]) return;
      var v = t[k];
      (Array.isArray(v) ? v : [v]).forEach(function (x) {
        x = String(x == null ? '' : x).trim();
        if (x) out.push(k + ':' + x);
      });
    });
    return out;
  }

  /** 計算で作ったタグかどうか。鍵が今の項目にあるものだけをそう見なす。 */
  function 由来タグか(名) {
    var i = String(名).indexOf(':');
    return i > 0 && !!シートの鍵()[名.slice(0, i)];
  }

  function 手のタグ(list) {
    return (list || []).filter(function (n) { return !由来タグか(n); });
  }

  /* ---- 保存。ここで聞き返さない。失敗しうる分岐を作らない。 ---- */
  function save() {
    stash();
    var now = new Date().toISOString();
    var fid = M.folderId || (S.folders[0] && S.folders[0].id);
    var tags = M.tags.slice();

    var writes = M.drafts.map(function (d) {
      // 手で付けたタグは全部に、シート由来は書いた1枚だけに付く
      var 全タグ = tags.concat(シート由来のタグ(d.tasting)).filter(function (n, i, a) {
        return a.indexOf(n) === i;
      });
      var item = {
        id: d.id, folderId: fid, tags: 全タグ,
        memo: d.memo || '', date: d.date || today(), url: d.url || '',
        createdAt: d.createdAt || now, updatedAt: now,
        mime: d.mime, name: d.name, hash: d.hash, w: d.w, h: d.h, thumb: d.thumb
      };
      if (中身あり(d.tasting)) item.tasting = d.tasting;
      return DB.putItem(item, d.blob);
    });

    var ids = M.drafts.map(function (d) { return d.id; });
    var isNew = (M.mode === 'new');

    Promise.all(writes)
      .then(function () { return DB.bumpTags(tags); })   // 計算タグは数えない
      .then(function () { return DB.setMeta('lastFolder', fid); })
      .then(reload)
      .then(function () {
        $('#modal').close();
        // 新規なら必ず保存先を開く。ここで画面が動かないと「保存された」が伝わらない。
        if (isNew) {
          S.folderId = fid; S.view = 'grid';
          $('#searchbar').hidden = true; $('#q').value = '';
        }
        render();
        同期を予約();
        if (isNew) {
          toast(ids.length + ' 枚 保存', function () {
            Promise.all(ids.map(消す)).then(reload).then(render);
          });
        } else {
          toast('更新', null);
        }
      })
      .catch(function (e) {
        toast('保存できませんでした: ' + (e && e.message), null);
      });
  }

  function removeCurrent() {
    var d = M.drafts[0];
    DB.getItem(d.id).then(function (old) {
      return DB.getBlob(d.id).then(function (blob) {
        return 消す(d.id).then(reload).then(function () {
          $('#modal').close();
          render();
          同期を予約();
          toast('削除', function () {
            // 取り消したら墓標も取り下げる
            DB.delGrave(old.id).then(function () { return DB.putItem(old, blob); })
              .then(reload).then(render);
          });
        });
      });
    });
  }

  /* ================= フォルダ整理 ================= */
  function openFolderMan() {
    var w = $('#folderman-list');
    w.innerHTML = '';
    S.folders.forEach(function (f, i) {
      var row = document.createElement('div');
      row.className = 'mrow';
      row.innerHTML =
        '<input type="text" value="' + esc(f.name) + '">' +
        '<span class="n">' + countIn(f.id) + '</span>' +
        '<button type="button" class="up" aria-label="上へ"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" class="rm danger" aria-label="削除">×</button>';
      row.querySelector('input').onchange = function (e) {
        var 新 = e.target.value.trim();
        if (!新 || 新 === f.name) { openFolderMan(); return; }
        f.name = 新;
        // 行の folder 列はフォルダ名。中の画像を触らないと向こうへ伝わらない。
        var now = new Date().toISOString();
        var 中身 = S.items.filter(function (it) { return it.folderId === f.id; })
          .map(function (it) { it.updatedAt = now; return DB.putItem(it, null); });
        DB.putFolder(f).then(function () { return Promise.all(中身); })
          .then(reload).then(function () { openFolderMan(); render(); 同期を予約(); });
      };
      row.querySelector('.up').onclick = function () {
        var prev = S.folders[i - 1];
        var a = f.order, b = prev.order;
        f.order = b; prev.order = a;
        Promise.all([DB.putFolder(f), DB.putFolder(prev)]).then(reload)
          .then(function () { openFolderMan(); render(); });
      };
      row.querySelector('.rm').onclick = function () {
        var n = countIn(f.id);
        if (S.folders.length < 2) { toast('最後の1つは消せません', null); return; }
        if (n && !confirm(f.name + ' の中の ' + n + ' 枚を「' + S.folders.filter(function (x) { return x.id !== f.id; })[0].name + '」へ移して消します。よろしいですか')) return;
        var to = S.folders.filter(function (x) { return x.id !== f.id; })[0];
        var moves = S.items.filter(function (it) { return it.folderId === f.id; })
          .map(function (it) { it.folderId = to.id; return DB.putItem(it, null); });
        Promise.all(moves).then(function () { return DB.delFolder(f.id); })
          .then(reload).then(function () { openFolderMan(); render(); });
      };
      w.appendChild(row);
    });
    $('#folderman').showModal();
  }

  /* ================= タグ整理（改名・統合・削除） ================= */
  function openTagMan() {
    var w = $('#tagman-list');
    w.innerHTML = '';
    var used = {};
    // 計算で作ったタグは数えない（手で直せるものだけを一覧に出す）
    S.items.forEach(function (i) { 手のタグ(i.tags).forEach(function (t) { used[t] = (used[t] || 0) + 1; }); });
    var list = tagOrder(false).filter(function (n) { return !由来タグか(n); });
    Object.keys(used).forEach(function (n) { if (list.indexOf(n) < 0) list.push(n); });
    if (!list.length) w.innerHTML = '<p class="hint">まだタグがありません。</p>';
    list.forEach(function (n) {
      var row = document.createElement('div');
      row.className = 'mrow';
      row.innerHTML = '<input type="text" value="' + esc(n) + '"><span class="n">' + (used[n] || 0) + '</span>' +
        '<button type="button" class="rm danger" aria-label="削除">×</button>';
      row.querySelector('input').onchange = function (e) {
        var to = e.target.value.trim();
        if (!to || to === n) { openTagMan(); return; }
        renameTag(n, to);
      };
      row.querySelector('.rm').onclick = function () {
        if (!confirm('タグ「' + n + '」を ' + (used[n] || 0) + ' 枚から外します。画像は消えません。')) return;
        renameTag(n, null);
      };
      w.appendChild(row);
    });
    $('#tagman').showModal();
  }

  /* to が null なら削除、既存の名前なら統合、新しい名前なら改名。
     タグは名前そのものを items に持たせているので、ここで全部書き換える。 */
  function renameTag(from, to) {
    var touched = S.items.filter(function (i) { return (i.tags || []).indexOf(from) >= 0; });
    var writes = touched.map(function (i) {
      var t = i.tags.filter(function (x) { return x !== from; });
      if (to && t.indexOf(to) < 0) t.push(to);
      i.tags = t; i.updatedAt = new Date().toISOString();
      return DB.putItem(i, null);
    });
    var old = S.tags.find(function (t) { return t.name === from; });
    Promise.all(writes)
      .then(function () { return DB.delTag(from); })
      .then(function () {
        if (!to) return;
        var ex = S.tags.find(function (t) { return t.name === to; });
        return DB.putTag({
          name: to,
          count: (ex ? ex.count || 0 : 0) + (old ? old.count || 0 : 0),
          lastUsed: new Date().toISOString()
        });
      })
      .then(reload).then(function () { openTagMan(); render(); });
  }

  /* ================= 書き出し / 読み込み ================= */
  function exportZip() {
    toast('書き出しています…', null);
    var enc = new TextEncoder();
    var metaItems = [];
    var jobs = S.items.map(function (i) {
      return DB.getBlob(i.id).then(function (b) {
        var ext = (i.name && i.name.indexOf('.') > 0) ? i.name.slice(i.name.lastIndexOf('.') + 1)
                : (i.mime || '').split('/')[1] || 'bin';
        var fn = 'images/' + i.id + '.' + ext.toLowerCase().replace(/[^a-z0-9]/g, '');
        var meta1 = {
          id: i.id, file: fn, folder: (S.folders.find(function (f) { return f.id === i.folderId; }) || {}).name || '未分類',
          tags: i.tags || [], memo: i.memo || '', date: i.date || '', url: i.url || '',
          createdAt: i.createdAt, updatedAt: i.updatedAt, mime: i.mime, name: i.name, hash: i.hash
        };
        if (中身あり(i.tasting)) meta1.tasting = i.tasting;
        metaItems.push(meta1);
        return b ? b.arrayBuffer().then(function (ab) { return { name: fn, data: new Uint8Array(ab) }; }) : null;
      });
    });

    Promise.all(jobs).then(function (files) {
      var entries = files.filter(Boolean);
      entries.unshift({
        name: 'メタ.json',
        data: enc.encode(JSON.stringify({
          形式: 'photomemo/1',
          書き出し: new Date().toISOString(),
          フォルダ: S.folders.map(function (f) { return { name: f.name, order: f.order }; }),
          タグ: S.tags.map(function (t) { return { name: t.name, count: t.count || 0 }; }),
          項目: metaItems
        }, null, 2))
      });
      var blob = LIB.zipWrite(entries);
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'photomemo_' + today() + '.zip';
      a.click();
      DB.setMeta('lastExport', new Date().toISOString())
        .then(function () { 知らせを書く(); }).catch(function () {});
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      toast(entries.length - 1 + ' 枚 書き出し', null);
    }).catch(function (e) { toast('書き出せませんでした: ' + (e && e.message), null); });
  }

  function importZip(file) {
    toast('読み込んでいます…', null);
    file.arrayBuffer().then(function (buf) {
      var entries = LIB.zipRead(buf), byName = {};
      entries.forEach(function (e) { byName[e.name] = e.data; });
      var metaRaw = byName['メタ.json'];
      if (!metaRaw) throw new Error('メタ.json がありません');
      var meta = JSON.parse(new TextDecoder().decode(metaRaw));

      // フォルダは名前で引き当て、無ければ作る
      var fmap = {}, now = new Date().toISOString(), newFolders = [];
      S.folders.forEach(function (f) { fmap[f.name] = f.id; });
      (meta.フォルダ || []).forEach(function (f, i) {
        if (!fmap[f.name]) {
          var id = uid();
          fmap[f.name] = id;
          newFolders.push({ id: id, name: f.name, order: (S.folders.length + i), createdAt: now });
        }
      });

      var items = [], blobs = [], tagset = {};
      var work = (meta.項目 || []).map(function (m) {
        var data = byName[m.file];
        if (!data) {
          // 画像の無い項目＝「画像待ち」。メモだけが残っている、一番取り返しのつかない記録なので
          // 飛ばさずに戻す。あとで同じ写真を選び直せば、ハッシュ一致で結び付く（§8）
          手のタグ(m.tags).forEach(function (t) { tagset[t] = (tagset[t] || 0) + 1; });
          items.push({
            id: m.id || uid(), folderId: fmap[m.folder] || (S.folders[0] && S.folders[0].id),
            tags: m.tags || [], memo: m.memo || '', date: m.date || today(), url: m.url || '',
            createdAt: m.createdAt || now, updatedAt: now,
            mime: m.mime || '', name: m.name || '', hash: m.hash || '',
            tasting: 中身あり(m.tasting) ? m.tasting : undefined,
            w: 0, h: 0, thumb: null, waiting: true
          });
          return Promise.resolve();
        }
        var blob = new Blob([data], { type: m.mime || 'application/octet-stream' });
        手のタグ(m.tags).forEach(function (t) { tagset[t] = (tagset[t] || 0) + 1; });
        // サムネは zip に入れていないので、ここで作り直す
        return LIB.makeThumb(blob).then(function (t) {
          var id = m.id || uid();
          items.push({
            id: id, folderId: fmap[m.folder] || (S.folders[0] && S.folders[0].id),
            tags: m.tags || [], memo: m.memo || '', date: m.date || today(), url: m.url || '',
            createdAt: m.createdAt || now, updatedAt: now,
            mime: m.mime || blob.type, name: m.name || '', hash: m.hash || '',
            tasting: 中身あり(m.tasting) ? m.tasting : undefined,
            w: t.w, h: t.h, thumb: t.thumb
          });
          blobs.push({ id: id, blob: blob });
        });
      });

      return Promise.all(work).then(function () {
        var tags = Object.keys(tagset).map(function (n) {
          var ex = S.tags.find(function (t) { return t.name === n; });
          return { name: n, count: (ex ? ex.count || 0 : 0) + tagset[n], lastUsed: now };
        });
        return DB.bulkPut(items, blobs, newFolders, tags);
      }).then(reload).then(function () {
        render();
        同期を予約();
        toast(items.length + ' 枚 読み込み', null);
      });
    }).catch(function (e) { toast('読み込めませんでした: ' + (e && e.message), null); });
  }

  /* ================= ダミー（実データを入れないための代わり） ================= */
  function makeDummies() {
    var words = ['海', '看板', 'レシピ', '棚', '手元'];
    var jobs = words.map(function (w, i) {
      var c = document.createElement('canvas');
      c.width = 900; c.height = 1200;
      var x = c.getContext('2d');
      x.fillStyle = 'hsl(' + (i * 67 + 20) + ' 45% 42%)';
      x.fillRect(0, 0, 900, 1200);
      x.fillStyle = 'rgba(255,255,255,.92)';
      x.font = 'bold 110px sans-serif';
      x.textAlign = 'center';
      x.fillText('ダミー', 450, 560);
      x.font = 'bold 150px sans-serif';
      x.fillText(w, 450, 730);
      x.font = '44px sans-serif';
      x.fillText('実データではありません', 450, 830);
      return new Promise(function (res) {
        c.toBlob(function (b) {
          var f = new File([b], 'ダミー_' + w + '.jpg', { type: 'image/jpeg', lastModified: Date.now() - i * 86400000 * 9 });
          res(f);
        }, 'image/jpeg', 0.9);
      });
    });
    Promise.all(jobs).then(intake);
  }

  /* ================= 保管と、気づかせ方 =================
     どちらも保存の道筋には割り込まない。出るのは画面の上に1本だけ。 */

  /** ブラウザに「この端末のデータを勝手に捨てないでほしい」と頼む。
      断られても動きは変わらない（iOS は無視することがある）。 */
  function 領域を確保する() {
    try {
      if (!navigator.storage || !navigator.storage.persist) return;
      navigator.storage.persisted().then(function (ok) {
        if (!ok) navigator.storage.persist().catch(function () {});
      }).catch(function () {});
    } catch (e) {}
  }

  function 日数(iso) {
    if (!iso) return null;
    var d = (Date.now() - new Date(iso).getTime()) / 86400000;
    return d < 0 ? 0 : Math.floor(d);
  }

  function 書き出しの状態() {
    return DB.getMeta('lastExport').then(function (at) {
      var n = 日数(at);
      return { at: at, 日: n,
               文: at ? (n === 0 ? '今日' : n + '日前') : 'まだ' };
    }).catch(function () { return { at: null, 日: null, 文: 'まだ' }; });
  }

  /** 気づかないと困ることだけを1本出す。優先順は 同期 → 書き出し。 */
  function 知らせを書く() {
    var el = $('#notice');
    if (!el) return;
    if (sessionStorage.getItem('notice-dismissed')) { el.hidden = true; return; }

    var 直近 = SYNC.直近();
    var 出す = null;
    if (!SYNC.使える()) {
      出す = { 文: '同期が未設定です。この端末のメモは外に残りません', 行: '設定' };
    } else if (直近.error) {
      出す = { 文: '同期できていません: ' + 直近.error, 行: '設定' };
    }

    if (出す) return 帯を出す(出す);

    書き出しの状態().then(function (e) {
      if (!S.items.length) return 帯を出す(null);
      if (e.日 === null) 帯を出す({ 文: 'まだ zip に書き出していません。写真はこの端末の中だけです', 行: '書き出す' });
      else if (e.日 >= 14) 帯を出す({ 文: e.日 + '日 書き出していません', 行: '書き出す' });
      else 帯を出す(null);
    });
  }

  function 帯を出す(出す) {
    var el = $('#notice');
    el.hidden = !出す;
    if (!出す) return;
    $('#notice-msg').textContent = 出す.文;
    $('#notice-act').onclick = function () {
      if (出す.行 === '設定') 同期設定を開く(); else exportZip();
    };
  }

  /** メニューに、この端末がどれだけ抱えているかを出す。 */
  function 保管の状態を書く() {
    var el = $('#store-line');
    if (!el) return;
    el.textContent = '';
    var 出 = [];
    書き出しの状態().then(function (e) {
      var x = $('#export-line');
      if (x) x.textContent = '最後: ' + e.文;
      if (!navigator.storage || !navigator.storage.estimate) return null;
      return navigator.storage.estimate();
    }).then(function (est) {
      if (est && est.usage) 出.push('この端末に ' + (est.usage / 1048576).toFixed(1) + ' MB');
      if (navigator.storage && navigator.storage.persisted) {
        return navigator.storage.persisted().then(function (ok) {
          出.push(ok ? '保護あり' : '保護なし');
        }).catch(function () {});
      }
    }).then(function () {
      el.textContent = 出.join(' ／ ');
    }).catch(function () {});
  }

  /* ================= 同期 ================= */

  function 同期を予約() {
    SYNC.あとで(function () { 同期する(true); });
  }

  /** 静かに(黙って)回すか、押されて回すか。 */
  function 同期する(静かに) {
    if (!SYNC.使える()) {
      if (!静かに) toast('同期先が設定されていません', null);
      return Promise.resolve();
    }
    if (!静かに) toast('同期しています…', null);
    return SYNC.回す(S.items, S.folders).then(function (r) {
      if (r && r.skipped) return;
      return reload().then(function () {
        render();
        if (!静かに) {
          toast('同期しました（送信 ' + (r.pushed || 0) + ' / 受信 ' + (r.pulled || 0) + '）', null);
        }
      });
    }).catch(function (e) {
      // 背景の失敗で保存を無かったことにはしない。黙って次の機会に送る。
      if (!静かに) toast('同期できませんでした: ' + (e && e.message), null);
    });
  }

  function 同期の状態を書く() {
    var el = document.getElementById('sync-line');
    if (!el) return;
    if (!SYNC.使える()) { el.textContent = '未設定'; return; }
    DB.allGraves().then(function (graves) {
      var 待ち = SYNC.待ち件数(S.items, graves);
      var 直近 = SYNC.直近();
      el.textContent = 待ち ? ('未送信 ' + 待ち + ' 件')
        : (直近.error ? '前回失敗' : (直近.at ? '同期済み' : '待機中'));
    }).catch(function () {});
  }

  function 同期設定を開く() {
    var c = SYNC.設定();
    $('#sync-url').value = c.url;
    $('#sync-token').value = c.token;
    var 直近 = SYNC.直近();
    $('#sync-status').textContent = 直近.error ? ('前回: ' + 直近.error)
      : (直近.at ? ('前回: ' + 直近.at.replace('T', ' ').slice(0, 16) + ' に同期') : '');
    $('#syncset').showModal();
  }

  /* ================= 配線 ================= */
  function wire() {
    $('#warn-close').onclick = function () {
      $('#sandbox-warn').hidden = true;
      sessionStorage.setItem('warn-dismissed', '1');
    };

    $('#fab-pick').onclick = function () { $('#file-pick').click(); };
    $('#fab-cam').onclick = function () { $('#file-cam').click(); };
    $('#file-pick').onchange = function (e) { intake(e.target.files); e.target.value = ''; };
    $('#file-cam').onchange = function (e) { intake(e.target.files); e.target.value = ''; };

    $('#btn-back').onclick = function () {
      S.view = 'folders'; S.folderId = null;
      $('#searchbar').hidden = true; $('#q').value = '';
      render();
    };

    $('#btn-search').onclick = function () {
      $('#searchbar').hidden = false;
      S.view = 'search';
      $('#q').focus();
      render();
    };
    $('#btn-search-close').onclick = function () {
      $('#searchbar').hidden = true; $('#q').value = '';
      S.view = S.folderId ? 'grid' : 'folders';
      render();
    };
    $('#q').oninput = function () { S.view = 'search'; render(); };

    // --- モーダル ---
    $('#m-cancel').onclick = function () { $('#modal').close(); };
    // 既定は小さく出す（日付・URL まで一目に入れる）。読みたいときだけ押して伸ばす。
    $('#m-preview').onclick = function () { this.classList.toggle('big'); };
    $('#m-save').onclick = save;

    // --- シートの面 ---
    buildTasting();
    Array.prototype.forEach.call(document.querySelectorAll('.m-tab'), function (b) {
      b.onclick = function () { 面へ(Number(b.dataset.pane)); };
    });
    $('#m-track').addEventListener('scroll', function () {
      var tr = $('#m-track');
      if (!tr.clientWidth) return;
      面の印(Math.round(tr.scrollLeft / tr.clientWidth));
    }, { passive: true });
    $('#m-tasting-more').onclick = function () {
      詳しく開く = !詳しく開く;
      try { localStorage.setItem('photomemo.tasting.more', 詳しく開く ? '1' : '0'); } catch (e) {}
      $('#m-tasting-more-box').hidden = !詳しく開く;
      this.classList.toggle('on', 詳しく開く);
      this.setAttribute('aria-expanded', String(詳しく開く));
      paintTasting();
    };
    $('#m-del').onclick = removeCurrent;
    $('#m-newtag-add').onclick = addNewTag;
    $('#m-newtag').onkeydown = function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addNewTag(); }
    };
    $('#m-paste').onclick = function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) { toast('この環境では貼付できません', null); return; }
      navigator.clipboard.readText().then(function (t) {
        var m = String(t).match(/https?:\/\/\S+/);
        if (m) $('#m-url').value = m[0]; else toast('クリップボードに URL がありません', null);
      }).catch(function () { toast('クリップボードを読めません', null); });
    };
    $('#modal').addEventListener('close', function () { M.drafts = []; });
    // Esc で閉じても保存済みのものは消えない。新規なら破棄でよい。
    $('#modal').addEventListener('cancel', function () { /* 既定の挙動のまま */ });

    // --- メニュー ---
    $('#btn-menu').onclick = function () {
      同期の状態を書く(); 保管の状態を書く(); $('#sheet').showModal();
    };
    $('#sheet').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]');
      if (!b) return;
      var a = b.dataset.act;
      $('#sheet').close();
      if (a === 'folders') openFolderMan();
      else if (a === 'tags') openTagMan();
      else if (a === 'syncnow') 同期する(false);
      else if (a === 'syncset') 同期設定を開く();
      else if (a === 'export') exportZip();
      else if (a === 'import') $('#file-zip').click();
      else if (a === 'dummy') makeDummies();
      else if (a === 'wipe') {
        if (confirm('この端末のブラウザに入っているものを全部消します。取り消せません。')) {
          DB.wipe().then(seedFolders).then(reload).then(function () {
            S.view = 'folders'; S.folderId = null; render(); toast('全部消しました', null);
          });
        }
      }
    });
    $('#file-zip').onchange = function (e) {
      if (e.target.files[0]) importZip(e.target.files[0]);
      e.target.value = '';
    };

    Array.prototype.forEach.call(document.querySelectorAll('dialog .close'), function (b) {
      b.onclick = function () { b.closest('dialog').close(); };
    });

    $('#newfolder-add').onclick = function () {
      var i = $('#newfolder'), n = i.value.trim();
      if (!n) return;
      i.value = '';
      DB.putFolder({ id: uid(), name: n, order: S.folders.length, createdAt: new Date().toISOString() })
        .then(reload).then(function () { openFolderMan(); render(); });
    };

    $('#sync-save').onclick = function () {
      var u = $('#sync-url').value.trim(), t = $('#sync-token').value.trim();
      if (!SYNC.設定を保存(u, t)) { $('#sync-status').textContent = 'この端末に設定を保存できません'; return; }
      $('#syncset').close();
      toast(u && t ? '同期先を設定しました' : '同期を止めました', null);
      if (u && t) 同期する(false);
    };

    $('#sync-test').onclick = function () {
      var u = $('#sync-url').value.trim(), t = $('#sync-token').value.trim();
      if (!u || !t) { $('#sync-status').textContent = 'URL と合言葉の両方が要ります'; return; }
      var 元 = SYNC.設定();
      SYNC.設定を保存(u, t);
      $('#sync-status').textContent = '試しています…';
      SYNC.呼ぶ('ping').then(function () {
        $('#sync-status').textContent = '繋がりました。保存を押すと有効になります。';
      }).catch(function (e) {
        SYNC.設定を保存(元.url, 元.token);
        $('#sync-status').textContent = '繋がりません: ' + ((e && e.message) || e);
      });
    };

    $('#notice-x').onclick = function () {
      sessionStorage.setItem('notice-dismissed', '1');
      $('#notice').hidden = true;
    };

    $('#toast-undo').onclick = function () {
      var f = S.undo; S.undo = null; $('#toast').hidden = true;
      if (f) f();
    };
  }

  g.APP = { S: S, M: M, boot: boot, reload: reload, render: render, intake: intake,
            同期する: 同期する, 消す: 消す };
  document.addEventListener('DOMContentLoaded', boot);
})(window);
