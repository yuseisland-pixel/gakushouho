/* verify-q4test.mjs — 4番テスト用ブックマークレットを、実際にブラウザで走らせて確かめる。
 *
 * node tools/verify-q4test.mjs
 *
 * ■ なぜこれが要るか
 *   最初に出した版は、ラジオ要素自身の aria-label / textContent しか見ておらず、
 *   本番（ラジオ要素は空で、隣の span に文字がある形）で **何も読み取れなかった**。
 *   出す前に動かしていれば分かった話なので、機械で確かめる。
 *
 *   本番で確認された形は 'sibling'（ラジオ要素が空）。こちらを主に検証する。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMockForm } from './mock-form.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
];
const browser = BROWSERS.find((p) => fs.existsSync(p));
if (!browser) { console.log('Edge / Chrome が見つかりません。検証を飛ばします。'); process.exit(0); }

let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'OK ' : 'NG '}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) fail++;
};

/** 本番の4番と同じ「全角スペース＋二重スペース」入りの選択肢 */
const TRICKY = [
  '1.　学傷補のみ加入  Register only for “Compensation for Injury”',
  '2.　学傷補と学賠補　両方に加入　 Register for both'
];
// q4test.js の reveal() と同じ表記にすること（違うと比較が通らない）
const reveal = (s) => String(s).replace(/ /g, '␠').replace(/　/g, '［全角空白］');

function run(labelMode, extra = {}) {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'form', 'q4test.js'), 'utf8');
  const mock = buildMockForm({
    noGating: true,
    choiceLabelMode: labelMode,
    choiceOverride: { 3: TRICKY },
    ...extra
  });
  // 画面に出たテキストエリアの中身を pre に写して dump-dom で回収する
  const harness = `
<script>${src}</script>
<script>
(function wait(n){
  var ta = document.querySelector('#gsh-q4test textarea');
  var pre = document.createElement('pre');
  pre.id = 'q4-out';
  if (ta) { pre.textContent = ta.value; document.body.appendChild(pre); return; }
  if (n > 100) { pre.textContent = 'TIMEOUT'; document.body.appendChild(pre); return; }
  setTimeout(function(){ wait(n+1); }, 50);
})(0);
</script>`;
  const tmp = path.join(os.tmpdir(), 'gsh-q4test-' + labelMode + '-' + process.pid + '.html');
  fs.writeFileSync(tmp, mock.replace('</body>', harness + '</body>'), 'utf8');
  const dom = execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=6000',
    '--dump-dom', 'file:///' + tmp.replace(/\\/g, '/')
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  fs.unlinkSync(tmp);
  const m = /<pre id="q4-out">([\s\S]*?)<\/pre>/.exec(dom);
  if (!m) return null;
  return m[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

for (const mode of ['sibling', 'aria']) {
  console.log(`\n[${mode}] ラジオのラベルが ${mode === 'sibling' ? '隣の span にある（本番と同じ形）' : 'ラジオ要素自身にある'}`);
  const out = run(mode);
  check('結果が出た', !!out && out !== 'TIMEOUT');
  if (!out || out === 'TIMEOUT') continue;

  check('「文字列が1つも見つかりません」になっていない',
    out.indexOf('文字列が1つも見つかりませんでした') === -1);

  // 採用された文字列（★の行の次行）が、注入した選択肢と1文字も違わないこと。
  // ここが本題。空白が潰れていたら URL も別物になる。
  const adopted = adoptedOf(out);
  check('選択肢2つとも採用された', adopted.length === 2, `${adopted.length} 件`);
  TRICKY.forEach((want, k) => {
    if (adopted[k] == null) { check(`選択肢${k + 1} を採用`, false, '無し'); return; }
    check(`選択肢${k + 1} が1文字も変わらずに採用されている`, adopted[k] === reveal(want),
      adopted[k] === reveal(want) ? adopted[k] : `期待 ${reveal(want)} / 実際 ${adopted[k]}`);
  });

  // テストURLが実際に組み立てられていること（前回はここが %22%22 になっていた）
  const urls = urlsOf(out);
  check('テストURLが4本作られている', urls.length === 4, `${urls.length} 本`);
  urls.forEach((u, k) => {
    check(`URL${k + 1} が空の値になっていない（%22%22 でない）`,
      u.indexOf('=%22%22') === -1 && !/=$/.test(u));
  });
  if (urls.length) {
    check('URLに全角スペースが載っている（%E3%80%80）', urls[0].indexOf('%E3%80%80') !== -1);
    check('URLに連続半角スペースが載っている（%20%20）', urls[0].indexOf('%20%20') !== -1);
  }
}

/** ★ の行の次行（採用された文字列）を取り出す。dump-dom 経由の \r は落とす。 */
function adoptedOf(out) {
  const rows = out.split('\n');
  const adopted = [];
  for (let i = 0; i < rows.length - 1; i++) {
    if (/^\s{2}★ /.test(rows[i])) adopted.push(rows[i + 1].replace(/^ {6}/, '').replace(/\r$/, ''));
  }
  return adopted;
}

function urlsOf(out) {
  return (out.match(/^(?:https?|file):\/\/\S+$/gm) || []).map((u) => u.replace(/\r$/, ''));
}

/* 表示テキストではなく value 属性を採っているか。
 * 事前入力は完全一致が要るので、整形の影響を受ける表示テキストを採ってはいけない。
 * value 属性だけ別文字列にして、そちらが採られることを確かめる。 */
console.log('\n[value 優先] 表示テキストと value 属性が食い違う場合');
{
  const out = run('sibling', { choiceValueMismatch: true });
  check('結果が出た', !!out && out !== 'TIMEOUT');
  if (out && out !== 'TIMEOUT') {
    const adopted = adoptedOf(out);
    check('value 属性の方を採っている（表示テキストではなく）',
      adopted.length === 2 && adopted.every((a) => a.endsWith('＠VALUE')),
      adopted[0] || 'なし');
    check('採用元が value 属性だと明示されている', /★ value 属性/.test(out));
    check('URLにも value 属性の値が載っている',
      urlsOf(out).every((u) => u.indexOf(encodeURIComponent('＠VALUE')) !== -1));
  }
}

/* 「いま選ばれている方」ではなく「選ばれていない方」を本命に出しているか。
 * ここを間違えると、もともとの選択と区別がつかず判定にならない。 */
console.log('\n[判定設計] 本命は「いま選ばれていない方」であること');
{
  const out = run('sibling', { preChecked: { 3: 0 } });   // 1番を選択済みにしておく
  check('結果が出た', !!out && out !== 'TIMEOUT');
  if (out && out !== 'TIMEOUT') {
    check('いまの選択状態を報告している', /1番が選ばれています/.test(out), '1番');
    check('本命として2番を提示している', /判定に使うのは 2番/.test(out));
    const head = out.split('=== テストURL')[1] || '';
    check('先頭のテストURLが2番のもの',
      head.indexOf('【A2】') !== -1 && head.indexOf('【A2】') < (head.indexOf('【A1】') === -1 ? Infinity : head.indexOf('【A1】')));
  }
}

console.log(fail === 0 ? '\n全て通りました。' : `\n${fail} 件失敗しました。`);
process.exit(fail === 0 ? 0 : 1);
