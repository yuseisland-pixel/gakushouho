/* verify-filler.mjs — フォーム記入エンジンを模擬フォームに対して実走させる。
 *
 * node tools/verify-filler.mjs
 *
 * 本番フォームは組織限定なうえ、うっかり送信する危険もある。実測データから
 * 組み立てた模擬フォーム（tools/mock-form.mjs）を相手に、17問すべてが
 * 意図した欄に入るかを機械的に確かめる。
 *
 * 中心にあるのは「今回のバグの回帰テスト」:
 *   大学が設問を1つ挿入したせいで、旧版は責任者名を別の欄に書き込み、
 *   国内/海外を選ばず、しかも誰も気付かなかった。設問IDで特定すれば
 *   同じ改変が起きても正しく当たることを、挿入済みの DOM で確認する。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildMockForm, SNAPSHOT_FN } from './mock-form.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'form', 'form-map.json'), 'utf8'));
const FORM_MAP = MAP;   // 同じもの。名前だけ使い分けている

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

/** form-map.json の選択肢を設問IDと番号で引く。書き写さないため。
 * 並び順（order）で引くと、設問が1つ増えた瞬間に別の設問を指す。 */
function choiceOf(qid, index) {
  const q = FORM_MAP.questions.find((x) => x.qid === qid);
  const v = q && q.choices && q.choices[index];
  if (!v) throw new Error(`form-map に ${qid} の選択肢 ${index} がありません`);
  return v;
}

// テスト用の入力値。form-map の source 表記に合わせる
const VALUES = {
  personal: {
    氏名: 'テスト 太郎',
    大学メール: 'test@waseda.jp',
    連絡先メール: 'test@ruri.waseda.jp'
  },
  org: {
    活動名: 'テスト同好会での活動',
    責任者名: 'テスト 責任者',
    /* 選択肢は form-map.json から採る。ここに書き写すと、
     * 正しい文字列に直したときに古い写しが残って検証が空回りする
     * （実際、全角スペースを潰していた頃はそれで素通りしていた）。
     * 文字列そのものの正しさは verify-choices.mjs が見張る。 */
    加入区分: choiceOf('ra7268c22275a48a0b642fb9044c7026c', 0),
    活動区分: choiceOf('r08ba9ed20b864472902fbf3d3daf9795', 6),   // 7.その他（授業ではない）
    全員科目登録者: choiceOf('r85ffd7ec7cc44039b23c0c3cf1ab31b4', 0),
    申請先: '学生生活課 Student Affairs Section',
    申請先その他: '',
    既定の国内外: '1.国内 Domestic'
  },
  draft: {
    活動内容: 'フィールドワーク（採集・観察）',
    活動場所: '○○県○○市 ○○川河川敷',
    活動開始日: '2026-09-01',
    活動終了日: '2026-09-03',
    備考: ''
  },
  derived: { 参加学生数: '7' }
};

/** ブックマークレットに渡す payload を base64url にする（bookmarklet-gen と同じ形式） */
function encodePayload(map, values) {
  return Buffer.from(JSON.stringify({ v: 1, map, values }), 'utf8').toString('base64url');
}

/**
 * @param delivery 'direct'（window 経由）/ 'hash'（#gsh=…）/ 'none'（何も渡さない）
 */
function runFiller(mockHtml, { values = VALUES, map = MAP, delivery = 'direct' } = {}) {
  // mockHtml は呼び出し側が buildMockForm(...) で作る（段階表示の遅延なども指定できる）
  const fillerSrc = fs.readFileSync(path.join(ROOT, 'src', 'form', 'filler.js'), 'utf8');
  const inject = delivery === 'direct'
    ? `window.__GSH_PAYLOAD__ = ${JSON.stringify({ map, values })};`
    : delivery === 'hash'
      ? `history.replaceState(null, '', location.pathname + location.search + '#gsh=' + ${JSON.stringify(encodePayload(map, values))});`
      : '';
  const harness = `
<script>
${SNAPSHOT_FN}
${inject}
window.__before = JSON.stringify(gshSnapshot());
</script>
<script>${fillerSrc}</script>
<script>
(function wait(n){
  var banner = document.getElementById('gsh-filler-banner');
  if (banner) {
    var rows = [];
    banner.querySelectorAll('tr').forEach(function (tr) {
      var td = tr.querySelectorAll('td');
      rows.push({ mark: td[0].textContent, label: td[1].textContent, detail: td[2].textContent });
    });
    var pre = document.createElement('pre');
    pre.id = 'filler-out';
    pre.textContent = JSON.stringify({
      rows: rows,
      bannerText: banner.textContent,
      state: gshSnapshot(),
      before: JSON.parse(window.__before),
      hashAtEnd: location.hash
    });
    document.body.appendChild(pre);
    return;
  }
  if (n > 400) {
    var p = document.createElement('pre');
    p.id = 'filler-out';
    p.textContent = JSON.stringify({ error: 'タイムアウト: 結果バナーが出ませんでした' });
    document.body.appendChild(p);
    return;
  }
  setTimeout(function(){ wait(n+1); }, 100);
})(0);
</script>`;
  const page = mockHtml.replace('</body>', harness + '</body>');
  const tmp = path.join(os.tmpdir(), 'gsh-filler-check-' + Date.now() + '.html');
  fs.writeFileSync(tmp, page, 'utf8');
  try {
    const dom = execFileSync(browser, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--virtual-time-budget=40000', '--dump-dom', pathToFileURL(tmp).href
    ], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 180000 });
    const m = /<pre id="filler-out">([\s\S]*?)<\/pre>/.exec(dom);
    if (!m) return null;
    const decoded = m[1]
      // --dump-dom は U+00A0 を &nbsp; として書き出す。選択肢に含まれるので必ず戻す
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    return JSON.parse(decoded);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** 模擬フォームの回答状態から、設問の並び順で値を取り出す */
/* 状態の並びは「フォームに出ている設問の順」。番号を書き写すと、設問が1つ
 * 増えただけで全部が1つずれる（6番が増えたときに実際そうなった）。
 * だから設問IDから並び順を引く。form-map が正本。 */
const at = (state, order) => state[order] || {};
/** ラベルで引く。表示番号にも並び順にも依存しない。 */
const byLabel = (state, label) => {
  const q = FORM_MAP.questions.find((x) => x.label === label);
  if (!q) throw new Error('form-map にラベルがありません: ' + label);
  return state[q.order] || {};
};

console.log('フォーム記入エンジンの検証（模擬フォーム）\n');

// ---- 1. 通常のフォーム -------------------------------------------------
console.log('[1] 17問すべてが意図した欄に入るか');
const r1 = runFiller(buildMockForm());
if (!r1) { console.log('  NG   結果を回収できませんでした'); process.exit(1); }
if (r1.error) { console.log('  NG   ' + r1.error); process.exit(1); }

const S = r1.state;
check('申請者氏名', byLabel(S, '申請者氏名').value === VALUES.personal.氏名, byLabel(S, '申請者氏名').value);
check('申請者メールアドレス', byLabel(S, '申請者メールアドレス').value === VALUES.personal.大学メール, byLabel(S, '申請者メールアドレス').value);
check('共有用メールアドレス', byLabel(S, '共有用メールアドレス').value === VALUES.personal.連絡先メール, byLabel(S, '共有用メールアドレス').value);
check('加入を希望する補償制度（引用符と全角空白を含む長い選択肢）', byLabel(S, '加入を希望する補償制度').checked === VALUES.org.加入区分, byLabel(S, '加入を希望する補償制度').checked);
check('活動の種類（区切りが NBSP の選択肢）', byLabel(S, '活動の種類').checked === VALUES.org.活動区分, byLabel(S, '活動の種類').checked);
check('科目名/行事名/活動名', byLabel(S, '科目名/行事名/活動名').value === VALUES.org.活動名, byLabel(S, '科目名/行事名/活動名').value);
check('活動内容（新規に自動化）', byLabel(S, '活動内容').value === VALUES.draft.活動内容, byLabel(S, '活動内容').value);
check('活動主管箇所名（36択ドロップダウン）', byLabel(S, '活動主管箇所名').dropdown === VALUES.org.申請先, byLabel(S, '活動主管箇所名').dropdown);
check('責任者名（旧版で空だった欄）', byLabel(S, '責任者名').value === VALUES.org.責任者名, byLabel(S, '責任者名').value);
check('活動開始日（yyyy/MM/dd）', byLabel(S, '活動開始日').value === '2026/09/01', byLabel(S, '活動開始日').value);
check('活動終了日（yyyy/MM/dd）', byLabel(S, '活動終了日').value === '2026/09/03', byLabel(S, '活動終了日').value);
check('参加学生数（メンバー数から自動）', byLabel(S, '参加学生数').value === '7', byLabel(S, '参加学生数').value);
check('活動場所（国内/海外）（旧版で未選択だった欄）', byLabel(S, '活動場所（国内/海外）').checked === VALUES.org.既定の国内外, byLabel(S, '活動場所（国内/海外）').checked);
check('活動場所（国内/海外の欄と紛らわしい）', byLabel(S, '活動場所').value === VALUES.draft.活動場所, byLabel(S, '活動場所').value);
check('備考（既定は空のまま）', !byLabel(S, '備考').value, byLabel(S, '備考').value || '(空)');

// ---- 2. 条件付き設問 ---------------------------------------------------
console.log('\n[2] 条件付き設問（箇所名 / 全員科目登録者か）');
check('申請先が「その他」でないので空のまま', !byLabel(S, '【その他の場合のみ】箇所名').value, byLabel(S, '【その他の場合のみ】箇所名').value || '(空)');
// 「箇所名」だと 8.活動主管箇所名 にも当たってしまうので完全一致で引く
// （まさにこのツールが避けようとしている取り違えを、テスト側でやってしまった）
const row9 = r1.rows.find((r) => r.label === '【その他の場合のみ】箇所名');
check('スキップした理由を報告している', !!row9 && /条件/.test(row9.detail), row9 ? row9.detail : 'なし');

// 「その他」を選んだ場合は埋まる
const otherValues = JSON.parse(JSON.stringify(VALUES));
otherValues.org.申請先 = 'その他 Other';
otherValues.org.申請先その他 = 'テスト箇所名';
const rOther = runFiller(buildMockForm(), { values: otherValues });
check('申請先が「その他」なら活動主管箇所名が「その他 Other」になる',
  rOther && byLabel(rOther.state, '活動主管箇所名').dropdown === 'その他 Other',
  rOther ? byLabel(rOther.state, '活動主管箇所名').dropdown : '');
check('申請先が「その他」なら箇所名の欄が埋まる',
  rOther && byLabel(rOther.state, '【その他の場合のみ】箇所名').value === 'テスト箇所名',
  rOther ? byLabel(rOther.state, '【その他の場合のみ】箇所名').value : '');

/* 「全員科目登録者か」は、活動の種類が 1.授業 のときだけフォームに現れる。
 * 授業でないのに勝手に選ぶと、誤った申請になる。両方向を確かめる。 */
const ALLREG = '【授業の場合のみ】全員科目登録者か';
check('授業でないので全員科目登録者は選ばれない',
  !byLabel(S, ALLREG).checked, byLabel(S, ALLREG).checked || '(未選択)');
const rowAllreg = r1.rows.find((r) => r.label === ALLREG);
check('スキップした理由を報告している（全員科目登録者）',
  !!rowAllreg && /条件/.test(rowAllreg.detail), rowAllreg ? rowAllreg.detail : 'なし');

const classValues = JSON.parse(JSON.stringify(VALUES));
classValues.org.活動区分 = choiceOf('r08ba9ed20b864472902fbf3d3daf9795', 0);   // 1.授業
const rClass = runFiller(buildMockForm(), { values: classValues });
check('活動の種類が 1.授業 なら全員科目登録者が選ばれる',
  rClass && byLabel(rClass.state, ALLREG).checked === VALUES.org.全員科目登録者,
  rClass ? byLabel(rClass.state, ALLREG).checked : '');

// ---- 3. ファイル欄は触らない -------------------------------------------
console.log('\n[3] 参加者名簿（ファイル欄）');
check('添付していない（手作業のまま）', byLabel(S, '参加者名簿').files === 0 || byLabel(S, '参加者名簿').files == null, String(byLabel(S, '参加者名簿').files));
check('バナーで手作業だと案内している', /添付.*手で|手で行って/.test(r1.bannerText));

// ---- 4. ズレの回帰テスト（今回のバグそのもの）---------------------------
console.log('\n[4] 設問が1つ挿入されてもズレないか');
const rIns = runFiller(buildMockForm({ insertExtraAt: 8 }));
if (rIns && !rIns.error) {
  const T = rIns.state;
  /* 設問を1つ挿入したので、挿入位置より後ろは DOM 上で1つずつ後ろにずれる。
   * form-map の order に +1 して引き直す。ここを固定値で書くと、
   * 設問構成が変わるたびにテスト側が黙って壊れる。 */
  const INS_AT = 8;
  const shifted = (label) => {
    const q = FORM_MAP.questions.find((x) => x.label === label);
    return T[q.order >= INS_AT ? q.order + 1 : q.order] || {};
  };
  check('責任者名が正しい欄に入る（旧版はここを外した）',
    shifted('責任者名').value === VALUES.org.責任者名, shifted('責任者名').value);
  check('【その他の場合のみ】箇所名が空のまま（旧版はここに責任者名を書いた）',
    !shifted('【その他の場合のみ】箇所名').value, shifted('【その他の場合のみ】箇所名').value || '(空)');
  check('国内/海外が選択される（旧版は未選択だった）',
    shifted('活動場所（国内/海外）').checked === VALUES.org.既定の国内外,
    shifted('活動場所（国内/海外）').checked);
  check('挿入された設問には何も入れていない', !at(T, INS_AT).value, at(T, INS_AT).value || '(空)');
  check('設問数の食い違いを警告している', /設問数/.test(rIns.bannerText));
} else {
  check('挿入版で結果を回収できた', false, rIns ? rIns.error : 'なし');
}

/* ---- 4b. 条件付き設問による増減で誤警告を出さないこと -------------------
 *
 * このフォームには条件付きの設問が2つあり、答え方で 16〜18 問に変動する。
 * 設問数を17問に決め打ちしていたため、正常な状態でも
 * 「大学がフォームを変更した可能性があります」と嘘の警告が出ていた。
 * 範囲の内と外で、出す／出さないが切り替わることを確かめる。 */
console.log('\n[4b] 設問数が条件付きで増減しても誤警告を出さないか');
const QID_ALLREG_Q = 'r85ffd7ec7cc44039b23c0c3cf1ab31b4';
const QID_OTHER_NAME = MAP.questions.find((q) => q.label === '【その他の場合のみ】箇所名').qid;
const warned = (r) => !!r && /大学がフォームを変更/.test(r.bannerText);

[
  { name: '18問（条件付き2問とも出ている）', omit: [] },
  { name: '17問（授業ではないので6番が無い）', omit: [QID_ALLREG_Q] },
  { name: '16問（条件付き2問とも無い）', omit: [QID_ALLREG_Q, QID_OTHER_NAME] }
].forEach((c) => {
  const r = runFiller(buildMockForm({ noGating: true, omitQids: c.omit }));
  check(`${c.name}: 誤警告を出さない`, r && !warned(r),
    r ? (warned(r) ? '警告が出てしまった' : '警告なし') : '結果を回収できず');
});

/* 範囲を外れたときに、警告が死んでいないこと。
 *
 * 上振れ（設問が増えた）は [4] の挿入テストが「設問数」の警告を確かめている。
 * 下振れ（設問が減った）は、先に「分岐設問に回答したのに設問が増えない」として
 * 検出される。こちらのほうが利用者にとって具体的な指示になるので、
 * そのまま活かす。ここでは **黙って成功扱いにしない** ことだけを確かめる。 */
{
  const keep = MAP.questions.slice(0, 14).map((q) => q.qid);
  const r = runFiller(buildMockForm({
    noGating: true,
    omitQids: MAP.questions.map((q) => q.qid).filter((q) => keep.indexOf(q) === -1)
  }));
  const flagged = !!r && /確認が必要です/.test(r.bannerText);
  check('14問（範囲外）なら異常として報告する', flagged,
    r ? String(r.bannerText).replace(/\s+/g, ' ').slice(0, 90) : '結果を回収できず');
}

/* ---- 4c. 上書きできない値が残っているとき -------------------------------
 *
 * 「入れたつもり」で成功扱いにするのがいちばん危ない。必ず読み戻して、
 * 意図した値になっていなければ失敗として報告すること。 */
console.log('\n[4c] 前から入っていた値を上書きできないとき');
{
  const respOrder = MAP.questions.find((q) => q.label === '責任者名').order;
  const r = runFiller(buildMockForm({ noGating: true, frozen: [respOrder], frozenValue: 'ZZ前回の値' }));
  check('上書きできなかったことに気付く',
    !!r && byLabel(r.state, '責任者名').value === 'ZZ前回の値',
    r ? byLabel(r.state, '責任者名').value : '結果を回収できず');
  const row = r && r.rows.find((x) => x.label === '責任者名');
  check('その設問を失敗として報告している', !!row && row.mark === '✖',
    row ? `${row.mark} ${row.detail}` : 'なし');
  check('残っていた値を名指ししている', !!row && /ZZ前回の値/.test(row.detail),
    row ? row.detail : 'なし');
  check('前の内容が残っている旨をまとめて出している',
    !!r && /上書きできなかった/.test(r.bannerText));
}
// 誤検知しないこと。素のフォームでこの警告が出てはいけない
check('素のフォームでは「上書きできなかった」と言わない',
  !/上書きできなかった/.test(r1.bannerText));

// ---- 5. 特定の3段構え --------------------------------------------------
console.log('\n[5] 設問IDが取れない場合のふるまい');
const rNoId = runFiller(buildMockForm({ stripIds: true }));
if (rNoId && !rNoId.error) {
  const U = rNoId.state;
  check('見出し一致に落ちて入力できる',
    byLabel(U, '申請者氏名').value === VALUES.personal.氏名, byLabel(U, '申請者氏名').value);
  // 「活動場所」と「活動場所（国内/海外）」は見出しが紛らわしい。取り違えないこと
  check('紛らわしい「活動場所」を取り違えない',
    byLabel(U, '活動場所').value === VALUES.draft.活動場所 && !byLabel(U, '活動場所（国内/海外）').value,
    `活動場所=${byLabel(U, '活動場所').value} / 国内海外の入力=${byLabel(U, '活動場所（国内/海外）').value || 'なし'}`);
  const fellBack = rNoId.rows.filter((r) => /代用/.test(r.detail));
  check('代用したことを報告している', fellBack.length > 0, `${fellBack.length} 件`);
} else {
  check('ID なし版で結果を回収できた', false, rNoId ? rNoId.error : 'なし');
}

// ---- 6. 検査の自己テスト -----------------------------------------------
// 期待値をわざとずらして、検査が本当に落ちることを確かめる。
// これがないと「全部 OK」が形骸化していても気付けない。
console.log('\n[6] 検査の自己テスト（わざと違う値で落ちることを確認）');
const wrong = JSON.parse(JSON.stringify(VALUES));
wrong.org.責任者名 = 'ZZ違う人';
const rWrong = runFiller(buildMockForm(), { values: wrong });
check('違う値を入れたら検査が気付く',
  rWrong && byLabel(rWrong.state, '責任者名').value === 'ZZ違う人'
    && byLabel(rWrong.state, '責任者名').value !== VALUES.org.責任者名,
  rWrong ? byLabel(rWrong.state, '責任者名').value : '');

// ---- 7. 読み戻し報告 ---------------------------------------------------
console.log('\n[7] 結果の報告');
check('件数ではなく設問ごとの結果を出している', r1.rows.length >= 15, `${r1.rows.length} 行`);
check('失敗した項目がない', !r1.rows.some((x) => x.mark === '✖'),
  r1.rows.filter((x) => x.mark === '✖').map((x) => x.label + ':' + x.detail).join(' / ') || 'なし');
check('送信前の目視確認を促している', /送信前/.test(r1.bannerText));

// ---- 7b. 段階表示（分岐）への対応 ---------------------------------------
/* 実物は開いた直後 1〜5番しか出ておらず、5番に回答すると6〜8番、
 * 8番に回答すると以降が出る。模擬がこれを再現していなかったため、
 * 「15/15通った」という無意味な検証をしていた期間があった。 */
console.log('\n[7b] 段階表示（分岐）');
{
  // 誤警告の検査。段階表示のせいで「大学がフォームを変更した」と出してはいけない
  check('段階表示を理由に「フォームが変更された」と誤警告しない',
    !/設問数が\s*\d+\s*問で、想定/.test(r1.bannerText),
    /設問数が[^。]*。/.exec(r1.bannerText)?.[0] || '誤警告なし');

  // 分岐の描画が遅れても埋まるか（固定待ちに頼っていないかの担保）
  const slow = runFiller(buildMockForm({ revealDelay: 500 }));
  if (slow && !slow.error) {
    const S2 = slow.state;
    check('分岐の描画が遅れても15問すべて埋まる',
      byLabel(S2, '責任者名').value === VALUES.org.責任者名
      && byLabel(S2, '活動場所').value === VALUES.draft.活動場所
      && byLabel(S2, '活動場所（国内/海外）').checked === VALUES.org.既定の国内外,
      `責任者名=${byLabel(S2, '責任者名').value} / 活動場所=${byLabel(S2, '活動場所').value}`);
    check('遅延時も失敗項目がない', !slow.rows.some((x) => x.mark === '✖'),
      slow.rows.filter((x) => x.mark === '✖').map((x) => x.label).join('、') || 'なし');
  } else {
    check('遅延ありの模擬で結果を回収できた', false, slow ? slow.error : 'なし');
  }

  // 分岐を開けなかったとき、その先を「未到達」と説明できるか
  const broken = JSON.parse(JSON.stringify(VALUES));
  broken.org.活動区分 = 'ZZ存在しない選択肢';   // 5番に回答できなくする
  const stuck = runFiller(buildMockForm(), { values: broken });
  if (stuck && !stuck.error) {
    check('分岐を開けないと、その先が埋まらないことを検出する',
      !at(stuck.state, 9).value, `責任者名=${at(stuck.state, 9).value || '(空)'}`);
    check('原因を「分岐が開かなかったため」と説明する',
      /出ていません|開かなかった|未到達/.test(stuck.bannerText),
      /(?:出ていません|開かなかった|未到達)[^\n]{0,40}/.exec(stuck.bannerText)?.[0] || '説明なし');
  } else {
    check('分岐失敗の模擬で結果を回収できた', false, stuck ? stuck.error : 'なし');
  }
}

// ---- 8. 値の受け取り経路 -----------------------------------------------
// ブックマークレットは値を持たない（登録を一度きりにするため）。
// 値は「フォームを開く」リンクの #gsh=… で渡す。
console.log('\n[8] 値をリンクの # から受け取る');
const rHash = runFiller(buildMockForm(), { delivery: 'hash' });
if (rHash && !rHash.error) {
  const H = rHash.state;
  check('# から値を受け取って記入できる',
    byLabel(H, '申請者氏名').value === VALUES.personal.氏名, byLabel(H, '申請者氏名').value);
  check('選択肢もドロップダウンも埋まる',
    byLabel(H, '加入を希望する補償制度').checked === VALUES.org.加入区分
      && byLabel(H, '活動主管箇所名').dropdown === VALUES.org.申請先,
    `${byLabel(H, '加入を希望する補償制度').checked} / ${byLabel(H, '活動主管箇所名').dropdown}`);
  check('日付も埋まる', byLabel(H, '活動開始日').value === '2026/09/01', byLabel(H, '活動開始日').value);
  check('どの経路で受け取ったかを表示している', /リンクの ?#/.test(rHash.bannerText),
    /受け取り: ([^\n]*)/.exec(rHash.bannerText)?.[1] || '表示なし');
} else {
  check('# 経路で結果を回収できた', false, rHash ? rHash.error : 'なし');
}

// 値がどこにも無いときは、黙って失敗せず貼り付け欄を出す
console.log('\n[9] 値が渡されなかったとき');
const rNone = runFiller(buildMockForm(), { delivery: 'none' });
check('黙って失敗せず、結果バナーも出さない', rNone === null || !!rNone.error,
  rNone && !rNone.error ? '勝手に記入してしまいました' : '記入しませんでした');

console.log(`\n${fail === 0 ? '全て通りました。' : fail + ' 件失敗しました。'}`);
process.exit(fail === 0 ? 0 : 1);
