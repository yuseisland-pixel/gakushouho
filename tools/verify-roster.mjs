/* verify-roster.mjs — 名簿生成が原本を壊していないことを機械的に確かめる。
 *
 * node tools/verify-roster.mjs
 *
 * ブラウザ用のモジュールを Node 上でそのまま動かして名簿を作り、
 *   1. 触っていないはずの zip エントリが 1 バイトも変わっていないか
 *   2. テーブル定義・データ検証・結合セル・dimension が不変か
 *   3. 値が想定どおりのセルに、想定どおりの型で入っているか
 * を検査する。Excel で開けるかどうかは tools/verify-excel.ps1 が受け持つ。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
// 配布フォルダを汚さないよう、検証の出力は tmp/ に置く
const OUT = path.join(ROOT, 'tmp', '検証用_参加者名簿.xlsx');

// ブラウザ用モジュールを読むための最小限の窓口
globalThis.window = globalThis;
for (const f of ['core/zip.js', 'core/roster-xlsx.js']) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(SRC, f), 'utf8'));
}
const { Zip, Roster } = globalThis.GSH;

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  OK  ' : '  NG  '} ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

function entriesOf(bytes) {
  const map = new Map();
  for (const e of Zip.parse(bytes)) map.set(e.name, e);
  return map;
}

async function inflateAll(bytes) {
  const out = new Map();
  for (const e of Zip.parse(bytes)) out.set(e.name, Buffer.from(await Zip.read(e)));
  return out;
}

const MEMBERS = [
  { 学籍番号: '1A123456', カナ氏名: 'ワセダ　タロウ' },
  { 学籍番号: '1B234567', カナ氏名: 'オオクマ　シゲノブ' },
  { 学籍番号: '9Z999999', カナ氏名: 'テスト　ハナコ' }
];

const DATA = {
  申請者氏名: 'テスト 申請者',
  活動名: 'テスト団体での活動',
  責任者名: 'テスト 責任者',
  活動場所: '早稲田大学 早稲田キャンパス <7号館> & 周辺',   // XMLエスケープの確認も兼ねる
  活動開始日: '2026-09-01',
  活動終了日: '2026-09-03',
  申請年月日: '2026-08-24',
  members: MEMBERS
};

const tpl = new Uint8Array(fs.readFileSync(path.join(SRC, 'template', '参加者名簿.xlsx')));

console.log('名簿生成の検証\n');

const out = await Roster.generate(tpl, DATA);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(out));
console.log(`生成: ${OUT} (${out.length} バイト)\n`);

const before = await inflateAll(tpl);
const after = await inflateAll(out);

// --- 1. 触っていないエントリがバイト等価か -------------------------
console.log('[1] 原本の保全');
const CHANGED = new Set(['xl/worksheets/sheet1.xml', 'xl/workbook.xml']);
const DROPPED = new Set(['xl/calcChain.xml']);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let identical = 0;
for (const [name, buf] of before) {
  if (DROPPED.has(name)) {
    check(`${name} が取り除かれている`, !after.has(name));
    continue;
  }
  if (!after.has(name)) { check(`${name} が残っている`, false, '消えています'); continue; }
  const same = sha(buf) === sha(after.get(name));
  if (CHANGED.has(name)) {
    check(`${name} が変更されている`, !same);
  } else {
    if (same) identical++;
    else check(`${name} がバイト等価`, false, '意図せず変わっています');
  }
}
check(`手を付けていない ${identical} 件がすべてバイト等価`, identical === before.size - CHANGED.size - DROPPED.size,
  `${identical} / ${before.size - CHANGED.size - DROPPED.size}`);
check('エントリ数が 1 件だけ減っている（calcChain のみ）', after.size === before.size - 1, `${before.size} → ${after.size}`);

// --- 2. シートの構造が不変か ---------------------------------------
console.log('\n[2] シート構造の保全');
const sheetBefore = before.get('xl/worksheets/sheet1.xml').toString('utf8');
const sheetAfter = after.get('xl/worksheets/sheet1.xml').toString('utf8');
const grab = (xml, re) => { const m = re.exec(xml); return m ? m[0] : null; };

for (const [label, re] of [
  ['dimension', /<dimension[^>]*\/>/],
  ['mergeCells', /<mergeCells[\s\S]*?<\/mergeCells>/],
  ['dataValidations', /<dataValidations[\s\S]*?<\/dataValidations>/],
  ['sheetProtection', /<sheetProtection[^>]*\/>/],
  ['tableParts', /<tableParts[\s\S]*?<\/tableParts>/],
  ['cols', /<cols>[\s\S]*?<\/cols>/]
]) {
  check(`${label} が不変`, grab(sheetBefore, re) === grab(sheetAfter, re));
}

const tableXml = after.get('xl/tables/table1.xml').toString('utf8');
check('テーブル名が テーブル1 のまま', /name="テーブル1"/.test(tableXml) && /ref="A10:H60"/.test(tableXml));
check('A列(No)の静的値 1..50 が不変',
  Array.from({ length: 50 }, (_, i) => `<c r="A${11 + i}" s="${i === 5 ? 21 : 2}"><v>${i + 1}</v></c>`)
    .every((_, i) => new RegExp(`<c r="A${11 + i}"[^>]*><v>${i + 1}</v></c>`).test(sheetAfter)));

// --- 3. 値が正しく入っているか -------------------------------------
console.log('\n[3] 書き込まれた値');
const cell = (ref) => {
  const m = new RegExp(`<c r="${ref}"[^>]*>[\\s\\S]*?<\\/c>`).exec(sheetAfter);
  return m ? m[0] : null;
};
const inlineText = (ref) => {
  const c = cell(ref);
  const m = c && /<is><t[^>]*>([\s\S]*?)<\/t><\/is>/.exec(c);
  return m ? m[1] : null;
};
const numValue = (ref) => {
  const c = cell(ref);
  const m = c && /<v>(\d+)<\/v>/.exec(c);
  return m ? Number(m[1]) : null;
};

check('B1 申請者氏名', inlineText('B1') === DATA.申請者氏名, String(inlineText('B1')));
check('B2 活動名', inlineText('B2') === DATA.活動名, String(inlineText('B2')));
check('B3 責任者名', inlineText('B3') === DATA.責任者名, String(inlineText('B3')));

MEMBERS.forEach((m, i) => {
  const r = 11 + i;
  check(`B${r} 学籍番号`, inlineText(`B${r}`) === m.学籍番号, String(inlineText(`B${r}`)));
  check(`C${r} カナ氏名`, inlineText(`C${r}`) === m.カナ氏名, String(inlineText(`C${r}`)));
  check(`D${r} 申請年月日 がシリアル値`, numValue(`D${r}`) === Roster.toSerial(DATA.申請年月日), String(numValue(`D${r}`)));
  check(`E${r} 活動開始日 がシリアル値`, numValue(`E${r}`) === Roster.toSerial(DATA.活動開始日), String(numValue(`E${r}`)));
  check(`F${r} 活動終了日 がシリアル値`, numValue(`F${r}`) === Roster.toSerial(DATA.活動終了日), String(numValue(`F${r}`)));
  check(`H${r} status キャッシュが T`, /<v>T<\/v>/.test(cell(`H${r}`)));
});

check('G11 活動場所（XMLエスケープ）',
  inlineText('G11') === '早稲田大学 早稲田キャンパス &lt;7号館&gt; &amp; 周辺', String(inlineText('G11')));
check('H列の数式が全行そのまま残っている',
  (sheetAfter.match(/IF\(OR\(テーブル1/g) || []).length === (sheetBefore.match(/IF\(OR\(テーブル1/g) || []).length);

const unusedRow = 11 + MEMBERS.length;
check(`未使用行 H${unusedRow} は F のまま`, /<v>F<\/v>/.test(cell(`H${unusedRow}`)));
check(`未使用行 B${unusedRow} は空のまま`, new RegExp(`<c r="B${unusedRow}"[^>]*/>`).test(sheetAfter));

// --- 4. workbook.xml ------------------------------------------------
console.log('\n[4] 再計算の指示');
const wb = after.get('xl/workbook.xml').toString('utf8');
check('fullCalcOnLoad="1" がちょうど1つ', (wb.match(/fullCalcOnLoad="1"/g) || []).length === 1);
check('calcPr 以外は不変',
  wb.replace(/ fullCalcOnLoad="1"/, '') === before.get('xl/workbook.xml').toString('utf8'));

// --- 5. シリアル値の妥当性 -----------------------------------------
console.log('\n[5] 日付変換');
check('1900-01-01 → 2', Roster.toSerial('1900-01-01') === 2);
check('2026-08-24 → 46258', Roster.toSerial('2026-08-24') === 46258, String(Roster.toSerial('2026-08-24')));

// --- 6. 入力検証 -----------------------------------------------------
console.log('\n[6] 入力チェック');
check('正しい値は問題なし', Roster.validateMember({ 学籍番号: '1A123456', カナ氏名: 'ワセダ　タロウ' }).length === 0);
check('学籍番号7桁を弾く', Roster.validateMember({ 学籍番号: '1A12345', カナ氏名: 'ワセダ　タロウ' }).length === 1);
check('半角スペースのカナ氏名を弾く', Roster.validateMember({ 学籍番号: '1A123456', カナ氏名: 'ワセダ タロウ' }).length === 1);
check('ひらがなを弾く', Roster.validateMember({ 学籍番号: '1A123456', カナ氏名: 'わせだ　たろう' }).length === 1);

// --- 7. 上限 ---------------------------------------------------------
console.log('\n[7] 上限');
let over = null;
try {
  await Roster.generate(tpl, { ...DATA, members: Array.from({ length: 51 }, () => MEMBERS[0]) });
} catch (e) { over = e.message; }
check('51名で明示的に失敗する', over !== null && /50/.test(over), String(over));

console.log(`\n${failures === 0 ? '全て通りました。' : failures + ' 件失敗しました。'}`);
process.exit(failures === 0 ? 0 : 1);
