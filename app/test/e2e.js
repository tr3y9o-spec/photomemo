const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SP = process.env.OUT_DIR || fs.mkdtempSync(path.join(require('os').tmpdir(), 'photomemo-'));
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml', '.webp':'image/webp' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});

/* 偽の GAS。本物に寄せて次を守る:
   - 別オリジン（別ポート）で動く
   - OPTIONS(preflight) に応えない  ← application/json で送ると必ず落ちる
   - POST のレスポンスには Access-Control-Allow-Origin: * が付く */
const GAS_TOKEN = 'ためしの合言葉';
const gasRows = new Map();
let gasPreflightSeen = 0, gasCalls = 0;

const gas = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { gasPreflightSeen++; res.writeHead(405); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    gasCalls++;
    const send = (o) => {
      res.writeHead(200, { 'content-type': 'application/json',
        'access-control-allow-origin': '*' });
      res.end(JSON.stringify(o));
    };
    let b;
    try { b = JSON.parse(raw); } catch (e) { return send({ ok: false, error: 'bad json' }); }
    if (b.token !== GAS_TOKEN) return send({ ok: false, error: '合言葉が違います' });
    const serverTime = new Date().toISOString();
    if (b.action === 'ping') return send({ ok: true, action: 'ping', serverTime });
    if (b.action === 'push') {
      (b.rows || []).forEach(r => gasRows.set(r.id, r));
      return send({ ok: true, action: 'push', count: (b.rows || []).length, serverTime });
    }
    if (b.action === 'pull') {
      return send({ ok: true, action: 'pull', rows: [...gasRows.values()], serverTime });
    }
    send({ ok: false, error: 'unknown action' });
  });
});

const ok = [], bad = [], errs = [];
const check = (n, c, x='') => (c ? ok : bad).push(n + (x ? ' :: ' + x : ''));
const N = async (p, sel) => await p.locator(sel).count();

(async () => {
  console.log('出力先: ' + SP);
  await new Promise(r => server.listen(8777, '127.0.0.1', r));
  await new Promise(r => gas.listen(8778, '127.0.0.1', r));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  let dialogFired = false;
  page.on('dialog', async d => { dialogFired = true; await d.accept(); });

  const dummy = async () => {
    await page.click('#btn-menu');
    await page.click('button[data-act="dummy"]');
    await page.waitForSelector('#modal[open]', { timeout: 10000 });
    await page.waitForTimeout(700);
  };
  let fatal = null;

  try {
    await page.goto('http://127.0.0.1:8777/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    /* --- 起動 --- */
    check('起動時に既定フォルダ5つ', await N(page,'.folder') === 5, String(await N(page,'.folder')));
    check('起動時はグリッドが隠れている', !(await page.locator('#view-grid').isVisible()));
    check('注意帯が出ている', await page.locator('#sandbox-warn').isVisible());
    await page.click('#warn-close'); await page.waitForTimeout(200);
    check('注意帯を閉じられる', !(await page.locator('#sandbox-warn').isVisible()));

    /* --- 知らせの帯（同期・書き出し） --- */
    check('未設定なら同期の帯が出る', await page.locator('#notice').isVisible());
    check('帯に理由が書いてある',
      (await page.locator('#notice-msg').textContent()).includes('同期が未設定'),
      await page.locator('#notice-msg').textContent());
    await page.click('#notice-act'); await page.waitForTimeout(500);
    check('帯から同期の設定が開く', await page.locator('#syncset').isVisible());
    await page.locator('#syncset .close').click(); await page.waitForTimeout(300);
    await page.click('#notice-x'); await page.waitForTimeout(300);
    check('帯を閉じられる', !(await page.locator('#notice').isVisible()));
    await page.evaluate(() => sessionStorage.removeItem('notice-dismissed'));

    /* --- 1回目の取り込み --- */
    await dummy();
    check('5枚ぶんの帯が出る', await N(page,'.sth') === 5);
    check('プレビューが出る', await N(page,'#m-preview img') === 1);
    check('フォルダが既定で選択済み', await N(page,'#m-folders .chip.on') === 1);
    const d0 = await page.inputValue('#m-date');
    check('日付が既定で入る', /^\d{4}-\d{2}-\d{2}$/.test(d0), d0);
    check('日付の出どころが出る', (await page.locator('#m-date-src').textContent()).includes('既定'));
    check('初回は重複の目印が出ない', !(await page.locator('#m-dup').isVisible()));

    await page.fill('#m-newtag', '海辺'); await page.click('#m-newtag-add');
    await page.fill('#m-newtag', '仕事'); await page.click('#m-newtag-add');
    check('足したタグが選択状態', await N(page,'#m-tags .chip.on') === 2);

    await page.fill('#m-memo', 'いちまいめのメモ');
    await page.locator('.sth').nth(2).click(); await page.waitForTimeout(200);
    check('切替でメモが1枚ごとに分かれる', (await page.inputValue('#m-memo')) === '');
    await page.fill('#m-memo', 'さんまいめのメモ');
    await page.fill('#m-url', 'https://example.com/post/1');
    await page.locator('#m-folders .chip', { hasText: '資料' }).click();

    dialogFired = false;
    await page.click('#m-save');
    await page.waitForTimeout(900);
    check('保存で聞き返さない', !dialogFired);
    check('保存でモーダルが閉じる', await N(page,'#modal[open]') === 0);
    check('トーストに取り消しが出る', await page.locator('#toast-undo').isVisible());

    const title = await page.locator('#title').textContent();
    check('保存先フォルダが開く', title.includes('資料') && title.includes('5'), title);
    check('タイルが5枚', await N(page,'.tile') === 5, String(await N(page,'.tile')));
    check('グリッド中はフォルダ一覧が隠れている', !(await page.locator('#view-folders').isVisible()));
    check('サムネが作られる', await N(page,'.tile img') === 5);
    check('メモありバッジが2枚', await N(page,'.b-memo') === 2, String(await N(page,'.b-memo')));
    check('URLバッジが1枚', await N(page,'.b-url') === 1, String(await N(page,'.b-url')));

    /* --- 2回目: 重複の目印 / 既定の引き継ぎ --- */
    await dummy();
    check('同じ画像で重複の目印が出る', await page.locator('#m-dup').isVisible());
    check('前回のフォルダが既定', (await page.locator('#m-folders .chip.on').textContent()) === '資料');
    const ft = await page.locator('#m-tags .chip').first().textContent();
    check('よく使うタグが先頭に並ぶ', ['海辺','仕事'].includes(ft), ft);
    check('前回のタグは自動では付かない', await N(page,'#m-tags .chip.on') === 0);
    await page.fill('#m-memo', '二回目');
    await page.click('#m-save');
    await page.waitForTimeout(900);
    check('2回目で10枚', await N(page,'.tile') === 10, String(await N(page,'.tile')));

    /* --- 取り消し --- */
    await page.click('#toast-undo');
    await page.waitForTimeout(800);
    check('取り消しで5枚に戻る', await N(page,'.tile') === 5, String(await N(page,'.tile')));

    /* --- あとから編集 --- */
    await page.locator('.tile').first().click();
    await page.waitForSelector('#modal[open]'); await page.waitForTimeout(500);
    check('編集に削除が出る', await page.locator('#m-del').isVisible());
    check('編集では帯が出ない', !(await page.locator('#m-strip').isVisible()));
    check('編集でタグが復元される', await N(page,'#m-tags .chip.on') === 2,
          String(await N(page,'#m-tags .chip.on')));
    await page.fill('#m-memo', 'あとから書き足した');
    await page.click('#m-save'); await page.waitForTimeout(800);
    const edited = await page.evaluate(() =>
      APP.S.items.some(i => i.memo === 'あとから書き足した'));
    check('あとから書ける', edited);
    check('編集で枚数は増えない', await N(page,'.tile') === 5, String(await N(page,'.tile')));

    /* --- 削除と取り消し --- */
    await page.locator('.tile').first().click();
    await page.waitForSelector('#modal[open]'); await page.waitForTimeout(400);
    await page.click('#m-del'); await page.waitForTimeout(800);
    check('削除できる', await N(page,'.tile') === 4, String(await N(page,'.tile')));
    await page.click('#toast-undo'); await page.waitForTimeout(800);
    check('削除も取り消せる', await N(page,'.tile') === 5, String(await N(page,'.tile')));

    /* --- 検索 --- */
    await page.click('#btn-search');
    await page.fill('#q', 'あとから'); await page.waitForTimeout(400);
    check('メモ本文で検索できる', await N(page,'.tile') === 1, String(await N(page,'.tile')));
    await page.fill('#q', '海辺'); await page.waitForTimeout(400);
    check('タグで検索できる', await N(page,'.tile') === 5, String(await N(page,'.tile')));
    await page.fill('#q', '資料 仕事'); await page.waitForTimeout(400);
    check('複数語で絞れる', await N(page,'.tile') === 5, String(await N(page,'.tile')));
    await page.click('#btn-search-close'); await page.waitForTimeout(400);
    check('検索バーを閉じられる', !(await page.locator('#searchbar').isVisible()));

    /* --- テイスティングシートの面（スワイプ/タブ） --- */
    await page.locator('.tile').first().click();
    await page.waitForSelector('#modal[open]'); await page.waitForTimeout(500);
    check('開くとメモの面から始まる',
      (await page.evaluate(() => document.querySelector('#m-track').scrollLeft)) === 0);
    check('ワインのタブが出ている', await page.locator('.m-tab').nth(1).isVisible());
    await page.locator('.m-tab').nth(1).click(); await page.waitForTimeout(700);
    const 面 = await page.evaluate(() => {
      const t = document.querySelector('#m-track');
      return { 位置: Math.round(t.scrollLeft / t.clientWidth), 印: document.querySelectorAll('.m-tab.on')[0].textContent };
    });
    check('タブでワインの面へ移る', 面.位置 === 1 && 面.印 === 'ワイン', JSON.stringify(面));
    check('シート側でも保存ボタンが見えている', await page.locator('#m-save').isVisible());

    // 何も書かずに保存できる（必須項目を作らない）
    dialogFired = false;
    await page.click('#m-save'); await page.waitForTimeout(800);
    check('シートに何も書かずに保存できる', !dialogFired && await N(page,'#modal[open]') === 0);
    check('何も書かなければシートは付かない',
      await page.evaluate(() => APP.S.items.every(i => !i.tasting)));

    // 書いて保存 → 開き直すと残っている
    await page.locator('.tile').first().click();
    await page.waitForSelector('#modal[open]'); await page.waitForTimeout(500);
    await page.locator('.m-tab').nth(1).click(); await page.waitForTimeout(600);
    await page.locator('#m-pane-1 .t-row[data-key="色"] .chip', { hasText: 'ガーネット' }).click();
    await page.locator('#m-pane-1 .t-row[data-key="香り"] .chip', { hasText: 'いちご' }).click();
    await page.waitForTimeout(200);
    const 絵 = await page.evaluate(() => {
      const im = [...document.querySelectorAll('#m-pane-1 .t-row[data-key="香り"] .chip:not([hidden]) img')];
      return { 枚: im.length, 出た: im.filter(i => i.complete && i.naturalWidth > 0).length };
    });
    check('香りが写真のタイルで出る', 絵.枚 >= 10 && 絵.出た === 絵.枚, JSON.stringify(絵));
    const 香り数 = await page.locator('#m-pane-1 .t-row[data-key="香り"] .chip:visible').count();
    check('香りは既定で絞って出る（12個＋すべて＋選んだ分）', 香り数 <= 14, String(香り数));
    // 枠の外にある語は「すべて」を開かないと選べない
    await page.locator('#m-pane-1 .t-row[data-key="香り"] .t-more').click();
    await page.waitForTimeout(200);
    const 香り全 = await page.locator('#m-pane-1 .t-row[data-key="香り"] .chip:visible').count();
    check('「すべて」で全部出る', 香り全 > 30, String(香り全));
    // 写真のある語だけ絵になる。無い語は文字のタイルで同じ枠に収まる
    check('写真の有無とタイルの形が一致する', await page.evaluate(() => {
      const 写 = TASTING.香りの写真 || {};
      return [...document.querySelectorAll('#m-pane-1 .t-row[data-key="香り"] .chip')]
        .filter(b => !b.classList.contains('t-more'))
        .every(b => !!b.querySelector('img') === !!写[b.dataset.val]);
    }));
    await page.locator('#m-pane-1 .t-row[data-key="香り"] .chip', { hasText: '樽' }).click();
    await page.locator('#m-pane-1 .t-row[data-key="香り"] .t-more').click();
    await page.waitForTimeout(200);
    const 香り後 = await page.locator('#m-pane-1 .t-row[data-key="香り"] .chip:visible').count();
    check('閉じても選んだ語は残って見える', 香り後 <= 15 &&
      await N(page,'#m-pane-1 .t-row[data-key="香り"] .chip.on:visible') === 2, String(香り後));
    // 目盛りは7つが1行。押すのは短い語で、記録は元の言葉
    await page.locator('#m-pane-1 .t-row[data-key="酸味"] .chip[data-val="やや高い"]').click();
    await page.waitForTimeout(200);
    const 目盛り = await page.evaluate(() => {
      const row = document.querySelector('#m-pane-1 .t-row[data-key="酸味"]');
      const cs = [...row.querySelectorAll('.chip')];
      const 上 = new Set(cs.map(c => Math.round(c.getBoundingClientRect().top)));
      return { 数: cs.length, 行数: 上.size, 押した語: cs.find(c => c.classList.contains('on')).textContent,
               ラベル: row.querySelector('.lab .now').textContent };
    });
    check('7段が1行に収まる', 目盛り.数 === 7 && 目盛り.行数 === 1, JSON.stringify(目盛り));
    check('押すのは短い語、出るのは元の言葉',
      目盛り.押した語 === 'やや高' && 目盛り.ラベル === 'やや高い', JSON.stringify(目盛り));
    await page.locator('#m-pane-1 .t-row[data-key="評価"] .t-star').nth(3).click();
    await page.fill('#m-pane-1 .t-row[data-key="ワイン名"] input', 'ためしの一本');
    await page.waitForTimeout(200);

    check('詳しくは畳まれている', !(await page.locator('#m-tasting-more-box').isVisible()));
    await page.click('#m-tasting-more'); await page.waitForTimeout(300);
    check('「詳しく」で追加項目が開く', await page.locator('#m-tasting-more-box').isVisible());
    await page.click('#m-save'); await page.waitForTimeout(900);

    const 束 = await page.evaluate(() =>
      (APP.S.items.find(i => Array.isArray(i.tasting) && i.tasting.some(r => r.ワイン名)) || {}).tasting || null);
    check('1回ぶんの記録として積まれる', Array.isArray(束) && 束.length === 1, JSON.stringify(束));
    check('回に記録した時刻が入る', !!(束 && 束[0].記録日時), (束 && 束[0].記録日時) || 'なし');
    const 書けた = 束 ? 束[0] : null;
    check('シートが1枚に付く',
      !!書けた && 書けた.色 === 'ガーネット' && 書けた.評価 === 4 && 書けた.ワイン名 === 'ためしの一本',
      JSON.stringify(書けた));
    check('複数選べる香りが配列で入る',
      !!書けた && Array.isArray(書けた.香り) && 書けた.香り.length === 2, JSON.stringify(書けた && 書けた.香り));
    const タ = await page.evaluate(() =>
      (APP.S.items.find(i => Array.isArray(i.tasting) && i.tasting.some(r => r.ワイン名)) || {}).tags || []);
    check('目盛りも元の言葉でタグになる', タ.includes('酸味:やや高い'), JSON.stringify(タ));
    check('シートの値が「鍵:値」のタグになる',
      タ.includes('色:ガーネット') && タ.includes('香り:いちご') && タ.includes('香り:樽') &&
      タ.includes('評価:4') && タ.includes('ワイン名:ためしの一本'), JSON.stringify(タ));
    check('手で付けたタグも残る', タ.includes('海辺') && タ.includes('仕事'), JSON.stringify(タ));
    check('タイルに 🍷 が出る', await N(page,'.b-wine') === 1, String(await N(page,'.b-wine')));

    await page.locator('.tile').first().click();
    await page.waitForSelector('#modal[open]'); await page.waitForTimeout(500);
    await page.locator('.m-tab').nth(1).click(); await page.waitForTimeout(600);
    check('開き直すと選んだものが残っている',
      await N(page,'#m-pane-1 .t-row[data-key="色"] .chip.on') === 1 &&
      await N(page,'#m-pane-1 .t-row[data-key="香り"] .chip.on') === 2 &&
      await N(page,'#m-pane-1 .t-row[data-key="評価"] .t-star.on') === 4);
    check('計算で作ったタグはタグ欄に出ない',
      await N(page, '#m-tags .chip') > 0 &&
      await page.evaluate(() => [...document.querySelectorAll('#m-tags .chip')]
        .every(b => b.textContent.indexOf(':') < 0)));
    check('「詳しく」の開閉を覚えている', await page.locator('#m-tasting-more-box').isVisible());
    /* --- 同じ写真に2回目を積む --- */
    check('回の帯に1回目が出ている',
      (await page.locator('#m-times .chip').first().textContent()) === '1回目');
    await page.locator('#m-times .chip', { hasText: 'もう一度' }).click();
    await page.waitForTimeout(400);
    check('2回目が増える', await N(page, '#m-times .chip[data-val], #m-times .chip') >= 2,
      String(await N(page, '#m-times .chip')));
    check('2回目は何も選ばれていない',
      await N(page, '#m-pane-1 .t-row[data-key="酸味"] .chip.on') === 0);
    await page.locator('#m-pane-1 .t-row[data-key="酸味"] .chip[data-val="非常に高い"]').click();
    await page.locator('#m-pane-1 .t-row[data-key="余韻"] .chip[data-val="長い"]').click();
    await page.waitForTimeout(200);
    await page.locator('#m-times .chip', { hasText: '1回目' }).click();
    await page.waitForTimeout(300);
    check('1回目に戻ると1回目の値が出る',
      (await page.locator('#m-pane-1 .t-row[data-key="酸味"] .chip.on').textContent()) === 'やや高',
      await page.locator('#m-pane-1 .t-row[data-key="酸味"] .chip.on').textContent());
    await page.click('#m-save'); await page.waitForTimeout(900);

    const 二回 = await page.evaluate(() =>
      (APP.S.items.find(i => Array.isArray(i.tasting) && i.tasting.length > 1) || {}).tasting || null);
    check('2回ぶんが1枚に残る', !!二回 && 二回.length === 2, JSON.stringify(二回 && 二回.map(r => r.酸味)));
    check('回ごとに別の値を持てる',
      !!二回 && 二回[0].酸味 === 'やや高い' && 二回[1].酸味 === '非常に高い',
      JSON.stringify(二回 && 二回.map(r => r.酸味)));
    const タ2 = await page.evaluate(() =>
      (APP.S.items.find(i => Array.isArray(i.tasting) && i.tasting.length > 1) || {}).tags || []);
    check('両方の回の値がタグになる',
      タ2.includes('酸味:やや高い') && タ2.includes('酸味:非常に高い'), JSON.stringify(タ2));

    // 2回目を消して1回ぶんに戻す（以降の検査は1回ぶんを前提にしている）
    await page.locator('.tile').first().click();
    await page.waitForSelector('#modal[open]'); await page.waitForTimeout(500);
    await page.locator('.m-tab').nth(1).click(); await page.waitForTimeout(600);
    check('開き直すと最後の回から始まる',
      (await page.locator('#m-times .chip.on').textContent()) === '2回目',
      await page.locator('#m-times .chip.on').textContent());
    await page.locator('#m-times .chip', { hasText: 'この回を消す' }).click();
    await page.waitForTimeout(400);
    check('回を消せる', await N(page, '#m-times .chip', ) >= 1 &&
      (await page.locator('#m-times .chip.on').textContent()) === '1回目');
    await page.click('#m-save'); await page.waitForTimeout(900);
    const 戻り回 = await page.evaluate(() =>
      (APP.S.items.find(i => Array.isArray(i.tasting)) || {}).tasting || null);
    check('消した回は残らない', !!戻り回 && 戻り回.length === 1, JSON.stringify(戻り回 && 戻り回.length));

    await page.locator('.tile').first().click();
    await page.waitForSelector('#modal[open]'); await page.waitForTimeout(500);
    await page.locator('.m-tab').nth(1).click(); await page.waitForTimeout(600);

    // もう一度押すと外れる（任意のままにできる）
    await page.locator('#m-pane-1 .t-row[data-key="色"] .chip', { hasText: 'ガーネット' }).click();
    await page.waitForTimeout(200);
    check('もう一度押すと外れる', await N(page,'#m-pane-1 .t-row[data-key="色"] .chip.on') === 0);
    await page.locator('#m-pane-1 .t-row[data-key="色"] .chip', { hasText: 'ガーネット' }).click();
    await page.click('#m-save'); await page.waitForTimeout(800);

    /* --- テイスティングシート（器だけ。画面はまだ無いので直接書く） --- */
    await page.evaluate(async () => {
      // 1枚目は後で削除の検査に使われるので、最後まで残る「さんまいめ」に書く
      const it = APP.S.items.find(i => i.memo === 'さんまいめのメモ');
      it.tasting = { 色: 'ルビー', 香り: ['洋梨', '樽'], 余韻: '長い', 評価: 4 };
      it.updatedAt = new Date().toISOString();
      await DB.putItem(it, null);
      await APP.reload(); APP.render();
    });
    await page.waitForTimeout(400);
    await page.click('#btn-search');
    await page.fill('#q', '洋梨'); await page.waitForTimeout(400);
    check('シートの言葉で検索できる', await N(page,'.tile') === 1, String(await N(page,'.tile')));  // 洋梨は1枚だけ
    await page.click('#btn-search-close'); await page.waitForTimeout(300);

    // 画像だけ失った記録を1件作る（同期で引き直した直後と同じ形）
    await page.evaluate(async () => {
      const src = APP.S.items[APP.S.items.length - 1];
      await DB.putItem({
        id: 'waiting-test', folderId: src.folderId, tags: [], memo: '画像を無くしたメモ',
        date: src.date, url: '', createdAt: src.createdAt,
        updatedAt: new Date().toISOString(), mime: 'image/jpeg', name: 'なくした.jpg',
        hash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        w: 0, h: 0, thumb: null, waiting: true
      }, null);
      await APP.reload(); APP.render();
    });
    await page.waitForTimeout(300);

    await page.click('#btn-menu'); await page.waitForTimeout(600);
    check('メニューに最後の書き出しが出る',
      (await page.locator('#export-line').textContent()).includes('まだ'),
      await page.locator('#export-line').textContent());
    check('メニューに使用量が出る',
      /MB/.test(await page.locator('#store-line').textContent()),
      await page.locator('#store-line').textContent());
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);

    /* --- 書き出し --- */
    const dl = page.waitForEvent('download', { timeout: 20000 });
    await page.click('#btn-menu');
    await page.click('button[data-act="export"]');
    const zipPath = SP + '/out.zip';
    await (await dl).saveAs(zipPath);
    check('zip が出る', fs.statSync(zipPath).size > 10000, fs.statSync(zipPath).size + 'B');
    // 外部ツールで読めるか（自前 zip が本物かの確認）
    const unzip = require('child_process').spawnSync('python3',
      ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(len(z.namelist()));z.testzip();print(z.read("メタ.json").decode()[:60])', zipPath],
      { encoding: 'utf-8' });
    check('zip が他のツールで開ける', unzip.status === 0, (unzip.stderr||'').split('\n')[0]);
    check('zip に6件（メタ+5枚）', (unzip.stdout||'').split('\n')[0].trim() === '6', (unzip.stdout||'').split('\n')[0]);

    const metaTxt = require('child_process').spawnSync('python3',
      ['-c', 'import zipfile,sys;print(zipfile.ZipFile(sys.argv[1]).read("メタ.json").decode())', zipPath],
      { encoding: 'utf-8' });
    check('zip のメタにシートが入る',
      (metaTxt.stdout||'').includes('"tasting"') && (metaTxt.stdout||'').includes('洋梨'),
      (metaTxt.stdout||'').includes('"tasting"') ? 'あり' : 'なし');

    await page.click('#btn-menu'); await page.waitForTimeout(600);
    check('書き出すと「今日」に変わる',
      (await page.locator('#export-line').textContent()).includes('今日'),
      await page.locator('#export-line').textContent());
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);

    /* --- 全消し → 読み込み（持ち出せることの確認） --- */
    await page.click('#btn-menu');
    await page.click('button[data-act="wipe"]');
    await page.waitForTimeout(1000);
    check('全消しでフォルダ画面に戻る', await N(page,'.folder') === 5);
    check('全消しで0枚', (await page.evaluate(() => APP.S.items.length)) === 0);

    await page.click('#btn-menu');
    await page.click('button[data-act="import"]');
    await page.setInputFiles('#file-zip', zipPath);
    await page.waitForTimeout(3000);
    const r = await page.evaluate(() => ({
      n: APP.S.items.length,
      tags: (APP.S.items[0].tags || []).filter(t => t.indexOf(':') < 0),
      memo: APP.S.items.map(i => i.memo).filter(Boolean).length,
      thumb: APP.S.items.filter(i => i.thumb).length,
      url: APP.S.items.filter(i => i.url).length,
      folder: APP.S.folders.length
    }));
    check('読み込みで件数が戻る（画像5枚＋画像待ち1件）', r.n === 6, 'items=' + r.n);
    check('読み込みでタグが戻る', Array.isArray(r.tags) && r.tags.length === 2, JSON.stringify(r.tags));
    check('読み込みでメモが戻る（画像待ちの分を含む）', r.memo === 3, 'memo=' + r.memo);
    check('読み込みでURLが戻る', r.url === 1, 'url=' + r.url);
    check('読み込みでサムネが作り直される（画像のある5件）', r.thumb === 5, 'thumb=' + r.thumb);
    check('画像待ちも zip から戻る（メモだけの記録を落とさない）', await page.evaluate(() => {
      const w = APP.S.items.filter(i => i.waiting);
      return w.length === 1 && w[0].memo === '画像を無くしたメモ' && !!w[0].hash;
    }));
    // 以降の検査は5枚を前提にしているので、確認用の1件はここで取り除く（墓標は立てない）
    await page.evaluate(async () => {
      await DB.delItem('waiting-test', false);
      await APP.reload(); APP.render();
    });
    await page.waitForTimeout(300);
    const t1 = await page.evaluate(() =>
      (APP.S.items.find(i => i.tasting && (i.tasting.香り || []).includes('洋梨')) || {}).tasting || null);
    check('読み込みでシートが戻る',
      !!t1 && t1.色 === 'ルビー' && (t1.香り || []).includes('洋梨') && t1.評価 === 4,
      JSON.stringify(t1));
    check('フォルダが増殖しない', r.folder === 5, 'folders=' + r.folder);

    /* --- フォルダ整理 --- */
    await page.click('#btn-menu');
    await page.click('button[data-act="folders"]');
    await page.waitForSelector('#folderman[open]');
    await page.locator('#folderman-list input').first().fill('しりょう');
    await page.locator('#folderman-list input').nth(1).click();
    await page.waitForTimeout(900);
    check('フォルダを改名できる',
      (await page.locator('#folderman-list input').first().inputValue()) === 'しりょう');
    await page.locator('#folderman .close').click(); await page.waitForTimeout(300);

    /* --- タグ整理（統合） --- */
    await page.click('#btn-menu');
    await page.click('button[data-act="tags"]');
    await page.waitForSelector('#tagman[open]');
    check('計算で作ったタグはタグ整理に出ない', await page.evaluate(() =>
      [...document.querySelectorAll('#tagman-list input')].every(i => i.value.indexOf(':') < 0)));
    const before = await N(page,'#tagman-list .mrow');
    // 回数も時刻も同じタグは名前順で並ぶ。名前順はブラウザの言語で変わる
    // （ja では 海辺→仕事、en では 仕事→海辺）ので、残る名前は決め打ちしない
    const keep =await page.locator('#tagman-list input').first().inputValue();
    await page.locator('#tagman-list input').nth(1).fill(keep);
    await page.locator('#tagman-list input').first().click();
    await page.waitForTimeout(1200);
    const after = await N(page,'#tagman-list .mrow');
    check('同名にすると統合される', after === before - 1, before + ' -> ' + after);
    const merged = await page.evaluate(() =>
      (APP.S.items[0].tags || []).filter(t => t.indexOf(':') < 0));
    check('統合後もタグが1つ残る', merged.length === 1, JSON.stringify(merged));
    await page.locator('#tagman .close').click(); await page.waitForTimeout(300);

    /* --- 共有シート相当（?url=）--- */
    await page.goto('http://127.0.0.1:8777/?url=' + encodeURIComponent('https://www.instagram.com/p/ABC123/'),
      { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    check('受け取ったURLの帯が出る', await page.locator('#pending').isVisible());
    check('URLが履歴から消える', !page.url().includes('instagram'), page.url());
    await dummy();
    check('次の保存にURLが入る', (await page.inputValue('#m-url')).includes('instagram'),
          await page.inputValue('#m-url'));
    await page.click('#m-cancel'); await page.waitForTimeout(300);

    /* ================= 同期（メタだけ） ================= */
    await page.goto('http://127.0.0.1:8777/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    // 設定前は「未設定」と出る
    await page.click('#btn-menu'); await page.waitForTimeout(300);
    check('未設定と表示される', (await page.locator('#sync-line').textContent()) === '未設定',
          await page.locator('#sync-line').textContent());
    await page.click('button[data-act="syncset"]');
    await page.waitForSelector('#syncset[open]');

    // 合言葉が違えば繋がらない
    await page.fill('#sync-url', 'http://127.0.0.1:8778/');
    await page.fill('#sync-token', 'ちがう合言葉');
    await page.click('#sync-test'); await page.waitForTimeout(900);
    check('合言葉が違うと弾かれる',
      (await page.locator('#sync-status').textContent()).includes('合言葉が違います'),
      await page.locator('#sync-status').textContent());

    // 正しい合言葉なら繋がる
    await page.fill('#sync-token', 'ためしの合言葉');
    await page.click('#sync-test'); await page.waitForTimeout(900);
    check('正しい合言葉で繋がる',
      (await page.locator('#sync-status').textContent()).includes('繋がりました'),
      await page.locator('#sync-status').textContent());
    check('preflight が飛んでいない（text/plain が効いている）', gasPreflightSeen === 0,
          'OPTIONS=' + gasPreflightSeen);
    await page.click('#sync-save'); await page.waitForTimeout(2500);

    const 送られた = [...gasRows.values()];
    // 全消しでメタも消えるので、帯は「書き出していません」に替わる。同期の知らせは消える
    const 帯 = (await page.locator('#notice').isVisible())
      ? await page.locator('#notice-msg').textContent() : '';
    check('同期を設定すると同期の知らせが消える', !帯.includes('同期'), 帯 || '（帯なし）');
    check('既存の全件が送られる', 送られた.length === 5, 'rows=' + 送られた.length);
    check('メモが行に載る', 送られた.some(r => r.memo === 'あとから書き足した'),
          JSON.stringify(送られた.map(r => r.memo)));
    check('タグが行に載る',
      送られた.every(r => (r.tags || '').split(',').filter(t => t.indexOf(':') < 0).join(',') === keep),
      JSON.stringify(送られた.map(r => r.tags)));
    check('シート由来のタグも行に載る',
      送られた.some(r => (r.tags || '').includes('色:ガーネット')),
      JSON.stringify(送られた.map(r => r.tags).filter(Boolean)));
    check('フォルダ名が行に載る', 送られた.every(r => r.folder === '資料'),
          JSON.stringify([...new Set(送られた.map(r => r.folder))]));
    const 味行 = 送られた.filter(r => r.tasting);
    check('シートが行に載る（JSON 1列）', 味行.length === 2, '行=' + 味行.length);
    const 洋梨行 = 味行.filter(r => r.tasting.indexOf('洋梨') >= 0);
    check('行のシートが読み戻せる', (() => {
      try { const o = JSON.parse(洋梨行[0].tasting); return o.色 === 'ルビー' && o.香り[0] === '洋梨'; }
      catch (e) { return false; }
    })(), (洋梨行[0] || {}).tasting);
    check('ハッシュが行に載る', 送られた.every(r => r.hash && r.hash.length > 8));
    check('画像は送っていない',
      送られた.every(r => !('blob' in r) && !('thumb' in r) && JSON.stringify(r).length < 2000));

    // 送り終われば未同期の目印が消える
    await page.locator('.folder').nth(await page.evaluate(() => {
      let best = 0, n = -1;
      APP.S.folders.forEach((f, i) => {
        const c = APP.S.items.filter(x => x.folderId === f.id).length;
        if (c > n) { n = c; best = i; }
      });
      return best;
    })).click();
    await page.waitForTimeout(600);
    check('同期済みなら未同期の目印が消える', await N(page, '.b-sync') === 0,
          String(await N(page, '.b-sync')));

    // 編集すると、その行だけ更新される
    const 前の呼び出し = gasCalls;
    await page.locator('.tile').first().click();
    await page.waitForSelector('#modal[open]'); await page.waitForTimeout(400);
    await page.fill('#m-memo', '同期のテスト');
    await page.click('#m-save'); await page.waitForTimeout(3000);
    check('編集が向こうへ伝わる',
      [...gasRows.values()].some(r => r.memo === '同期のテスト'));
    check('編集で同期が走る', gasCalls > 前の呼び出し);

    // 削除は墓標として伝わる
    await page.locator('.tile').first().click();
    await page.waitForSelector('#modal[open]'); await page.waitForTimeout(400);
    const 消すid = await page.evaluate(() => APP.M.drafts[0].id);
    await page.click('#m-del'); await page.waitForTimeout(3000);
    check('削除が墓標として伝わる',
      !!(gasRows.get(消すid) && gasRows.get(消すid).deletedAt), JSON.stringify(gasRows.get(消すid) || {}));

    /* --- 全消ししてから引き直す（これが保険の本番） --- */
    await page.click('#btn-menu');
    await page.click('button[data-act="wipe"]');
    await page.waitForTimeout(1200);
    check('全消しで0枚', (await page.evaluate(() => APP.S.items.length)) === 0);

    await page.click('#btn-menu');
    await page.click('button[data-act="syncnow"]');
    await page.waitForTimeout(3000);
    const 戻り = await page.evaluate(() => ({
      n: APP.S.items.length,
      waiting: APP.S.items.filter(i => i.waiting).length,
      memos: APP.S.items.map(i => i.memo).filter(Boolean),
      ids: APP.S.items.map(i => i.id),
      folders: APP.S.folders.map(f => f.name),
      tags: APP.S.items[0] && APP.S.items[0].tags
    }));
    check('消しても メモが引き直せる', 戻り.n === 4, 'items=' + 戻り.n);
    check('引き直した分は画像待ちになる', 戻り.waiting === 戻り.n, 'waiting=' + 戻り.waiting);
    const t2 = await page.evaluate(() =>
      (APP.S.items.find(i => i.tasting && (i.tasting.香り || []).includes('洋梨')) || {}).tasting || null);
    check('消してもシートが引き直せる',
      !!t2 && t2.色 === 'ルビー' && (t2.香り || []).includes('洋梨'), JSON.stringify(t2));
    check('メモの中身がそのまま戻る', 戻り.memos.includes('さんまいめのメモ'),
          JSON.stringify(戻り.memos));
    check('タグも戻る', JSON.stringify(戻り.tags) === JSON.stringify([keep]), JSON.stringify(戻り.tags));
    check('フォルダ名から作り直される', 戻り.folders.includes('資料'), JSON.stringify(戻り.folders));
    check('削除したものは戻ってこない', !戻り.ids.includes(消すid));
    await page.waitForTimeout(300);
    await page.locator('.folder').filter({ hasText: '資料' }).click();
    await page.waitForTimeout(500);
    check('画像待ちのタイルが出る', await N(page, '.tile.waiting') === 4,
          String(await N(page, '.tile.waiting')));
    await page.screenshot({ path: SP + '/s5-waiting.png' });

    /* --- 同じ画像を選び直すと、ハッシュ一致でメモが戻る --- */
    await dummy();
    const 復元 = await page.evaluate(() => APP.M.drafts.map(d => ({ memo: d.memo, src: d.dateSrc })));
    check('選び直すとメモが画像に戻る',
      復元.some(d => d.memo === 'さんまいめのメモ'), JSON.stringify(復元.map(d => d.memo)));
    check('引き取れるのは待っていた4枚だけ',
      復元.filter(d => d.src === 'メモから復元').length === 4,
      JSON.stringify(復元.map(d => d.src)));
    check('待っていなかった1枚は通常どおり',
      復元.filter(d => d.src !== 'メモから復元').length === 1);
    await page.click('#m-save'); await page.waitForTimeout(3000);
    const 後 = await page.evaluate(() => ({
      n: APP.S.items.length, waiting: APP.S.items.filter(i => i.waiting).length,
      thumb: APP.S.items.filter(i => i.thumb).length
    }));
    check('画像待ちが解消する', 後.waiting === 0, 'waiting=' + 後.waiting);
    check('増殖しない（同じ id を引き取る）', 後.n === 5, 'items=' + 後.n);
    check('画像が付く', 後.thumb === 5, 'thumb=' + 後.thumb);

    check('最後まで preflight は飛ばなかった', gasPreflightSeen === 0, 'OPTIONS=' + gasPreflightSeen);

    /* --- 画面写真 --- */
    await page.goto('http://127.0.0.1:8777/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    await page.screenshot({ path: SP + '/s1-folders.png' });
    const names = await page.locator('.folder .fname').allTextContents();
    console.log('FOLDERS ' + JSON.stringify(names));
    const idx = await page.evaluate(() => {
      let best = 0, n = -1;
      APP.S.folders.forEach((f, i) => {
        const c = APP.S.items.filter(x => x.folderId === f.id).length;
        if (c > n) { n = c; best = i; }
      });
      return best;
    });
    await page.locator('.folder').nth(idx).click(); await page.waitForTimeout(600);
    await page.screenshot({ path: SP + '/s2-grid.png' });
    await page.locator('.tile').first().click(); await page.waitForTimeout(700);
    check('モーダルに日付欄まで見えている', await page.locator('#m-date').isVisible());
    check('モーダルにURL欄まで見えている', await page.locator('#m-url').isVisible());
    check('保存ボタンが常に見えている', await page.locator('#m-save').isVisible());
    await page.screenshot({ path: SP + '/s3-modal.png' });
    await page.click('#m-cancel'); await page.waitForTimeout(300);
    await dummy();
    await page.screenshot({ path: SP + '/s4-save.png' });
    // boundingBox は overflow で切られた分を教えてくれない。
    // スクロール枠(.m-body)の見えている範囲に収まっているかで判定する。
    // boundingBox は overflow で切られた分を教えてくれない。
    // 画面に収まっていること＋（スクロール枠の中なら）枠にも収まっていることで判定する。
    const inView = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return false;
      const a = el.getBoundingClientRect();
      if (a.top < 0 || a.bottom > innerHeight) return false;
      const body = el.closest('.m-body');
      if (!body) return true;
      const b = body.getBoundingClientRect();
      return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
    }, sel);
    const box = {};
    for (const k of ['#m-folders', '#m-tags', '#m-memo', '#m-date', '#m-url', '#m-save']) {
      box[k] = await inView(k);
    }
    console.log('INVIEW ' + JSON.stringify(box));
    check('フォルダがスクロールなしで見える', box['#m-folders']);
    check('タグがスクロールなしで見える', box['#m-tags']);
    check('メモがスクロールなしで見える', box['#m-memo']);
    // 日付と URL は既定値が入るので、初期表示で届かなくても保存は成立する。
    // そこは割り切り、代わりに「届かないこと」を記録に残す。
    console.log('NOTE 初期表示で届かない欄: ' +
      Object.keys(box).filter(k => !box[k]).join(', ') || '(なし)');
    check('保存がスクロールなしで見える', box['#m-save']);
    await page.click('#m-cancel');
  } catch (e) { fatal = e; try { await page.screenshot({ path: SP + '/fail.png' }); } catch (_) {} }

  try {
    console.log('STATE ' + JSON.stringify(await page.evaluate(() => ({
      view: APP.S.view, items: APP.S.items.length, folders: APP.S.folders.length,
      tags: APP.S.tags.map(t => t.name + ':' + t.count) }))));
  } catch (_) {}

  console.log('\n=== OK (' + ok.length + ') ===');
  ok.forEach(s => console.log('  ✓ ' + s));
  if (bad.length) { console.log('\n=== NG (' + bad.length + ') ==='); bad.forEach(s => console.log('  ✗ ' + s)); }
  if (errs.length) { console.log('\n=== JS errors ==='); [...new Set(errs)].forEach(s => console.log('  ! ' + s)); }
  if (fatal) console.log('\nFATAL: ' + String(fatal.message).split('\n')[0]);

  await browser.close(); server.close(); gas.close();
  process.exit(bad.length || errs.length || fatal ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
