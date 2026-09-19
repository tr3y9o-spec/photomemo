/* 香りの写真を集める道具（開発時だけ使う。アプリからは読まれない）
 *
 * 方針（仕様書 §15.5）:
 *   - CC0 / パブリックドメイン の写真だけを取る。ほかのライセンスは捨てる
 *   - 出典・作者・ライセンス・元ページを必ず控え、app/aroma/出典.md に残す
 *   - 見つからない語は写真なし（アプリ側で文字のタイルになる）
 *
 * 縮小は入っている Chrome（Playwright）にやらせる。画像ライブラリを足さない。
 *
 * 使い方:
 *   node tools/香りの写真.js 探す      候補を集めて scratch/aroma へ落とす
 *   node tools/香りの写真.js 並べる    候補一覧の画像を作る（人が選ぶため）
 *   node tools/香りの写真.js 作る      選んだものを app/aroma へ書き出す
 */
'use strict';
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const OUT = process.env.AROMA_WORK || path.join(__dirname, '..', '.aroma-work');
const APP = path.join(__dirname, '..', 'app', 'aroma');
const UA = 'photomemo-dev/1.0 (personal photo memo app)';

/* 香りの語 → 探す言葉。語そのものは一般語彙で、どのシートの一覧も写していない。 */
const 語 = [
  ['レモン', 'lemon', 'fresh lemon fruit'],
  ['りんご', 'apple', 'fresh red apple fruit'],
  ['洋梨', 'pear', 'fresh pear fruit'],
  ['白桃', 'peach', 'fresh peach fruit'],
  ['パイナップル', 'pineapple', 'pineapple fruit'],
  ['ライチ', 'lychee', 'lychee fruit'],
  ['いちご', 'strawberry', 'fresh strawberries'],
  ['ラズベリー', 'raspberry', 'fresh raspberries'],
  ['カシス', 'blackcurrant', 'blackcurrant berries'],
  ['ブルーベリー', 'blueberry', 'fresh blueberries'],
  ['プラム', 'plum', 'fresh plums fruit'],
  ['いちじく', 'fig', 'fresh figs fruit'],
  ['白い花', 'blossom', 'white blossom flowers'],
  ['すみれ', 'violet', 'violet flowers'],
  ['バラ', 'rose', 'rose flower'],
  ['ミント', 'mint', 'fresh mint leaves'],
  ['ピーマン', 'bellpepper', 'green bell pepper'],
  ['干し草', 'hay', 'dry hay bale'],
  ['黒こしょう', 'blackpepper', 'black peppercorns'],
  ['シナモン', 'cinnamon', 'cinnamon sticks'],
  ['丁子', 'clove', 'clove spice'],
  ['バニラ', 'vanilla', 'vanilla beans'],
  ['バター', 'butter', 'butter block'],
  ['パン', 'bread', 'bread loaf'],
  ['ヨーグルト', 'yogurt', 'yogurt bowl'],
  ['ナッツ', 'nuts', 'mixed nuts'],
  ['カラメル', 'caramel', 'caramel sauce'],
  ['はちみつ', 'honey', 'honey jar'],
  ['コーヒー', 'coffee', 'roasted coffee beans'],
  ['チョコレート', 'chocolate', 'dark chocolate'],
  ['樽', 'oak', 'oak wine barrel'],
  ['煙', 'smoke', 'smoke'],
  ['杉', 'cedar', 'cedar wood'],
  ['紅茶', 'tea', 'black tea leaves'],
  ['きのこ', 'mushroom', 'mushrooms'],
  ['腐葉土', 'forestfloor', 'forest floor leaves soil'],
  ['濡れた石', 'wetstone', 'wet stones'],
  ['鉄', 'iron', 'rusty iron metal'],
  ['革', 'leather', 'leather texture']
];

/* 1回目で的外れだった語を、言い方を変えて引き直すための表。
   候補の番号は 10 番台にして、1回目のものと混ざらないようにする。 */
const 言い直し = [
  ['レモン', 'lemon', 'lemons yellow citrus fruit'],
  ['洋梨', 'pear', 'pears on wooden table'],
  ['プラム', 'plum', 'ripe plums purple fruit'],
  ['ミント', 'mint', 'peppermint herb leaves'],
  ['干し草', 'hay', 'hay field straw dried grass'],
  ['丁子', 'clove', 'dried cloves spice heap'],
  ['バター', 'butter', 'butter on dish dairy']
];

/* 題に入っていたら避ける言葉（病気・虫・死骸などを掴まないように） */
const 避ける = /disease|pest|spot|rot|mold|mould|damage|dead|larva|insect|fungus|blight|sick|injur/i;

const 眠る = (ms) => new Promise(r => setTimeout(r, ms));

async function 探す(やり直し) {
  fs.mkdirSync(path.join(OUT, 'cand'), { recursive: true });
  const 元 = path.join(OUT, 'candidates.json');
  const 表 = (やり直し && fs.existsSync(元)) ? JSON.parse(fs.readFileSync(元, 'utf-8')) : {};
  const ずらし = やり直し ? 10 : 0;
  for (const [jp, slug, q] of (やり直し ? 言い直し : 語)) {
    const u = 'https://api.openverse.org/v1/images/?q=' + encodeURIComponent(q) +
      '&license=cc0,pdm&page_size=12&mature=false';
    let d;
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA } });
      if (!r.ok) { console.log('× ' + jp + ' HTTP ' + r.status); await 眠る(3500); continue; }
      d = await r.json();
    } catch (e) { console.log('× ' + jp + ' ' + e.message); await 眠る(3500); continue; }

    const 候補 = (d.results || [])
      .filter(r => ['cc0', 'pdm'].includes(String(r.license).toLowerCase()))
      .filter(r => !避ける.test(r.title || ''))
      .slice(0, 3);

    if (!やり直し) 表[jp] = [];
    for (let i = 0; i < 候補.length; i++) {
      const r = 候補[i];
      const 番 = i + ずらし;
      const f = path.join(OUT, 'cand', slug + '-' + 番 + '.img');
      try {
        const res = await fetch(r.url, { headers: { 'User-Agent': UA } });
        if (!res.ok) continue;
        fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
      } catch (e) { continue; }
      表[jp].push({
        slug, 番号: 番, file: f, title: r.title || '', creator: r.creator || '',
        license: r.license, license_version: r.license_version,
        source: r.source, foreign_landing_url: r.foreign_landing_url, url: r.url
      });
    }
    console.log((表[jp].length ? '○ ' : '× ') + jp + ' (' + 表[jp].length + '件)');
    if (やり直し) 表[jp] = 表[jp].slice();
    await 眠る(3500);   // 20回/分 の制限に触れない
  }
  fs.writeFileSync(path.join(OUT, 'candidates.json'), JSON.stringify(表, null, 1));
}

/** 候補を一覧の画像にする（人が見て選ぶため） */
async function 並べる() {
  const 表 = JSON.parse(fs.readFileSync(path.join(OUT, 'candidates.json'), 'utf-8'));
  const 全 = Object.entries(表);
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const p = await (await b.newContext({ deviceScaleFactor: 1 })).newPage();
  const 束 = 8;
  for (let s = 0; s * 束 < 全.length; s++) {
    const 部分 = 全.slice(s * 束, s * 束 + 束);
    const html = '<html><head><meta charset="utf-8"><style>' +
      'body{font:13px system-ui;background:#fff;margin:0;padding:8px}' +
      '.r{display:flex;align-items:center;gap:6px;margin-bottom:6px}' +
      '.n{width:86px;font-weight:700}.c{text-align:center;color:#666;font-size:11px}' +
      'img{width:120px;height:120px;object-fit:cover;border:1px solid #ccc;display:block}' +
      '</style></head><body>' +
      部分.map(([jp, list]) => '<div class="r"><div class="n">' + jp + '</div>' +
        list.map(c => '<div class="c"><img src="file://' + c.file.replace(/\\/g, '/') + '">' +
          c.番号 + '</div>').join('') + '</div>').join('') +
      '</body></html>';
    const f = path.join(OUT, 'sheet-' + s + '.html');
    fs.writeFileSync(f, html);
    await p.goto('file://' + f.replace(/\\/g, '/'));
    await p.waitForTimeout(500);
    await p.screenshot({ path: path.join(OUT, 'sheet-' + s + '.png'), fullPage: true });
    console.log('sheet-' + s + '.png');
  }
  await b.close();
}

/** 選んだ候補を 160px の webp にして app/aroma へ置く */
async function 作る() {
  const 表 = JSON.parse(fs.readFileSync(path.join(OUT, 'candidates.json'), 'utf-8'));
  const 選び = JSON.parse(fs.readFileSync(path.join(OUT, 'choices.json'), 'utf-8'));
  fs.mkdirSync(APP, { recursive: true });
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const p = await (await b.newContext({})).newPage();
  const 出典 = [];
  for (const [jp, list] of Object.entries(表)) {
    const n = 選び[jp];
    if (n === undefined || n === null || n < 0) { console.log('－ ' + jp + '（写真なし）'); continue; }
    const c = list.find(x => x.番号 === n);
    if (!c) { console.log('× ' + jp + ' 候補' + n + ' が無い'); continue; }
    const data = 'data:image/*;base64,' + fs.readFileSync(c.file).toString('base64');
    const webp = await p.evaluate(async (src) => {
      const im = new Image();
      im.src = src;
      await im.decode();
      const S = 160, cv = document.createElement('canvas');
      cv.width = S; cv.height = S;
      const g = cv.getContext('2d');
      const 辺 = Math.min(im.naturalWidth, im.naturalHeight);
      g.drawImage(im, (im.naturalWidth - 辺) / 2, (im.naturalHeight - 辺) / 2, 辺, 辺, 0, 0, S, S);
      return cv.toDataURL('image/webp', 0.82);
    }, data);
    const buf = Buffer.from(webp.split(',')[1], 'base64');
    fs.writeFileSync(path.join(APP, c.slug + '.webp'), buf);
    出典.push({ jp, slug: c.slug, ...c, bytes: buf.length });
    console.log('○ ' + jp + ' → ' + c.slug + '.webp (' + Math.round(buf.length / 1024) + 'KB)');
  }
  await b.close();

  const md = ['# 香りの写真の出典', '',
    '`app/aroma/*.webp` は、Openverse 経由で集めた **CC0 / パブリックドメイン** の写真を、',
    '160×160 に切り詰めて webp にしたもの。元の作者と出どころをここに残す。', '',
    '写真が無い語は、アプリでは文字だけのタイルになる。', '',
    '| 語 | ファイル | 題 | 作者 | ライセンス | 出どころ |',
    '|---|---|---|---|---|---|',
    ...出典.map(o => '| ' + o.jp + ' | `' + o.slug + '.webp` | ' + (o.title || '—').replace(/\|/g, '/') +
      ' | ' + (o.creator || '—').replace(/\|/g, '/') + ' | ' + o.license.toUpperCase() +
      ' ' + (o.license_version || '') + ' | [' + o.source + '](' + o.foreign_landing_url + ') |'),
    '', '取得: ' + new Date().toISOString().slice(0, 10) + '（`tools/香りの写真.js`）', ''
  ].join('\n');
  fs.writeFileSync(path.join(APP, '出典.md'), md);
  console.log('出典.md を書いた（' + 出典.length + '件）');
}

const 何 = process.argv[2];
(何 === '探す' ? 探す(process.argv[3] === '再') : 何 === '並べる' ? 並べる() : 何 === '作る' ? 作る() :
  Promise.reject(new Error('探す / 並べる / 作る のどれかを指定する')))
  .catch(e => { console.error('FATAL ' + e.message); process.exit(1); });
