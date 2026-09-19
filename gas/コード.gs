/**
 * 写真メモ — メタデータの受け口（Google Apps Script）
 *
 * 画像は受け取らない。メモ・日付・URL・タグ・フォルダ・ハッシュだけを
 * スプレッドシートの1行として預かる。
 *
 * ここが受け持つのは「取り返しがつかない数百バイト」だけ。
 * 画像は端末のカメラロールに元がある、という前提の分担。
 *
 * ── 置き方 ───────────────────────────────────────────
 *  1. 新しいスプレッドシートを作る
 *  2. 拡張機能 → Apps Script → このファイルを貼る
 *  3. プロジェクトの設定 → スクリプト プロパティ に TOKEN を1つ作る
 *     （長いランダム文字列。これが合言葉。コードに書かない）
 *  4. 準備() を1回実行してシートを作る
 *  5. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *       次のユーザーとして実行: 自分
 *       アクセスできるユーザー: 全員
 *     ※「全員」にしないとブラウザから呼べない。だから TOKEN が要る
 *  6. 出てきた /exec の URL を、アプリの「同期の設定」に貼る
 * ────────────────────────────────────────────────────
 */

var シート名 = 'photomemo';
var 見出し = ['id', 'folder', 'tags', 'memo', 'date', 'url',
              'hash', 'name', 'mime', 'createdAt', 'updatedAt', 'deletedAt',
              'tasting'];

/** 最初に1回だけ実行する。シートと見出しを用意する。 */
function 準備() {
  var sh = シート_();
  SpreadsheetApp.getActive().toast('用意しました: ' + sh.getName());
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return 返す_({ ok: false, error: '中身がありません' });
    }
    var body = JSON.parse(e.postData.contents);

    var 正しい合言葉 = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!正しい合言葉) {
      return 返す_({ ok: false, error: 'サーバ側に TOKEN が設定されていません' });
    }
    if (String(body.token || '') !== String(正しい合言葉)) {
      return 返す_({ ok: false, error: '合言葉が違います' });
    }

    if (body.action === 'ping') return 返す_({ ok: true, action: 'ping', serverTime: 今_() });
    if (body.action === 'push') return 返す_(受け取る_(body.rows || []));
    if (body.action === 'pull') return 返す_(渡す_());
    return 返す_({ ok: false, error: '知らない action: ' + body.action });

  } catch (err) {
    return 返す_({ ok: false, error: String(err && err.message || err) });
  }
}

/** ブラウザで URL を直接開いたときの案内。 */
function doGet() {
  return ContentService
    .createTextOutput('写真メモのメタデータ受け口です。POST で使います。')
    .setMimeType(ContentService.MimeType.TEXT);
}

/* ================= 中身 ================= */

/** id をキーに上書き、無ければ追記。最後に書いた者が勝つ。 */
function 受け取る_(rows) {
  if (!rows.length) return { ok: true, action: 'push', count: 0, serverTime: 今_() };

  var sh = シート_();
  var 最終行 = sh.getLastRow();
  var 行番号 = {};
  if (最終行 > 1) {
    var ids = sh.getRange(2, 1, 最終行 - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) 行番号[String(ids[i][0])] = i + 2;
  }

  var 追記 = [];
  rows.forEach(function (r) {
    var 値 = 見出し.map(function (k) { return 値に直す_(r[k]); });
    var n = 行番号[String(r.id)];
    if (n) sh.getRange(n, 1, 1, 見出し.length).setValues([値]);
    else 追記.push(値);
  });
  if (追記.length) {
    sh.getRange(sh.getLastRow() + 1, 1, 追記.length, 見出し.length).setValues(追記);
  }
  return { ok: true, action: 'push', count: rows.length, serverTime: 今_() };
}

function 渡す_() {
  var sh = シート_();
  var 最終行 = sh.getLastRow();
  if (最終行 < 2) return { ok: true, action: 'pull', rows: [], serverTime: 今_() };

  var 表 = sh.getRange(2, 1, 最終行 - 1, 見出し.length).getValues();
  var rows = 表.map(function (行) {
    var o = {};
    見出し.forEach(function (k, i) { o[k] = 値に直す_(行[i]); });
    return o;
  }).filter(function (o) { return o.id; });

  return { ok: true, action: 'pull', rows: rows, serverTime: 今_() };
}

function シート_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(シート名);
  if (!sh) {
    sh = ss.insertSheet(シート名);
    sh.getRange(1, 1, 1, 見出し.length).setValues([見出し]).setFontWeight('bold');
    sh.setFrozenRows(1);
    return sh;
  }
  見出しを揃える_(sh);
  return sh;
}

/** 列が増えたときのため。既にあるシートの見出しに、足りない列だけを書き足す。
 *  既存の行はそのまま。並びは 見出し の順に合わせる。 */
function 見出しを揃える_(sh) {
  var 幅 = sh.getLastColumn();
  var 今 = 幅 ? sh.getRange(1, 1, 1, 幅).getValues()[0] : [];
  var 足りない = false;
  for (var i = 0; i < 見出し.length; i++) {
    if (String(今[i] || '') !== 見出し[i]) { 足りない = true; break; }
  }
  if (!足りない) return;
  sh.getRange(1, 1, 1, 見出し.length).setValues([見出し]).setFontWeight('bold');
  sh.setFrozenRows(1);
}

/** 日付セルが Date で返ってくることがあるので、文字列に揃える。 */
function 値に直す_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
  return String(v);
}

function 今_() { return new Date().toISOString(); }

/** ContentService は CORS ヘッダを自前で足せないが、
 *  「全員」でデプロイした web app のレスポンスには Google 側が付けてくれる。
 *  呼ぶ側を Content-Type: text/plain にして preflight を起こさないのが肝。 */
function 返す_(o) {
  return ContentService
    .createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
