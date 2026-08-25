/* verify-choices.mjs — form-map.json の選択肢が「潰れていない」ことを検査する。
 *
 * node tools/verify-choices.mjs
 *
 * ■ なぜこの検査が要るか
 *   事前入力（?<設問ID>="選択肢"）は **フォームが持っている文字列と完全一致** でないと効かない。
 *   probe が `label.replace(/\s+/g, ' ')` をしていたせいで、
 *   全角スペース（U+3000）・改行なし空白（U+00A0）・二重スペースが半角1個に潰れ、
 *   選択肢の事前入力が一つも効かなかった（2026-08-25 に判明）。
 *
 *   潰れているかどうかは目で見て分からない。だから機械で見張る。
 *
 * ■ ここで守ること
 *   1. 実機で確認済みの文字列と、form-map.json の中身が1文字も違わないこと
 *   2. form-map.json と fixture（模擬フォームの元データ）が食い違わないこと
 *      — 片方だけ直すと、模擬フォームと本体が同じ誤りを共有して検証が空回りする
 *   3. 潰した痕跡（全角や NBSP が半角に化けた等）が無いこと
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'form', 'form-map.json'), 'utf8'));
const FIXTURE_PATH = path.join(ROOT, 'tools', 'fixtures', 'probe-2026-08-24.json');
const FIXTURE = fs.existsSync(FIXTURE_PATH)
  ? JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) : null;

let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'OK ' : 'NG '}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) fail++;
};

const Z = '　';    // 全角スペース
const NB = ' ';   // 改行なし空白（NBSP）
const reveal = (s) => String(s)
  .replace(/ /g, '␠').replace(new RegExp(Z, 'g'), '［全角］').replace(new RegExp(NB, 'g'), '［NBSP］');

/* 実機の HTML と probe v3 の出力から確認した、1文字も加工していない文字列。
 *
 * ここは **手で書いた正解値** であって、probe の出力から作ってはいけない。
 * probe から作ると、probe が壊れたときに正解値も一緒に壊れて検査が意味を失う
 * （模擬フォームを壊れたデータから作っていたせいで、実際に検証が空回りしていた）。
 *
 * 設問IDで引く。並び順（order）で書くと、設問が1つ増えた瞬間に別の設問を指す。
 * 空白は見た目で区別できないので、コードポイントを明示して組み立てる。 */
const QID_HOSHO = 'ra7268c22275a48a0b642fb9044c7026c';    // 4.加入を希望する補償制度
const QID_KIND = 'r08ba9ed20b864472902fbf3d3daf9795';     // 5.活動の種類
const QID_ALLREG = 'r85ffd7ec7cc44039b23c0c3cf1ab31b4';   // 6.全員科目登録者か
const QID_WINDOW = 'r055babb062ca4202bb615df4274266a7';   // 活動主管箇所名（36択）
const QID_AREA = 'r00b622fab56749a2950854c57e46133f';     // 活動場所（国内/海外）

const KNOWN = {
  [QID_HOSHO]: [
    `1.${Z}学傷補のみ加入${NB} Register only for “Compensation for Injury”`,
    `2.${Z}学傷補と学賠補${Z}両方に加入${Z} Register for both “Compensation for Injury” and “Liability Coverage”`
  ],
  // 7件すべて、日本語と英語の間が NBSP。ここを半角にすると一致しない
  [QID_KIND]: [
    `1.授業${NB}Class`,
    `2.研究活動${NB}Research Activities`,
    `3.インターンシップ${NB}Internship`,
    `4.ボランティア活動${NB}Volunteer Activities`,
    `5.教育実習${NB}Educational Practice`,
    `6.学校行事${NB}School events`,
    `7.その他${NB}Other`
  ],
  // こちらは素の半角スペース
  [QID_ALLREG]: ['はい Yes', 'いいえ No'],
  [QID_AREA]: ['1.国内 Domestic', '2.海外 Overseas']
};

/* 活動主管箇所名（36件）のうち、空白が特殊な2件。
 * 36件すべてを書き写すと保守できないので、間違えやすいものだけを名指しで見張る。 */
const KNOWN_IN_DROPDOWN = [
  `所沢総合事務センター（人科・スポ科${Z}学部/研究科） Administrative Office, Tokorozawa`,
  `アントレプレナーシップセンター${NB}Center for Entrepreneurship`
];

console.log('[1] 実機で確認済みの文字列と一致するか');
for (const [qid, wants] of Object.entries(KNOWN)) {
  const q = MAP.questions.find((x) => x.qid === qid);
  if (!q) { check(`設問 ${qid} が form-map にある`, false); continue; }
  check(`${q.label}: 選択肢の数`, (q.choices || []).length === wants.length,
    `${(q.choices || []).length} / ${wants.length} 件`);
  wants.forEach((want, k) => {
    const got = (q.choices || [])[k];
    check(`${q.label}: 選択肢${k + 1} が実機と1文字も違わない`, got === want,
      got === want ? reveal(want) : `期待 ${reveal(want)}\n         実際 ${reveal(String(got))}`);
  });
}
{
  const q = MAP.questions.find((x) => x.qid === QID_WINDOW);
  KNOWN_IN_DROPDOWN.forEach((want) => {
    check(`活動主管箇所名に「${want.slice(0, 10)}…」が1文字も違わずある`,
      !!q && (q.choices || []).includes(want), reveal(want));
  });
}

console.log('\n[2] 潰した痕跡がないか');
{
  /* 空白を潰すコードに戻ると、これらが消える。
   * 「特殊な空白が残っていること」を直接確かめるのが、いちばん壊れにくい検査。 */
  const all = MAP.questions.flatMap((q) => q.choices || []);
  check('全角スペース（U+3000）を含む選択肢が残っている', all.some((c) => c.includes(Z)),
    `${all.filter((c) => c.includes(Z)).length} 件`);
  check('改行なし空白（U+00A0）を含む選択肢が残っている', all.some((c) => c.includes(NB)),
    `${all.filter((c) => c.includes(NB)).length} 件`);

  const kind = MAP.questions.find((x) => x.qid === QID_KIND);
  const nbspSep = new RegExp('^\\d\\.[^\\s' + NB + ']+' + NB);
  const wrong = (kind.choices || []).filter((c) => !nbspSep.test(c));
  check('活動の種類は7件すべてが NBSP 区切り', wrong.length === 0,
    wrong.length ? wrong.map(reveal).join(' / ') : 'すべて OK');
}

console.log('\n[3] 選択肢そのものの健全性');
{
  let n = 0;
  for (const q of MAP.questions) {
    if (!q.choices || !q.choices.length) continue;
    n += q.choices.length;
    check(`${q.label}（${q.choices.length}件）に空文字が無い`,
      q.choices.every((c) => typeof c === 'string' && c !== ''));
    check(`${q.label} に重複が無い`, new Set(q.choices).size === q.choices.length);
    // 前後の空白は Forms 側の文字列に含まれうるので落とさない。
    // ただし改行が混ざっているのは読み取りミスの兆候
    check(`${q.label} に改行が混ざっていない`, q.choices.every((c) => !/[\r\n]/.test(c)));
  }
  console.log(`       選択肢は全部で ${n} 件`);
}

console.log('\n[4] fixture（模擬フォームの元データ）と食い違っていないか');
if (!FIXTURE) {
  check('fixture が読める', false, FIXTURE_PATH);
} else {
  for (const q of MAP.questions) {
    if (!q.choices || !q.choices.length) continue;
    // 設問IDで突き合わせる。並び順で引くと設問が増えた瞬間に別の設問を指す
    const fq = (FIXTURE.設問 || []).find((x) => x.qid === q.qid);
    const fopts = fq && (fq.options || fq.dropdownOptions
      || (fq.dropdown && fq.dropdown.options) || []);
    const fraw = (fopts || []).map((o) => (typeof o === 'string' ? o : o.raw));
    if (!fraw.length) { check(`${q.label} が fixture にもある`, false, '選択肢が無い'); continue; }
    const same = fraw.length === q.choices.length && fraw.every((v, i) => v === q.choices[i]);
    const at = fraw.findIndex((v, i) => v !== q.choices[i]);
    check(`${q.label} が fixture と1文字も違わない`, same,
      same ? `${fraw.length} 件`
        : `${at + 1}件目が違う\n         form-map ${reveal(String(q.choices[at]))}\n         fixture  ${reveal(String(fraw[at]))}`);
  }
}

console.log('\n[5] 設問数の想定が範囲になっているか');
{
  /* 条件付きの設問が出入りするので、設問数は決め打ちにできない。
   * 17問固定にしていたため、正常な状態でも「大学がフォームを変更した」と誤警告していた。 */
  const ec = MAP.expectedCount;
  check('expectedCount が min/max の範囲', !!ec && typeof ec === 'object'
    && typeof ec.min === 'number' && typeof ec.max === 'number',
    JSON.stringify(ec));
  if (ec && typeof ec === 'object') {
    const conditional = MAP.questions.filter((q) => q.condition).length;
    check('max が全設問数と一致', ec.max === MAP.questions.length,
      `${ec.max} / ${MAP.questions.length}`);
    check('min が「条件付きが全部隠れたとき」の数と一致',
      ec.min === MAP.questions.length - conditional,
      `${ec.min} = ${MAP.questions.length} - 条件付き ${conditional}`);
  }
}

console.log('\n[6] この検査自体が本物か（バグを戻したら落ちるか）');
{
  /* 検査を足しても、それが何も見ていなければ意味がない。
   * 「空白を潰す」という、まさに起きたバグを再現して、上の検査が落ちることを確かめる。 */
  const squash = (s) => s.replace(/\s+/g, ' ').trim();
  const kind = MAP.questions.find((x) => x.qid === QID_KIND);
  const squashed = (kind.choices || []).map(squash);

  const nbspSep = new RegExp('^\\d\\.[^\\s' + NB + ']+' + NB);
  check('潰すと「NBSP 区切り」の検査が落ちる',
    !squashed.every((c) => nbspSep.test(c)), '潰れた文字列を検出した');
  check('潰すと「実機と1文字も違わない」の検査が落ちる',
    !squashed.every((c, i) => c === KNOWN[QID_KIND][i]), '潰れた文字列を検出した');

  const hosho = MAP.questions.find((x) => x.qid === QID_HOSHO);
  check('潰すと全角スペースが消える', !squash(hosho.choices[0]).includes(Z));
}

console.log(fail === 0 ? '\n全て通りました。' : `\n${fail} 件失敗しました。`);
process.exit(fail === 0 ? 0 : 1);
