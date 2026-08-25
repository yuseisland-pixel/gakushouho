/* verify-probe.mjs — 調査ブックマークレットを模擬フォームに対して実際に走らせる。
 *
 * node tools/verify-probe.mjs
 *
 * 本物のフォームは組織限定で、うっかり送信する危険もあるので、
 * 実測データから組み立てた模擬フォーム（tools/mock-form.mjs）を相手に検証する。
 * これで、依頼者と往復しなくても probe の回帰を防げる。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildMockForm, FIXTURE, SNAPSHOT_FN } from './mock-form.mjs';

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

function runProbeOn(mockHtml, search, opts = {}) {
  let probeSrc = fs.readFileSync(path.join(ROOT, 'src', 'form', 'probe.js'), 'utf8');
  if (opts.mutate) probeSrc = opts.mutate(probeSrc);
  // probe は結果をテキストエリアに出す。それを pre に写して dump-dom で回収する。
  // あわせて、probe 実行の前後で回答状態のスナップショットを取り、
  // 「読み取りのみ」が本当に守られているかを機械的に確かめる。
  const harness = `
<script>
${SNAPSHOT_FN}
${opts.openDropdown ? 'window.GSH_PROBE_OPEN_DROPDOWN = true;' : ''}
window.__before = JSON.stringify(gshSnapshot());
</script>
<script>${probeSrc}</script>
<script>
(function wait(n){
  var ta = document.querySelector('#gsh-probe-overlay textarea');
  if (ta) {
    var pre = document.createElement('pre');
    pre.id = 'probe-out';
    pre.textContent = ta.value;
    document.body.appendChild(pre);
    var snap = document.createElement('pre');
    snap.id = 'probe-state';
    snap.textContent = JSON.stringify({ before: JSON.parse(window.__before), after: gshSnapshot() });
    document.body.appendChild(snap);
    return;
  }
  if (n > 200) {
    var p = document.createElement('pre');
    p.id = 'probe-out';
    p.textContent = '{"エラー":"タイムアウト: 結果が表示されませんでした"}';
    document.body.appendChild(p);
    return;
  }
  setTimeout(function(){ wait(n+1); }, 100);
})(0);
</script>`;
  const page = mockHtml.replace('</body>', harness + '</body>');
  const tmp = path.join(os.tmpdir(), 'gsh-probe-check-' + Date.now() + '.html');
  fs.writeFileSync(tmp, page, 'utf8');
  try {
    // file:// URL にもクエリは付けられる。これで location.search が読めるので、
    // 事前入力URLの組み立て経路まで実際に走らせられる。
    const url = pathToFileURL(tmp).href + (search || '');
    const dom = execFileSync(browser, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--virtual-time-budget=25000', '--dump-dom', url
    ], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 120000 });
    const decode = (s) => s
      // --dump-dom は U+00A0 を &nbsp; として書き出す。選択肢に含まれるので必ず戻す
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    const m = /<pre id="probe-out">([\s\S]*?)<\/pre>/.exec(dom);
    if (!m) return null;
    const result = JSON.parse(decode(m[1]));
    const s = /<pre id="probe-state">([\s\S]*?)<\/pre>/.exec(dom);
    if (s) result.__state = JSON.parse(decode(s[1]));
    return result;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** probe が回答状態を変えていないかを検査する。今回の事故の直接の再発防止。 */
function checkNoSideEffect(label, r) {
  if (!r || !r.__state) { check(`${label}: 回答状態を記録できた`, false); return; }
  const { before, after } = r.__state;
  if (JSON.stringify(before) === JSON.stringify(after)) {
    check(`${label}: 回答状態が1つも変わっていない`, true, `${before.length} 問を照合`);
    return;
  }
  const diffs = before
    .map((b, i) => ({ i, b, a: after[i] }))
    .filter((d) => JSON.stringify(d.b) !== JSON.stringify(d.a));
  check(`${label}: 回答状態が1つも変わっていない`, false,
    diffs.map((d) => `設問${d.i + 1} ${JSON.stringify(d.b)} → ${JSON.stringify(d.a)}`).join(' / '));
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const expected = fixture.設問;

console.log('調査ブックマークレットの検証（模擬フォーム）\n');

/* このプローブは「分岐がすべて開いた状態のフォーム」を読む道具。
 * 実測時も、利用者のフォームは既に回答済みで全17問が見えていた。
 * 構造の検査は noGating（全問表示）に対して行う。
 * 開いた直後の段階表示された状態での挙動は [11] で別に見る。 */

// --- 1. 素の模擬フォーム ---------------------------------------------
console.log('[1] 通常のフォーム（分岐がすべて開いた状態）');
const r1 = runProbeOn(buildMockForm({ noGating: true }));
if (!r1) { console.log('  NG   結果を回収できませんでした'); process.exit(1); }
if (r1.エラー) { console.log('  NG   probe が例外を出しました: ' + r1.エラー); process.exit(1); }

check('設問数が実測と一致', r1.設問数 === expected.length, `${r1.設問数} / ${expected.length}`);
check('版が probe-v3', r1.版 === 'probe-v3', String(r1.版));

const gotQids = (r1.設問 || []).map((q) => q.ids && q.ids.qid);
check('全設問の設問IDを一意に特定できた',
  gotQids.every((v) => typeof v === 'string' && /^r[0-9a-f]{32}$/.test(v)),
  `${gotQids.filter(Boolean).length} / ${expected.length}`);
check('設問IDが実測値と完全一致',
  JSON.stringify(gotQids) === JSON.stringify(expected.map((q) => q.qid)));
check('設問IDに重複がない', new Set(gotQids).size === gotQids.length);

// --- 2. 回答状態を変えていないこと（今回の事故の再発防止・最重要）------
console.log('\n[2] 読み取りのみであること');
checkNoSideEffect('既定動作', r1);
check('出力に「回答を変えていない」の宣言がある',
  typeof r1.回答を変えていないか === 'string' && /OK/.test(r1.回答を変えていないか),
  String(r1.回答を変えていないか).slice(0, 60));

// --- 3. 日付欄をドロップダウンと誤判定しないこと -----------------------
// 本番で日付ピッカーを開いてしまった原因。日付入力は role="combobox" を持つ。
console.log('\n[3] 日付欄の判定');
const dates = (r1.設問 || []).filter((q) => /活動開始日|活動終了日/.test(q.heading));
check('日付設問を2つ検出', dates.length === 2, `${dates.length} 件`);
dates.forEach((d) => {
  const n = d.heading.slice(0, 8);
  check(`${n}: type が date`, d.type === 'date', d.type);
  check(`${n}: ドロップダウン処理が走っていない`, d.dropdown === undefined,
    d.dropdown ? '走ってしまっています' : '');
  check(`${n}: 日付書式を報告している`, /yyyy\/MM\/dd/.test((d.field && d.field.placeholder) || ''),
    (d.field && d.field.placeholder) || 'なし');
});

// --- 4. ドロップダウンは既定で開かない ---------------------------------
console.log('\n[4] ドロップダウン（8.活動主管箇所名）');
const dd = (r1.設問 || []).find((q) => q.type === 'dropdown');
check('ドロップダウンとして検出された', !!dd, dd ? dd.heading.slice(0, 24) : '検出できず');
if (dd) {
  check('既定では開かない', dd.dropdown && dd.dropdown.skipped === true,
    dd.dropdown ? (dd.dropdown.skipped ? '開いていません' : '開いてしまっています') : '');
  check('現在の表示は報告する', dd.dropdown && dd.dropdown.現在の表示 === '選択してください',
    dd.dropdown ? String(dd.dropdown.現在の表示) : '');
}

// オプトインで開いた場合は、読めたうえで必ず元に戻ること
console.log('\n[4b] ドロップダウンを明示的に開いた場合');
const rOpen = runProbeOn(buildMockForm({ noGating: true }), '', { openDropdown: true });
const ddOpen = rOpen && (rOpen.設問 || []).find((q) => q.type === 'dropdown');
check('選択肢を取得できた', !!(ddOpen && ddOpen.dropdown && ddOpen.dropdown.ok),
  ddOpen && ddOpen.dropdown ? (ddOpen.dropdown.reason || `${(ddOpen.dropdown.options || []).length} 件`) : '');
if (ddOpen && ddOpen.dropdown && ddOpen.dropdown.ok) {
  const opts = ddOpen.dropdown.options.map((o) => o.raw);
  // fixture は設問IDで引く。並び順で引くと設問が増えた瞬間に別の設問を指す
  const fxDropdown = expected.find((q) => q.dropdownOptions);
  check(`選択肢が実測データと一致（${fxDropdown.dropdownOptions.length}件）`,
    JSON.stringify(opts) === JSON.stringify(fxDropdown.dropdownOptions), `${opts.length} 件`);
  check('学生生活課の完全な文字列が取れている',
    opts.includes('学生生活課 Student Affairs Section'));
  check('読み取り後に閉じている', ddOpen.dropdown.closedAfter === true);
  check('回答を変えていないと自己判定している', ddOpen.dropdown.回答を変えていない === true,
    ddOpen.dropdown.警告 || '');
}
checkNoSideEffect('明示的に開いた場合', rOpen);

/* [4c] 検査そのものが機能しているかを確かめる。
 * 「閉じてから blur する」という修正を意図的に壊し（Escape の送出を取り除く）、
 * 副作用検査がちゃんと落ちることを見る。ここが素通りするなら、上の OK は無意味。 */
console.log('\n[4c] 副作用検査の自己テスト（わざと壊して落ちることを確認）');
const rBroken = runProbeOn(buildMockForm({ noGating: true }), '', {
  openDropdown: true,
  mutate: (src) => src.replace(
    /target\.dispatchEvent\(new KeyboardEvent\('keydown', \{ key: 'Escape'[\s\S]*?\}\)\);/,
    '/* Escape を送らないように壊す */'
  )
});
const brokenState = rBroken && rBroken.__state;
const brokenChanged = brokenState
  && JSON.stringify(brokenState.before) !== JSON.stringify(brokenState.after);
check('壊した版では回答が変わってしまう（＝検査が本物）', brokenChanged === true,
  brokenChanged ? '検査が変化を捕まえた' : '変化を検出できなかった。検査が形骸化している疑い');
const ddBroken = rBroken && (rBroken.設問 || []).find((q) => q.type === 'dropdown');
check('壊した版では probe 自身も警告を出す',
  !!(ddBroken && ddBroken.dropdown && ddBroken.dropdown.警告),
  ddBroken && ddBroken.dropdown ? (ddBroken.dropdown.警告 || '警告なし').slice(0, 60) : '');

// --- 3. 選択肢の生文字列 ----------------------------------------------
console.log('\n[5] 選択肢の生文字列（事前入力は完全一致が要る）');
const q4 = (r1.設問 || [])[3];
check('加入制度の選択肢を2つ取得', q4 && q4.options && q4.options.length === 2,
  q4 && q4.options ? String(q4.options.length) : 'なし');
if (q4 && q4.options) {
  check('タイポグラフィ引用符が保持されている', /[\u201C\u201D]/.test(q4.options[0].raw));
  check('エスケープ併記がある', /\\u201c/i.test(q4.options[0].escaped), q4.options[0].escaped.slice(0, 50));
}

/* 空白を潰していないこと。
 *
 * 実際にここで長時間はまった。probe が label.replace(/\s+/g,' ') をしていたため、
 * 「1.［U+3000］学傷補のみ加入［半角2つ］Register…」が半角1個に化けて form-map に入り、
 * 事前入力が完全一致せず永久に効かなかった。
 *
 * fixture 自体もその潰れた文字列で作られていたので、模擬フォームと本体が
 * 同じ誤りを共有していて、どれだけ検証しても素通りしていた。
 * だから **検証側から独立した文字列を注入** して確かめる。 */
console.log('\n[5b] 選択肢の空白を潰していないか');
const TRICKY = [
  '1.　学傷補のみ加入  Register only for “A”',   // 全角スペース＋半角2つ
  '2.　学傷補と学賠補　両方に加入　 Register for both'
];
const rWs = runProbeOn(buildMockForm({ noGating: true, choiceOverride: { 3: TRICKY } }), '');
const q4ws = rWs && !rWs.エラー ? (rWs.設問 || [])[3] : null;
check('空白入りの選択肢を取得できた', !!(q4ws && q4ws.options && q4ws.options.length === 2),
  q4ws && q4ws.options ? String(q4ws.options.length) : (rWs && rWs.エラー) || 'なし');
if (q4ws && q4ws.options && q4ws.options.length === 2) {
  const reveal = (s) => String(s).replace(/ /g, '␠').replace(/　/g, '［全角］');
  TRICKY.forEach((want, k) => {
    const got = q4ws.options[k].raw;
    check(`選択肢${k + 1} が1文字も変わらずに取れている`, got === want,
      got === want ? reveal(want) : `期待 ${reveal(want)} / 実際 ${reveal(got)}`);
  });
  check('全角スペースが半角に潰れていない', q4ws.options[0].raw.indexOf('　') !== -1);
  check('連続した半角スペースが1個に潰れていない', /加入 {2}Register/.test(q4ws.options[0].raw));
  check('潰した版も別に持っている（人が読む用）',
    q4ws.options[0].normalized === '1. 学傷補のみ加入 Register only for “A”',
    JSON.stringify(q4ws.options[0].normalized));
}

/* この検査が本物か（＝バグを戻したら落ちるか）を確かめる。
 * 検査を足しても、それが何も見ていなければ意味がない。 */
const rBug = runProbeOn(
  buildMockForm({ noGating: true, choiceOverride: { 3: TRICKY } }), '',
  { mutate: (s) => s.replace('raw.push(got.value);', "raw.push(got.value.replace(/\\s+/g, ' ').trim());") }
);
const q4bug = rBug && !rBug.エラー ? (rBug.設問 || [])[3] : null;
check('バグを戻すと、この検査は落ちる（＝検査が本物）',
  !!(q4bug && q4bug.options && q4bug.options[0].raw !== TRICKY[0]),
  q4bug && q4bug.options ? '潰れた文字列を検出した' : '変異版が走らなかった');

// --- 4. ファイル欄 ----------------------------------------------------
console.log('\n[6] ファイルアップロード欄');
const qf = (r1.設問 || []).find((q) => q.file);
check('ファイル設問を検出', !!qf);
if (qf) {
  check('input[type=file] を検出', qf.file.hasNativeInput === true);
  check('accept を取得', /xlsx/.test(qf.file.accept || ''), qf.file.accept);
  check('multiple を取得', qf.file.multiple === true);
  check('アップロードボタンを検出', !!qf.file.uploadButton);
  // querySelector にセレクタを並べると文書順で最初の一致が返るため、
  // 設問タイトル側のイマーシブリーダーのボタンを掴んでいた
  check('掴んだのがアップロードボタン（イマーシブリーダーではない）',
    !!qf.file.uploadButton && qf.file.uploadButton.automationId === 'fileUploadButton',
    qf.file.uploadButton ? `${qf.file.uploadButton.label} / ${qf.file.uploadButton.automationId}` : '');
}

/* --- 5. 調査ツールが「読むだけ」であること -------------------------------
 *
 * 以前ここには、設問IDの綴り・日付書式・選択肢の書式を総当たりする
 * 「事前入力テスト」があった。すべて決着したので削除した。
 * あの仕掛けは ZZ 値を実際にフォームへ書き込むため、利用者の下書きを汚した
 * （実際、申請者氏名に ZZ対照 が残り、活動の種類まで書き換わっていた）。
 *
 * 消したものが本当に消えているか、そして書き込みが起きないことを見張る。 */
console.log('\n[7] 決着済みの実験が残っていないこと・書き込まないこと');
const probeSource = fs.readFileSync(path.join(ROOT, 'src', 'form', 'probe.js'), 'utf8');
check('事前入力テストの足場が残っていない',
  !/ZZTESTA|ZZTESTB|ZZHASHTEST|buildPrefillTestUrl|GSH_PROBE_STAGE1/.test(probeSource));
check('フォームへ遷移するコードがない（location.href への代入なし）',
  !/location\.href\s*=/.test(probeSource));
check('sessionStorage を使っていない', !/sessionStorage/.test(probeSource));

// クエリ付きで開いても、例外なく完走し、回答状態を1つも変えないこと
const r5 = runProbeOn(buildMockForm({ noGating: true }), '?id=TESTFORMID123');
check('クエリ付きでも例外なく完走する', r5 && !r5.エラー, r5 && r5.エラー ? r5.エラー.split('\n')[0] : '');
checkNoSideEffect('クエリ付き', r5);
check('出力に事前入力テストの項目が残っていない', !!r5 && r5.事前入力テスト === undefined);

// --- 6. ズレの再現テスト ----------------------------------------------
console.log('\n[8] 設問が挿入されてもズレないか（インデックス依存バグの回帰テスト）');
const r2 = runProbeOn(buildMockForm({ insertExtraAt: 8, noGating: true }));
check('設問が1つ増えたことを検出', r2 && r2.設問数 === expected.length + 1, r2 ? String(r2.設問数) : 'なし');
if (r2) {
  const after = r2.設問.map((q) => q.ids && q.ids.qid);
  // 責任者名は挿入後も同じ設問IDのまま。インデックスは 9 → 10 にズレる。
  const respQid = expected[9].qid;
  const idxBefore = gotQids.indexOf(respQid);
  const idxAfter = after.indexOf(respQid);
  check('責任者名のインデックスはズレる（＝インデックス依存は壊れる）',
    idxBefore === 9 && idxAfter === 10, `${idxBefore} → ${idxAfter}`);
  check('責任者名の設問IDは不変（＝ID依存なら壊れない）', after[idxAfter] === respQid, respQid);
}

// --- 7. 設問IDが無いフォーム -------------------------------------------
console.log('\n[9] 設問IDが取れない場合');
const r3 = runProbeOn(buildMockForm({ stripIds: true, noGating: true }));
check('設問自体は走査できる', r3 && r3.設問数 === expected.length, r3 ? String(r3.設問数) : 'なし');
if (r3) {
  check('設問IDは null として報告される',
    r3.設問.every((q) => q.ids && q.ids.qid === null));
  check('見出しは取れている（第2段の材料になる）',
    r3.設問.every((q) => q.heading && q.heading.length > 2));
}

// --- 10. 読み取りブックマークレット --------------------------------------
// 実験の観測を目視でなく機械で取るための道具。読むだけで何も変えてはいけない。
console.log('\n[10] 読み取りブックマークレット');
function runReadback(mockHtml, prefill) {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'form', 'readback.js'), 'utf8');
  // 事前入力を模して、先頭のいくつかの欄にあらかじめ値を入れておく
  const seed = (prefill || []).map(([i, v]) =>
    `(function(){var q=document.querySelectorAll('[data-automation-id="questionItem"]')[${i}];`
    + `var t=q.querySelector('input:not([type=radio]):not([type=checkbox]):not([type=file]),textarea');`
    + `if(t)t.value=${JSON.stringify(v)};})();`).join('\n');
  const harness = `
<script>${SNAPSHOT_FN}${seed}window.__before = JSON.stringify(gshSnapshot());</script>
<script>${src}</script>
<script>
(function wait(n){
  var ta = document.querySelector('#gsh-readback textarea');
  if (ta) {
    var pre = document.createElement('pre'); pre.id = 'rb-out';
    pre.textContent = JSON.stringify({ text: ta.value, before: JSON.parse(window.__before), after: gshSnapshot() });
    document.body.appendChild(pre); return;
  }
  if (n > 200) { var p = document.createElement('pre'); p.id = 'rb-out';
    p.textContent = JSON.stringify({ error: 'タイムアウト' }); document.body.appendChild(p); return; }
  setTimeout(function(){ wait(n+1); }, 100);
})(0);
</script>`;
  const tmp = path.join(os.tmpdir(), 'gsh-rb-' + Date.now() + '.html');
  fs.writeFileSync(tmp, mockHtml.replace('</body>', harness + '</body>'), 'utf8');
  try {
    const dom = execFileSync(browser, ['--headless=new', '--disable-gpu', '--no-sandbox',
      '--virtual-time-budget=20000', '--dump-dom', pathToFileURL(tmp).href],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
    const m = /<pre id="rb-out">([\s\S]*?)<\/pre>/.exec(dom);
    if (!m) return null;
    return JSON.parse(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'));
  } finally { fs.rmSync(tmp, { force: true }); }
}

// 分岐がすべて開いた状態のフォームに対して読む（段階表示された状態は [11] で見る）
const rb = runReadback(buildMockForm({ noGating: true }), [[0, 'ZZ1'], [1, 'ZZ2'], [2, 'ZZ3']]);
if (rb && !rb.error) {
  check('入っている設問を検出する', /1\..*●/.test(rb.text) || /●/.test(rb.text), '● の行あり');
  check('入っている数を数えている', /入っている設問: 3 \//.test(rb.text),
    (/入っている設問: [^\n]*/.exec(rb.text) || [])[0]);
  check('先頭から連続で入っている数を出す', /先頭から連続で入っている数: 3/.test(rb.text),
    (/先頭から連続で入っている数: \d+/.exec(rb.text) || [])[0]);
  check('空の設問は空として出す', /4\..*○/.test(rb.text) || /○/.test(rb.text));
  check(`設問数を報告する（${expected.length} 問）`,
    new RegExp('設問数: ' + expected.length).test(rb.text),
    (/設問数: \d+/.exec(rb.text) || [])[0]);
  // 読むだけ。プローブがドロップダウンを開いて回答を変えた事故の再発防止
  const same = JSON.stringify(rb.before) === JSON.stringify(rb.after);
  check('回答状態を1つも変えていない', same,
    same ? '17問を照合' : '変化してしまっています');
} else {
  check('読み取り結果を回収できた', false, rb ? rb.error : 'なし');
}

// --- 11. 段階表示された状態で走らせた場合 --------------------------------
/* 開いた直後のフォームは 1〜5番しか出ていない。この状態でプローブを走らせると
 * 5問しか採れないのは正しい挙動。ただし**それを黙って17問のように見せてはいけない**。
 * 実測時に17問採れたのは、利用者のフォームが既に回答済みで全部開いていたから。 */
console.log('\n[11] 開いた直後（段階表示された状態）で走らせた場合');
const rGated = runProbeOn(buildMockForm());
if (rGated && !rGated.エラー) {
  check('見えている5問だけを報告する', rGated.設問数 === 5, `${rGated.設問数} 問`);
  check('採れた設問の設問IDは正しい',
    (rGated.設問 || []).every((q) => q.ids && /^r[0-9a-f]{32}$/.test(q.ids.qid || '')));
  check('この状態でも回答を変えない',
    rGated.__state && JSON.stringify(rGated.__state.before) === JSON.stringify(rGated.__state.after));
} else {
  check('段階表示された状態で結果を回収できた', false, rGated ? rGated.エラー : 'なし');
}

console.log(`\n${fail === 0 ? '全て通りました。' : fail + ' 件失敗しました。'}`);
process.exit(fail === 0 ? 0 : 1);
