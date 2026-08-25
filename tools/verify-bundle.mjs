/* verify-bundle.mjs — dist の配布物が壊れていないかを確かめる。
 *
 * node tools/verify-bundle.mjs
 *
 * ブラウザを起動せずに確認できることだけを見る:
 *   - 同梱スクリプトが構文エラーなく読めるか
 *   - 生成されるブックマークレット2種が構文エラーなく読めるか
 *   - Forms の CSP(require-trusted-types-for 'script')で落ちる innerHTML が残っていないか
 *   - テンプレ xlsx が base64 で正しく埋め込まれているか
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  OK  ' : '  NG  '} ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) fail++;
};
const syntaxOk = (src, name) => {
  try { new vm.Script(src, { filename: name }); return null; }
  catch (e) { return e.message; }
};

console.log('配布物の検証\n');

const htmlName = fs.readdirSync(DIST).find((n) => /^学傷補入力支援_v.*\.html$/.test(n));
if (!htmlName) { console.log('  NG   配布用 HTML が見つかりません（先に node tools/build.mjs）'); process.exit(1); }
const htmlPath = path.join(DIST, htmlName);
const html = fs.readFileSync(htmlPath, 'utf8');
check('配布用 HTML が存在する', true, `${Math.round(fs.statSync(htmlPath).size / 1024)} KB`);

const bundle = /<script>([\s\S]*?)<\/script>/.exec(html);
check('script タグが1つ埋まっている', !!bundle);
if (bundle) {
  const err = syntaxOk(bundle[1], 'bundle.js');
  check('同梱スクリプトの構文', err === null, err || `${bundle[1].length} 文字`);
}

// テンプレ xlsx が base64 で埋まっているか
const b64 = /var TEMPLATE_B64 = "([A-Za-z0-9+/=]+)"/.exec(bundle ? bundle[1] : '');
check('テンプレ xlsx が埋め込まれている', !!b64);
if (b64) {
  const bytes = Buffer.from(b64[1], 'base64');
  check('埋め込みテンプレが zip として妥当', bytes.readUInt32LE(0) === 0x04034b50, `${bytes.length} バイト`);
  const orig = fs.readFileSync(path.join(ROOT, 'src', 'template', '参加者名簿.xlsx'));
  check('埋め込みテンプレが原本と一致', bytes.equals(orig));
}

// 調査用ブックマークレット
const probeFile = fs.readdirSync(DIST).find((n) => /^フォーム調査ブックマークレット_.*\.txt$/.test(n));
check('調査ブックマークレットのファイル名に版が入っている', !!probeFile, probeFile || '見つかりません');
const probeTxt = probeFile ? fs.readFileSync(path.join(DIST, probeFile), 'utf8') : '';
const probeUrl = probeTxt.split('\n').find((l) => l.startsWith('javascript:'));
check('調査ブックマークレットが出力されている', !!probeUrl);
let probeSrc = '';
if (probeUrl) {
  probeSrc = decodeURIComponent(probeUrl.slice('javascript:'.length));
  const err = syntaxOk(probeSrc, 'probe.js');
  check('調査ブックマークレットの構文', err === null, err || `URL ${probeUrl.length} 文字`);
  check('調査ブックマークレットが登録可能な長さ', probeUrl.length < 60000, `${probeUrl.length} 文字`);
}

// フォーム記入エンジン（bookmarklet-gen 内に JSON 文字列として埋まっている）
const fillerMatch = /var FILLER_SOURCE = ("(?:[^"\\]|\\.)*");/.exec(bundle ? bundle[1] : '');
check('フォーム記入エンジンが埋め込まれている', !!fillerMatch);
let fillerSrc = '';
if (fillerMatch) {
  fillerSrc = JSON.parse(fillerMatch[1]);
  const err = syntaxOk(`(function(){${fillerSrc}})()`, 'filler.js');
  check('フォーム記入エンジンの構文', err === null, err || `${fillerSrc.length} 文字`);
}

// app.js が触る要素 ID が index.html に実在するか。
// ここがズレていると起動時に落ちて画面が死ぬので、静的に潰しておく。
console.log('\n画面と制御コードの整合');
{
  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const declared = new Set([...indexSrc.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...appSrc.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !declared.has(id));
  check('app.js が参照する ID がすべて HTML に存在する', missing.length === 0,
    missing.length ? '不足: ' + missing.join(', ') : `${used.size} 個を確認`);
}

// 事前入力 URL の組み立て。実機で踏んだ失敗をそのまま回帰テストにしている。
console.log('\n事前入力 URL の組み立て');
{
  globalThis.window = globalThis;
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(ROOT, 'src', 'core', 'prefill.js'), 'utf8'));
  const { Prefill } = globalThis.GSH;
  const MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'form', 'form-map.json'), 'utf8'));
  const FORM = MAP.formOrigin + MAP.formPath + '?id=' + MAP.formId + '&route=shorturl';

  /* 選択肢は設問IDで引く。並び順（index）で引くと、設問が1つ増えただけで
   * 黙って別の設問を指してしまう（6番が増えたときに実際そうなった）。 */
  const choice = (qid, i) => {
    const q = MAP.questions.find((x) => x.qid === qid);
    if (!q || !q.choices || q.choices[i] == null) throw new Error(`選択肢が引けません: ${qid}[${i}]`);
    return q.choices[i];
  };
  // 値はすべて ZZ 始まりのダミー。実在の氏名やメールは検証にも置かない
  const V = {
    'personal.氏名': 'ZZ検証 太郎', 'applicant.メール': 'zz-test@example.invalid',
    'applicant.共有メール': 'zz-test2@example.invalid', 'applicant.氏名': 'ZZ検証 花子',
    'org.加入区分': choice('ra7268c22275a48a0b642fb9044c7026c', 0),
    'org.活動区分': choice('r08ba9ed20b864472902fbf3d3daf9795', 6),
    'org.全員科目登録者': choice('r85ffd7ec7cc44039b23c0c3cf1ab31b4', 0),
    'org.活動名': 'ZZ同好会での活動', 'draft.活動内容': 'フィールドワーク（採集・観察）',
    'org.申請先': choice('r055babb062ca4202bb615df4274266a7', 28),
    'org.申請先その他': '', 'org.責任者名': 'ZZ責任者 花子',
    'draft.活動開始日': '2026/09/01', 'draft.活動終了日': '2026/09/03',
    'derived.参加学生数': '7',
    'draft.国内外': choice('r00b622fab56749a2950854c57e46133f', 0),
    'draft.活動場所': '○○県○○市 ○○川河川敷', 'draft.備考': ''
  };
  const resolve = (q) => (q.source && V[q.source] != null) ? V[q.source] : '';
  const r = Prefill.build(FORM, MAP.questions, resolve, { prefix: MAP.prefillPrefix });

  check('URL を生成できた', !!r.url && r.usable, r.error || `${r.length} 文字`);
  check('空白が %20 で送られる（+ ではない）', /%20/.test(r.url) && !/\+/.test(r.url));
  check('route=shorturl が落ちている', !/route=shorturl/.test(r.url));

  // ★ v1.1.0 の失敗。2通りの綴りを送るとパラメータ数が倍になり打ち切りを早める
  check('綴りが1通りだけ（rr… が混ざらない）', !/[?&]rr[0-9a-f]{32}=/.test(r.url));

  // ★ v1.1.1 A案の失敗。飛び飛びに送ると Forms が途中で打ち切る
  const names = [...r.url.matchAll(/[?&](r[0-9a-f]{32})=/g)].map((m) => m[1]);
  const orders = names.map((n) => MAP.questions.find((q) => q.qid === n).order);
  const contiguous = orders.every((o, i) => o === i);
  check('設問順に穴なく並んでいる（飛ばすと以降が無視される）', contiguous,
    contiguous ? `order 0..${orders.length - 1} が連続` : `並び: ${orders.join(',')}`);

  // 値が空でもパラメータは出す（穴を空けないため）
  const emptyQ = MAP.questions.find((q) => q.label === '【その他の場合のみ】箇所名');
  check('値が空の設問もパラメータとして載る', r.url.includes('&' + emptyQ.qid + '='),
    `${emptyQ.label}`);

  // ファイル欄で打ち切る（それ以降は届かないので載せない）
  check('ファイル欄の手前で止めている', r.stoppedAt === '参加者名簿', String(r.stoppedAt));
  const fileQ = MAP.questions.find((q) => q.type === 'file');
  check('ファイル欄を URL に載せていない', !r.url.includes(fileQ.qid));
  const remarksQ = MAP.questions.find((q) => q.label === '備考');
  check('ファイル欄より後ろの備考も載せていない', !r.url.includes(remarksQ.qid));
  check('届かない項目を理由付きで報告している',
    r.skipped.length === 2 && r.skipped.every((s) => !!s.reason),
    r.skipped.map((s) => s.label).join('、'));

  /* 事前入力に載るのは「ファイル欄より前の全設問」。
   * 数を書き写すと設問が増えたときに黙って食い違うので、map から数える。 */
  const fileIdx = MAP.questions.findIndex((q) => q.type === 'file');
  const prefillable = fileIdx === -1 ? MAP.questions.length : fileIdx;
  check(`ファイル欄の手前まで全 ${prefillable} 問が上限内に収まる`,
    r.included.length === prefillable && r.length <= Prefill.MAX_URL,
    `${r.included.length} / ${prefillable} 問 / ${r.length} 文字`);

  /* ★ 短縮するときに何を残すか。
   * 分岐を開く設問（5番・8番）が外れると後続が画面に出てこなくなるので、
   * これだけは絶対に外してはいけない。外すのは長い自由記述から。 */
  const tight = Prefill.build(FORM, MAP.questions, resolve, { prefix: MAP.prefillPrefix, maxUrl: 1000 });
  check('短縮すると項目が減る', tight.included.length < r.included.length,
    `${r.included.length} → ${tight.included.length} 問 / ${tight.length} 文字`);
  check('短縮しても上限内に収まる', tight.length <= 1000, `${tight.length} 文字`);

  const gates = MAP.questions.filter((q) => q.unlocksMore).map((q) => q.label);
  check('分岐を開く設問は短縮しても必ず残る',
    gates.every((g) => tight.included.includes(g)), gates.join('、'));
  check('選択肢の設問は短縮しても残る',
    MAP.questions.filter((q) => q.type === 'radio' || q.type === 'dropdown')
      .every((q) => tight.included.includes(q.label)));
  check('外れるのは長い自由記述', tight.skipped.every((s) => {
    const q = MAP.questions.find((x) => x.label === s.label);
    return !q || q.type === 'text' || q.type === 'textarea' || q.type === 'file';
  }), tight.skipped.map((s) => s.label).join('、'));

  /* ★ 種別ごとの書式。ここを間違えて全部を裸のテキストで送っていたため、
   * 選択肢と日付が入らず、5番（分岐点）が未回答のままになって
   * 6番以降がまるごと画面に出てこなかった。 */
  const dec = (u) => [...new URL(u).searchParams].filter(([k]) => k !== 'id');
  const pairs = dec(r.url);
  const typeOf = (k) => (MAP.questions.find((q) => q.qid === k) || {}).type;
  const quoted = (v) => v.startsWith('"') && v.endsWith('"');
  const bad = pairs.filter(([k, v]) => {
    if (v === '') return false;
    const need = ['radio', 'checkbox', 'dropdown', 'date'].includes(typeOf(k));
    return need !== quoted(v);
  });
  check('選択肢と日付をダブルクォートで囲んでいる', bad.length === 0,
    bad.map(([k, v]) => typeOf(k) + ':' + v.slice(0, 24)).join(' / ') || 'OK');
  const dates = pairs.filter(([k]) => typeOf(k) === 'date');
  check('日付が yyyy-MM-dd 形式', dates.every(([, v]) => /^"\d{4}-\d{2}-\d{2}"$/.test(v)),
    dates.map(([, v]) => v).join(' / '));
  check('テキストには引用符を付けていない',
    pairs.filter(([k, v]) => typeOf(k) === 'text' && v !== '').every(([, v]) => !quoted(v)));

  check('id が無い URL はエラーを返す',
    Prefill.build('https://forms.cloud.microsoft/pages/responsepage.aspx', [], resolve).error != null);
}

/* 画面が「確認できていないこと」を断定していないか。
 *
 * v1.2.0 で、実機では3問しか入らない事前入力に対して
 * 「15項目が入ります」と表示してしまった。未検証の挙動を断定したうえに、
 * 検証済みのブックマークレットより前に置いて主導線にしていた。
 * 同じことを繰り返さないための検査。 */
console.log('\n未検証の機能を主導線にしていないか');
{
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const appRaw = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  /* コメントは対象外。「こう書いてはいけない」と説明したコメント自身に
   * 引っかかってしまうため（lint スキャナでも同じ罠を踏んだ）。 */
  const appSrc = appRaw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

  /* 事前入力で何問入るかを断定していないか。
   * 数字は変数から組み立てられる（`r.included.length + ' 項目が入ります'`）ので、
   * 数字ではなく**言い回し**を見る。最初これを数字で探して素通りさせた。 */
  const ASSERTIVE = [
    /項目が入ります/, /問が入ります/, /問が入った状態/, /すべて入ります/, /全部入ります/
  ];
  const hit = ASSERTIVE.find((re) => re.test(appSrc) || re.test(indexSrc));
  check('事前入力で入る項目数を断定していない', !hit,
    hit ? `「${hit.source}」に当たる表現があります` : 'OK');

  // 検証済みのブックマークレット（③）が、未確定の事前入力（②）より後に「本命」として置かれているか
  const prefillAt = indexSrc.indexOf('id="prefill-link"');
  const bmAt = indexSrc.indexOf('id="bm-link"');
  /* ★ AADSTS90015 の再発防止。
   * エラーが出たとき内訳を測ったら、URL 7,089文字のうち 5,652文字（80%）が
   * ハッシュ（#gsh=）で、事前入力クエリは1,292文字だった。
   * 膨らませていたのはハッシュのほう。だからリンクにハッシュは載せない。 */
  check('「フォームを開く」リンクにハッシュを載せていない',
    !/var link = formUrl \+ '#gsh='/.test(appSrc),
    /#gsh=' \+ payload/.test(appSrc) ? 'リンクにハッシュが戻っています' : 'OK');
  check('リンクは事前入力クエリで作っている', /root\.Prefill\.build\(formUrl/.test(appSrc));
  check('ブックマークレットへはクリップボードで渡している',
    /clipboard\.writeText\(payload\)/.test(appSrc));
  check('URL の長さを画面に出している', /URL ' \+ link\.length/.test(appSrc));
  check('②と③が順に並んでいる', prefillAt > 0 && bmAt > prefillAt,
    `prefill@${prefillAt} / bookmarklet@${bmAt}`);

  // 調査記録が存在し、生き残っている仮説が書かれているか
  const doc = path.join(ROOT, 'docs', '事前入力の調査.md');
  check('調査記録がある', fs.existsSync(doc));
  if (fs.existsSync(doc)) {
    const d = fs.readFileSync(doc, 'utf8');
    check('反証済みの仮説が記録されている', /反証済みの仮説/.test(d));
    check('原因の確定が記録されている', /原因の確定/.test(d));
    // 種別ごとの書式は今回の決定打。ここが失われると同じ間違いを繰り返す
    check('値の書式（引用符）が記録されている', /ダブルクォートで囲む/.test(d));
    check('段階表示（分岐）が記録されている', /段階表示/.test(d));
  }
}

// Trusted Types 対応: フォーム上で動くコードに innerHTML があってはいけない
console.log('\nForms 上で動くコードの CSP 適合');
for (const [name, src] of [['調査ブックマークレット', probeSrc], ['フォーム記入エンジン', fillerSrc]]) {
  // Trusted Types が禁じる注入シンク。読み取り（outerHTML の参照）は問題ない。
  check(`${name}: innerHTML への代入なし`, !/\.innerHTML\s*=[^=]/.test(src));
  check(`${name}: outerHTML への代入なし`, !/\.outerHTML\s*=[^=]/.test(src));
  check(`${name}: insertAdjacentHTML なし`, !/insertAdjacentHTML/.test(src));
  check(`${name}: 外部スクリプト読み込みなし`, !/<script[^>]*src=/i.test(src) && !/document\.createElement\(['"]script/.test(src));
}

console.log(`\n${fail === 0 ? '全て通りました。' : fail + ' 件失敗しました。'}`);
process.exit(fail === 0 ? 0 : 1);
