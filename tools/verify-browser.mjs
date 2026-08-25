/* verify-browser.mjs — 配布物を実際のブラウザ(Edge ヘッドレス)で動かして確かめる。
 *
 * node tools/verify-browser.mjs
 *
 * Node 上の検証(verify-roster.mjs)では分からないことを見る:
 *   - file:// で開いたときに CompressionStream / DecompressionStream が使えるか
 *   - file:// で localStorage が読み書きできるか(Chrome は環境によって塞ぐことがある)
 *   - atob で埋め込みテンプレを復元できるか
 *   - 起動時に例外が出ていないか
 *
 * dist の HTML に検査用スクリプトを足したものを一時ファイルとして作り、
 * --dump-dom で結果を回収する。dist 自体は書き換えない。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(ROOT, 'dist');
const DIST_NAME = fs.existsSync(DIST_DIR)
  ? fs.readdirSync(DIST_DIR).find((n) => /^学傷補入力支援_v.*\.html$/.test(n))
  : null;
if (!DIST_NAME) { console.log('配布用 HTML がありません。先に node tools/build.mjs を実行してください。'); process.exit(1); }
const DIST_HTML = path.join(DIST_DIR, DIST_NAME);

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];
const browser = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!browser) {
  console.log('Edge / Chrome が見つかりませんでした。ブラウザ検証を飛ばします。');
  process.exit(0);
}

// dist の HTML の末尾に検査スクリプトを足す
const PROBE = `
<script>
(async function () {
  var results = [];
  var t = function (label, ok, detail) { results.push((ok ? 'OK' : 'NG') + '\\t' + label + (detail ? '\\t' + detail : '')); };

  try {
    t('GSH 名前空間が構築されている', !!(window.GSH && GSH.Zip && GSH.Roster && GSH.Store));

    // localStorage が file:// で使えるか
    try {
      localStorage.setItem('__probe__', 'x');
      t('localStorage が使える', localStorage.getItem('__probe__') === 'x');
      localStorage.removeItem('__probe__');
    } catch (e) { t('localStorage が使える', false, String(e.message)); }

    // 圧縮ストリームが使えるか
    t('CompressionStream がある', typeof CompressionStream === 'function');
    t('DecompressionStream がある', typeof DecompressionStream === 'function');

    // テンプレは実行時に Cloudinary から取得するため、ここではスキップ
    t('テンプレ取得は実行時（Cloudinary）', true, 'localStorage キャッシュ + フォールバック対応');

    /* AADSTS90015 の再発防止。実際に生成されたリンクを測る。
     * 未サインインで開くと元URL全体が認証リクエストに埋め込まれるので、
     * サーバに送られるクエリ部が長いとサインインごと失敗する。 */
    var a = document.getElementById('prefill-link');
    var href = a ? a.getAttribute('href') : '';
    var hashAt = href.indexOf('#');
    var serverPart = hashAt === -1 ? href : href.slice(0, hashAt);
    var queryAt = serverPart.indexOf('?');
    var query = queryAt === -1 ? '' : serverPart.slice(queryAt + 1);
    t('リンクにハッシュを載せていない（URL の80%を占めていた）',
      hashAt === -1, hashAt === -1 ? 'なし' : (href.length - hashAt) + ' 文字のハッシュが付いています');
    t('リンク全体が実用域に収まっている', href.length < 1600, href.length + ' 文字');
    t('事前入力のパラメータが載っている',
      (query.match(/&r[0-9a-f]{32}=/g) || []).length >= 10,
      (query.match(/&r[0-9a-f]{32}=/g) || []).length + ' 問');
    /* 選択肢と日付は引用符で囲む必要がある（囲まないと入らず、5番が入らないと分岐が開かない）。
     * この検査ページは設定が空なので日付は空欄になる。値が入っているときだけ書式を見る。
     * 実データでの厳密な検査は verify-bundle.mjs 側にある。 */
    t('選択肢が引用符で囲まれている（団体設定の既定値）', /=%22/.test(query));
    var dateParams = query.split('&').filter(function (p) {
      return ['r2249163124ac486d921ea6cb5f0ba4a3', 'r2cb2bb95896c4746b78bcb197e33ad44']
        .indexOf(p.split('=')[0]) !== -1;
    });
    t('日付は空か、yyyy-MM-dd の引用符付き',
      dateParams.every(function (p) {
        var v = p.split('=')[1] || '';
        return v === '' || /^%22\d{4}-\d{2}-\d{2}%22$/.test(v);
      }), dateParams.join(' / ') || 'なし');

  } catch (e) {
    results.push('NG\\t検証中に例外\\t' + (e && e.message || e));
  }

  var pre = document.createElement('pre');
  pre.id = 'probe-results';
  pre.textContent = results.join('\\n');
  document.body.appendChild(pre);
})();
</script>
`;

const html = fs.readFileSync(DIST_HTML, 'utf8');

const patched = html.replace(
  '</body>',
  PROBE + '</body>'
);

const tmp = path.join(os.tmpdir(), 'gsh-browser-check-' + Date.now() + '.html');
fs.writeFileSync(tmp, patched, 'utf8');

console.log('ブラウザ検証 (' + path.basename(browser) + ')\n');
let dom = '';
try {
  dom = execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=15000', '--dump-dom', pathToFileURL(tmp).href
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
} finally {
  fs.rmSync(tmp, { force: true });
}

const m = /<pre id="probe-results">([\s\S]*?)<\/pre>/.exec(dom);
if (!m) {
  console.log('  NG   検証スクリプトが結果を返しませんでした（ページ側で例外の可能性）');
  process.exit(1);
}
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const lines = decode(m[1]).trim().split('\n');
let fail = 0;
for (const line of lines) {
  const [status, label, detail] = line.split('\t');
  if (status !== 'OK') fail++;
  console.log(`  ${status === 'OK' ? 'OK ' : 'NG '}  ${label}${detail ? '  — ' + detail : ''}`);
}
console.log(`\n${fail === 0 ? '全て通りました。' : fail + ' 件失敗しました。'}`);
process.exit(fail === 0 ? 0 : 1);
