/* verify-mock.mjs — 模擬フォームが実物の段階表示を再現できているかを確かめる。
 *
 * node tools/verify-mock.mjs
 *
 * ここを疎かにしたせいで「模擬で15/15通った」という無意味な検証をしていた。
 * 実物（利用者の実測）は「開いた直後は先頭数問だけ、分岐設問に答えると次が出る」という段階表示。
 * 模擬がこれを再現できていなければ、その先の検証はすべて無意味。
 *
 * 段階の定義（どの設問が何を開くか）は fixture の 段階表示 から読む。
 * ここに番号を書き写すと、設問が増減したときに黙って食い違う
 * （実際、6番が増えたときに 4番/7番 と書き写していた番号が古くなった）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildMockForm, FIXTURE } from './mock-form.mjs';

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

/* 段階の定義は fixture が正本。ゲートになる設問の番号も期待する設問数もここから導く。 */
const FIXTURE_JSON = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const STAGES = FIXTURE_JSON.段階表示 || [];
if (STAGES.length < 3) {
  console.log('fixture に段階表示の定義がありません。検証を飛ばします。');
  process.exit(0);
}
const GATE1 = STAGES[1].unlockedBy;                       // これに答えると次の段が出る
const GATE2 = STAGES[2].unlockedBy;
const COUNT0 = STAGES[0].reveals.length;                  // 開いた直後
const COUNT1 = COUNT0 + STAGES[1].reveals.length;         // 第1段のあと
const COUNT2 = FIXTURE_JSON.設問.length;                   // 全部

const HARNESS = `
<script>
(function () {
  var steps = [];
  function count() { return document.querySelectorAll('[data-automation-id="questionItem"]').length; }
  function q(i) { return document.querySelectorAll('[data-automation-id="questionItem"]')[i]; }
  function done(err) {
    var pre = document.createElement('pre');
    pre.id = 'mock-out';
    pre.textContent = JSON.stringify({ steps: steps, error: err || null });
    document.body.appendChild(pre);
  }
  try {
    steps.push({ at: '初期', count: count() });

    // 第1のゲート（ラジオ）に回答
    var r = q(${GATE1}) && q(${GATE1}).querySelector('[role="radio"]');
    if (!r) { steps.push({ at: 'ゲート1のラジオが見つからない', count: count() }); return done('no radio at ${GATE1}'); }
    r.click();

    setTimeout(function () {
      try {
        steps.push({ at: 'ゲート1に回答後', count: count() });

        // 第2のゲート（ドロップダウン）に回答
        var t = q(${GATE2}) && q(${GATE2}).querySelector('[aria-haspopup="listbox"]');
        if (!t) { steps.push({ at: 'ゲート2のドロップダウンが見つからない', count: count() }); return done('no dropdown at ${GATE2}'); }
        t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

        setTimeout(function () {
          try {
            var opts = document.querySelectorAll('[role="option"]');
            steps.push({ at: 'ドロップダウンを開いた', options: opts.length, count: count() });
            if (!opts.length) return done('no options');
            opts[opts.length - 1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            setTimeout(function () {
              steps.push({ at: 'ゲート2に回答後', count: count() });
              done(null);
            }, 400);
          } catch (e) { done(String(e && e.message || e)); }
        }, 400);
      } catch (e) { done(String(e && e.message || e)); }
    }, 400);
  } catch (e) { done(String(e && e.message || e)); }
})();
</script>`;

function run(html) {
  const tmp = path.join(os.tmpdir(), 'gsh-mock-' + Date.now() + '.html');
  fs.writeFileSync(tmp, html.replace('</body>', HARNESS + '</body>'), 'utf8');
  try {
    const dom = execFileSync(browser, ['--headless=new', '--disable-gpu', '--no-sandbox',
      '--virtual-time-budget=20000', '--dump-dom', pathToFileURL(tmp).href],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
    const m = /<pre id="mock-out">([\s\S]*?)<\/pre>/.exec(dom);
    if (!m) return null;
    return JSON.parse(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  } finally { fs.rmSync(tmp, { force: true }); }
}

console.log('模擬フォームが実物の段階表示を再現しているか\n');

console.log('[1] 段階表示あり（既定）');
const r = run(buildMockForm());
if (!r) { console.log('  NG   結果を回収できませんでした'); process.exit(1); }
if (r.error) console.log('  （途中で問題: ' + r.error + '）');
r.steps.forEach((s) => console.log(`       ${s.at}: ${s.count} 問${s.options != null ? ' / 選択肢 ' + s.options : ''}`));

const at = (name) => (r.steps.find((s) => s.at === name) || {}).count;
check(`開いた直後は先頭 ${COUNT0} 問だけ`, at('初期') === COUNT0, `${at('初期')} 問`);
check(`${GATE1 + 1}番に回答すると ${COUNT1} 問になる`, at('ゲート1に回答後') === COUNT1,
  `${at('ゲート1に回答後')} 問`);
check(`${GATE2 + 1}番に回答すると全 ${COUNT2} 問`, at('ゲート2に回答後') === COUNT2,
  `${at('ゲート2に回答後')} 問`);

console.log('\n[2] 段階表示なし（noGating。旧模擬の再現）');
const r2 = run(buildMockForm({ noGating: true }));
check(`最初から ${COUNT2} 問すべて出る`, r2 && r2.steps[0].count === COUNT2,
  r2 ? `${r2.steps[0].count} 問` : 'なし');

console.log(`\n${fail === 0 ? '全て通りました。' : fail + ' 件失敗しました。'}`);
process.exit(fail === 0 ? 0 : 1);
