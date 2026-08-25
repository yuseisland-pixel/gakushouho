/* verify-lint.mjs — 構文チェックでは見つからない書き間違いを探す。
 *
 * node tools/verify-lint.mjs
 *
 * きっかけ: `var備考 = ...` と書いてしまい、`var備考` 全体が1つの識別子として
 * 解釈された。構文としては正しいので構文チェックを通ってしまい、strict mode の
 * 実行時に「未宣言変数への代入」で初めて落ちた。
 * 日本語の識別子を使うとキーワードとの境目が目で見えないので、機械的に潰す。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', 'tmp', '.git']);

function collect(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const KEYWORDS = ['var', 'let', 'const', 'function', 'return', 'typeof', 'new',
  'delete', 'void', 'instanceof', 'else', 'await', 'yield', 'case'];

// \b は「単語文字と非単語文字の境目」なので、キーワードの直後が非ASCII だと
// 期待どおりに働かない（これで最初の走査は取りこぼした）。前後の境界を明示する。
const GLUED = new RegExp(
  '(?:^|[^A-Za-z0-9_$])(' + KEYWORDS.join('|') + ')([^\\x00-\\x7F])', 'g'
);

/** コメントを落とす。バグの説明としてコメントに書いた例まで拾ってしまうため。
 *  URL の // は残す。厳密なパースはしないが、この用途には十分。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))   // 行番号を保つ
    .split('\n')
    .map((line) => {
      const at = line.search(/(^|[^:])\/\//);
      if (at === -1) return line;
      const cut = line.indexOf('//', at);
      return line.slice(0, cut);
    })
    .join('\n');
}

let fail = 0;
const files = collect(ROOT).filter((f) => path.relative(ROOT, f) !== path.join('tools', 'verify-lint.mjs'));
console.log(`書き間違いの走査（${files.length} ファイル）\n`);

for (const f of files) {
  const rel = path.relative(ROOT, f);
  const lines = stripComments(fs.readFileSync(f, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    GLUED.lastIndex = 0;
    let m;
    while ((m = GLUED.exec(line))) {
      fail++;
      console.log(`  NG   ${rel}:${i + 1}  「${m[1]}${m[2]}」— ${m[1]} の直後にスペースがありません`);
      console.log(`         ${line.trim()}`);
    }
  });
}

if (fail === 0) console.log('  OK   キーワードと識別子がくっついた箇所はありません');

// 走査そのものが機能しているかを確かめる（スキャナが壊れていたら気付けないため）
const CANARY = "    var備考 = findIdx('備考');";
GLUED.lastIndex = 0;
const canaryCaught = GLUED.test(CANARY);
console.log(`  ${canaryCaught ? 'OK ' : 'NG '}  走査スクリプト自体の自己テスト（既知の書き間違いを検出できるか）`);
if (!canaryCaught) fail++;

console.log(`\n${fail === 0 ? '全て通りました。' : fail + ' 件失敗しました。'}`);
process.exit(fail === 0 ? 0 : 1);
