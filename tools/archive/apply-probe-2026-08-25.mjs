/* apply-probe-2026-08-25.mjs — probe v3 の実測結果を form-map と fixture に取り込む。
 *
 * node tools/apply-probe-2026-08-25.mjs
 *
 * ■ なぜスクリプトにするか
 *   選択肢には全角スペース（U+3000）と改行なし空白（U+00A0）が混ざっている。
 *   手で書き写すと必ず取り違えるので、**コードポイントを明示して組み立て**、
 *   実測で得た文字数と照合してから書き込む。
 *
 * ■ 何度走らせても同じ結果になる（冪等）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP_PATH = path.join(ROOT, 'src', 'form', 'form-map.json');
const FIX_PATH = path.join(ROOT, 'tools', 'fixtures', 'probe-2026-08-24.json');

const Z = '　';    // 全角スペース
const NB = ' ';   // 改行なし空白（NBSP）
const LQ = '“', RQ = '”';

/* ── 実測値 ─────────────────────────────────────────
 * probe v3 の escaped 出力から起こしたもの。文字数も実測と突き合わせる。 */

// 4番 加入を希望する補償制度（修正済み。照合のためここにも置く）
const Q_HOSHO = [
  `1.${Z}学傷補のみ加入${NB} Register only for ${LQ}Compensation for Injury${RQ}`,
  `2.${Z}学傷補と学賠補${Z}両方に加入${Z} Register for both ${LQ}Compensation for Injury${RQ} and ${LQ}Liability Coverage${RQ}`
];

// 5番 活動の種類 — 7件すべて、日本語と英語の間が NBSP
const Q_KIND = [
  `1.授業${NB}Class`,
  `2.研究活動${NB}Research Activities`,
  `3.インターンシップ${NB}Internship`,
  `4.ボランティア活動${NB}Volunteer Activities`,
  `5.教育実習${NB}Educational Practice`,
  `6.学校行事${NB}School events`,
  `7.その他${NB}Other`
];

// 6番（新規）参加者は全員科目登録者ですか — どちらも半角スペース
const Q_ALLREG = ['はい Yes', 'いいえ No'];

// 14番 活動場所（国内/海外）— 半角スペース。変更なし
const Q_AREA = ['1.国内 Domestic', '2.海外 Overseas'];

/* 活動主管箇所名（ドロップダウン36件）のうち、空白を潰していた2件。
 * 残り34件は現状のままで正しいので、この2件だけ差し替える。
 * 潰れた版（キー）から正しい版（値）へ。 */
const DROPDOWN_FIXES = new Map([
  ['所沢総合事務センター（人科・スポ科 学部/研究科） Administrative Office, Tokorozawa',
    `所沢総合事務センター（人科・スポ科${Z}学部/研究科） Administrative Office, Tokorozawa`],
  ['アントレプレナーシップセンター Center for Entrepreneurship',
    `アントレプレナーシップセンター${NB}Center for Entrepreneurship`]
]);

/* 組み立てを間違えていないかの検算。
 *
 * 文字数を並べる方式にしかけたが、その数字を実測ではなく当て推量で書いてしまい
 * 検算として役に立たなかった。ここで確かめたいのは **区切りの空白がどの文字か** なので、
 * 実際に測った値（4番の55/86文字）以外は、コードポイントを直接見る。 */
let bad = 0;
const ng = (msg) => { console.error('  NG ' + msg); bad++; };

// 4番だけは q4test で実測した文字数がある
[55, 86].forEach((want, i) => {
  if (Q_HOSHO[i].length !== want) {
    ng(`Q_HOSHO[${i}] 文字数 ${Q_HOSHO[i].length}（実測は ${want}）`);
  }
});
if (!Q_HOSHO[0].includes(Z) || !Q_HOSHO[0].includes(NB)) ng('Q_HOSHO[0] に U+3000 か U+00A0 が無い');

// 5番は7件すべて「数字.日本語 + NBSP + 英語」。ここが半角スペースだと一致しない
Q_KIND.forEach((s, i) => {
  if (!/^\d\.[^\s ]+ [A-Z]/.test(s)) {
    ng(`Q_KIND[${i}] の区切りが NBSP ではありません: ${JSON.stringify(s)}`);
  }
});

// 6番と14番は素の半角スペース。NBSP や全角が紛れ込んでいないこと
[...Q_ALLREG, ...Q_AREA].forEach((s) => {
  if (s.includes(NB) || s.includes(Z)) ng(`${JSON.stringify(s)} に NBSP か全角スペースが紛れています`);
  if (!s.includes(' ')) ng(`${JSON.stringify(s)} に半角スペースがありません`);
});

if (bad) { console.error('\n組み立てを見直してください。'); process.exit(1); }
console.log('空白の種類の検算 OK');

// ── form-map.json ────────────────────────────────────
const map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));

const QID_KIND = 'r08ba9ed20b864472902fbf3d3daf9795';   // 5番 活動の種類
const QID_ALLREG = 'r85ffd7ec7cc44039b23c0c3cf1ab31b4'; // 6番 全員科目登録者か
const QID_WINDOW = 'r055babb062ca4202bb615df4274266a7'; // 活動主管箇所名

const byQid = (q) => map.questions.find((x) => x.qid === q);

byQid('ra7268c22275a48a0b642fb9044c7026c').choices = Q_HOSHO.slice();
byQid(QID_KIND).choices = Q_KIND.slice();
byQid('r00b622fab56749a2950854c57e46133f').choices = Q_AREA.slice();

const win = byQid(QID_WINDOW);
let fixed = 0;
win.choices = win.choices.map((c) => {
  const to = DROPDOWN_FIXES.get(c);
  if (to) { fixed++; return to; }
  return c;
});
// 既に直っている場合もあるので、正しい形になっているかで判定する
const winOk = [...DROPDOWN_FIXES.values()].every((v) => win.choices.includes(v));
if (!winOk) {
  console.error('  NG 活動主管箇所名の2件を差し替えられませんでした（文字列が想定と違う）');
  process.exit(1);
}
console.log(`活動主管箇所名: ${fixed} 件を差し替え（36件中・残りは変更なし）`);

/* 6番を 5番の直後に挿入する。
 * フォームと同じく「活動の種類 = 1.授業」のときだけ出る条件付きの設問。 */
if (!byQid(QID_ALLREG)) {
  const kindIdx = map.questions.findIndex((x) => x.qid === QID_KIND);
  map.questions.splice(kindIdx + 1, 0, {
    order: 0,   // 下でまとめて振り直す
    qid: QID_ALLREG,
    prefillPriority: 50,
    label: '【授業の場合のみ】全員科目登録者か',
    title: '6.【上記質問で「1.授業」を選択した場合のみ】参加者は全員科目登録者ですか？ [If you selected "1. Class" for the above question] Are all participants registered for the course?単一選択.',
    matchKey: '【上記質問で「1.授業」を選択した場合のみ】参加者は全員科目登録者ですか？[Ifyouselected"1.Class"fortheabovequestion]Areallparticipantsregisteredforthecourse',
    type: 'radio',
    source: 'org.全員科目登録者',
    choices: Q_ALLREG.slice(),
    condition: { dependsOn: QID_KIND, startsWith: '1.授業' },
    _note: '5番で「1.授業」を選んだときだけフォームに現れる。それ以外では触らない。'
  });
  console.log('6番「全員科目登録者か」を追加');
}

// order を並び順どおりに振り直す（0起点）
map.questions.forEach((q, i) => { q.order = i; });

/* 設問数は条件付き2問ぶん増減する。決め打ちだと嘘の警告が出る。
 *   条件なし16問 ＋ 6番 ＋ 【その他】箇所名 = 最大18問 */
const conditional = map.questions.filter((q) => q.condition).length;
map.expectedCount = { min: map.questions.length - conditional, max: map.questions.length };
map.probedAt = '2026-08-25';

fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2) + '\n', 'utf8');
console.log(`form-map: ${map.questions.length} 問 / 条件付き ${conditional} 問 / `
  + `expectedCount ${map.expectedCount.min}〜${map.expectedCount.max}`);

// ── fixture（模擬フォームの元データ）──────────────────
/* fixture は「実際にフォームに出ている設問」を並べたもの。
 * 8/25 の実測と同じ状態（6番が出ていて、【その他】箇所名は出ていない）に合わせる。
 * ここが form-map と食い違うと、模擬フォームと本体が別物になって検証が空回りする。 */
const fix = JSON.parse(fs.readFileSync(FIX_PATH, 'utf8'));
const fixByQid = (q) => fix.設問.find((x) => x.qid === q);

fixByQid('ra7268c22275a48a0b642fb9044c7026c').options = Q_HOSHO.slice();
fixByQid(QID_KIND).options = Q_KIND.slice();
fixByQid('r00b622fab56749a2950854c57e46133f').options = Q_AREA.slice();

const fwin = fixByQid(QID_WINDOW);
fwin.dropdownOptions = fwin.dropdownOptions.map((c) => DROPDOWN_FIXES.get(c) || c);

if (!fixByQid(QID_ALLREG)) {
  const i = fix.設問.findIndex((x) => x.qid === QID_KIND);
  fix.設問.splice(i + 1, 0, {
    index: 0,
    heading: '6.【上記質問で「1.授業」を選択した場合のみ】参加者は全員科目登録者ですか？ [If you selected "1. Class" for the above question] Are all participants registered for the course?単一選択.',
    type: 'radio',
    qid: QID_ALLREG,
    options: Q_ALLREG.slice()
  });
}
fix.設問.forEach((q, i) => { q.index = i; });

/* 表示番号を振り直す。
 * Forms は「いま出ている設問」に対して番号を振り直すので、条件付きの設問が
 * 出入りすると番号がずれる（実測：活動主管箇所名は 8/24 は 8番、8/25 は 9番）。
 * fixture は条件付き2問とも出た状態＝18問の全部入りなので、1〜18 を振る。 */
const renumber = (s, i) => String(s).replace(/^\d+\./, (i + 1) + '.');
fix.設問.forEach((q, i) => { q.heading = renumber(q.heading, i); });
map.questions.forEach((q, i) => { if (q.title) q.title = renumber(q.title, i); });
fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2) + '\n', 'utf8');

/* 段階表示（分岐で少しずつ出てくる）の定義。6番が増えたので組み直す。
 *   最初に見えているのは1〜5番
 *   5番（活動の種類）に答えると 6〜9番 が出る（6番＝全員科目登録者もここ）
 *   9番（活動主管箇所名）に答えると残りが出る
 * 単純に添字をずらすだけだと、5番に答えて出るはずの6番が漏れる。 */
if (fix.段階表示) {
  fix.段階表示 = [
    { unlockedBy: null, reveals: [0, 1, 2, 3, 4], _note: '開いた直後に見えている設問' },
    { unlockedBy: 4, reveals: [5, 6, 7, 8], _note: '5番（活動の種類）に回答すると6〜9番が出る' },
    { unlockedBy: 8, reveals: [9, 10, 11, 12, 13, 14, 15, 16, 17], _note: '9番（活動主管箇所名）に回答すると以降が出る' }
  ];
}

fs.writeFileSync(FIX_PATH, JSON.stringify(fix, null, 2) + '\n', 'utf8');
console.log(`fixture: ${fix.設問.length} 問`
  + (fix.段階表示 ? ` / 段階表示 ${JSON.stringify(fix.段階表示)}` : ''));
