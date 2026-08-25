/* build.mjs — src/ を1枚の HTML に畳んで dist/ に出す。
 *
 * 依存パッケージなし。node tools/build.mjs で走る。
 *
 * なぜ1ファイルにするか: 配る相手が非エンジニアなので、「ダブルクリックで開く」以外の
 * 手順を作らないため。あわせて、file:// では ES モジュールが CORS で読めないので、
 * スクリプトはクラシックスクリプトとして連結する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
/* 版はここで上げる。画面右上に出るので、配った相手と「どれを使っているか」を
 * 突き合わせられる。同じ日に何度もビルドするので、日付だけだと区別が付かない。
 *   1.0.0 名簿生成のみ（フォーム入力は並び順頼りで、設問がズレていた）
 *   1.1.0 フォーム記入エンジンを設問ID方式に。17問中15問を自動入力
 *   1.1.1 事前入力の綴りを1通りに固定（URL 2641→1374文字）。落とす順を重要度順に
 *   1.2.0 （欠番）
 *         ブックマークレットから値を追い出し、# で渡す方式に（登録は一度きりで済む）
 *   1.3.0 事前入力の値の書式を修正（選択肢と日付はダブルクォートで囲む・日付は yyyy-MM-dd）。
 *         模擬フォームに段階表示を再現し、分岐が開くまで待つように記入エンジンを修正
 *   1.3.1 事前入力クエリを撤去（未サインイン時に AADSTS90015 でサインインごと失敗するため）。
 *         リンクは素のフォームURL＋ハッシュのみ。クリップボードにも値を置く
 *   1.4.0 【1.3.1 の訂正】URLを膨らませていたのは事前入力ではなくハッシュ（全体の80%）だった。
 *         ハッシュを外して事前入力を復活。1,437文字。値はクリップボードでブックマークレットへ
 *   1.5.0 【原因の確定】選択肢が入らなかったのは、調査ツールが選択肢の空白（U+3000・NBSP）を
 *         潰して保存していたため。事前入力は完全一致が要るので永久に一致しなかった。
 *         選択肢を value 属性から採り直し、49件すべてを正確な文字列に。
 *         条件付き設問（授業のときだけ出る6番）を追加し、設問数の決め打ち（17問）をやめて
 *         16〜18問の範囲に。これで正常時の「大学がフォームを変更した」誤警告が消えた。
 *         調査ツールから、フォームに書き込む「事前入力テスト」を削除（読むだけにした）
 *   1.5.1 バリデーション誤表示（セクション2が埋まっているのにセクション2への言及を含むメッセージ）を修正。
 *         初回設定ゲートを恒久的に撤去。全消去時の画面入力欄（未入力欄含む）の完全リセット化。
 */
const VERSION = '1.5.1';

const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');


/** コメントと空行を落とす。文字列リテラルを壊さないよう、行頭コメントとブロックコメントだけ。 */
function shrink(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/^\s+/, ''))
    .filter((l) => l !== '' && !l.startsWith('//'))
    .join('\n');
}

/** 置換値に $& や $1 が含まれていても壊れないよう、必ず関数形で置き換える。 */
function sub(src, token, value) {
  if (!src.includes(token)) throw new Error('置換対象 ' + token + ' が見つかりません');
  return src.replace(token, () => value);
}

function main() {
  const formMap = JSON.parse(read('form', 'form-map.json'));

  const fillerSrc = read('form', 'filler.js');
  const probeSrc = read('form', 'probe.js');
  const readbackSrc = read('form', 'readback.js');

  // bookmarklet-gen.js は filler の中身を内側に抱える
  const bmGen = sub(read('core', 'bookmarklet-gen.js'), "'__FILLER_SOURCE__'", JSON.stringify(fillerSrc));

  let app = read('app.js');
  app = sub(app, '__VERSION__', VERSION);
  // 同じ日に何度もビルドするので、日付だけでなく時刻まで入れる
  const builtAt = new Date().toLocaleString('sv-SE').slice(0, 16);   // 例 2026-08-24 22:38
  app = sub(app, '__BUILT_AT__', builtAt);
  app = sub(app, '__FORM_MAP__', JSON.stringify(formMap));
  app = sub(app, "'__PROBE_SOURCE__'", JSON.stringify('(function(){' + shrink(probeSrc) + '})();'));

  const scripts = [
    read('core', 'zip.js'),
    read('core', 'roster-xlsx.js'),
    read('core', 'store.js'),
    read('core', 'prefill.js'),
    read('core', 'save-target.js'),
    bmGen,
    app
  ].join('\n;\n');

  let html = read('index.html');
  html = sub(html, '<!-- __STYLE__ -->', '<style>\n' + read('style.css') + '\n</style>');
  html = sub(html, '<!-- __TEMPLATE__ -->', '');
  html = sub(html, '<!-- __SCRIPTS__ -->', '<script>\n' + scripts + '\n</script>');

  // 置換漏れの検出。__GSH_PAYLOAD__ は実行時に使う本物の識別子なので対象外。
  const TOKENS = ['__VERSION__', '__BUILT_AT__', '__FORM_MAP__',
    "'__PROBE_SOURCE__'", "'__FILLER_SOURCE__'",
    '<!-- __STYLE__ -->', '<!-- __SCRIPTS__ -->'];
  const leftovers = TOKENS.filter((t) => html.includes(t));
  if (leftovers.length) throw new Error('未置換のプレースホルダが残っています: ' + leftovers.join(', '));

  fs.mkdirSync(DIST, { recursive: true });
  // 版をファイル名に入れる。同名で上書きすると、渡した相手がどれが最新か分からなくなる
  const outPath = path.join(DIST, `学傷補入力支援_v${VERSION}.html`);
  fs.writeFileSync(outPath, html, 'utf8');

  // 調査用ブックマークレットは単体でも渡せるようにテキストで出す
  const probeUrl = 'javascript:' + encodeURIComponent('(function(){' + shrink(probeSrc) + '})();');
  // 版をファイル名に入れる。同名で上書きすると、渡した相手がどれが最新か分からなくなる。
  const probeVersion = (/版: '([^']+)'/.exec(probeSrc) || [, 'probe'])[1];
  const probeName = `フォーム調査ブックマークレット_${probeVersion}.txt`;
  fs.writeFileSync(
    path.join(DIST, probeName),
    [
      `学傷補・学賠補 活動届フォーム 調査用ブックマークレット（${probeVersion}）`,
      '',
      '━━ 登録（最初の1回だけ）━━',
      '1. ブックマークバーを表示する（Ctrl + Shift + B）',
      '2. 一番下の javascript: から始まる1行を全部コピーする',
      '3. ブックマークを新規作成し、名前は何でもよいので URL 欄にそれを貼る',
      '   ※ 貼った後、URL が javascript: から始まっているか確認してください。',
      '      ブラウザによっては先頭が自動で削られます（削られていたら手で足す）',
      '',
      '━━ 実行 ━━',
      '1. 活動届のフォームを開いて、サインインが済んだ状態にする（これが先）',
      '2. 登録したブックマークをクリック → 調査結果が画面に出る',
      '3. 「クリップボードにコピー」を押して、その内容を開発者に送る',
      '',
      '━━ 安全について ━━',
      '・フォームへの回答入力も送信も行いません。読み取るだけです。',
      '・ドロップダウンの選択肢まで読みたいときは「選択肢の採り直し」の版を使ってください。',
      '  こちらの版はドロップダウンを開きません。',
      '・送信ボタンは押さないでください。',
      '',
      '━━ ブックマークレット本体（この下の1行）━━',
      '',
      probeUrl,
      ''
    ].join('\n'),
    'utf8'
  );

  /* 選択肢の正確な文字列を採り直すための版。
   * ドロップダウン（活動主管箇所名・36件）は開かないと選択肢が読めないので、
   * 開閉を有効にした状態で走らせる。probe 側が必ず閉じ、
   * 開く前と後の表示を比べて回答が変わっていないかを自己検査する。 */
  const probeOpenUrl = 'javascript:' + encodeURIComponent(
    '(function(){window.GSH_PROBE_OPEN_DROPDOWN=true;' + shrink(probeSrc) + '})();');
  fs.writeFileSync(
    path.join(DIST, `選択肢の採り直し_${probeVersion}.txt`),
    [
      `選択肢の正確な文字列を採り直すブックマークレット（${probeVersion}）`,
      '',
      '━━ なぜ必要か ━━',
      '選択肢の事前入力は「フォームが持っている文字列と完全一致」でないと効きません。',
      '選択肢には全角スペース（U+3000）や改行なし空白（NBSP）が混ざっていて、',
      '目で書き写すと必ずずれます。この版は input の value 属性から正確に読み取ります。',
      '',
      '━━ 実行 ━━',
      '1. 活動届のフォームを開く',
      '   ※ 5番と8番に答えた状態（＝全17問が見えている状態）にしてから実行してください。',
      '     見えていない設問の選択肢は読み取れません。',
      '2. このブックマークをクリック',
      '3. 「クリップボードにコピー」を押して、その内容を開発者に送る',
      '',
      '━━ 安全について ━━',
      '・回答の入力も送信も行いません。読み取るだけです。',
      '・唯一の例外は「活動主管箇所名のドロップダウンを開いて選択肢を読み、閉じる」操作です。',
      '  選択肢のクリックはしないので、回答状態は変わりません。',
      '  開く前と閉じた後の表示を比べて、変わっていないかを自分で検査し、結果に出します。',
      '・送信ボタンは押さないでください。',
      '',
      '━━ ブックマークレット本体（この下の1行）━━',
      '',
      probeOpenUrl,
      ''
    ].join('\n'),
    'utf8'
  );

  // 読み取り専用ブックマークレット。実験の観測を目視でなく機械で取るための道具
  const readbackUrl = 'javascript:' + encodeURIComponent('(function(){' + shrink(readbackSrc) + '})();');
  fs.writeFileSync(
    path.join(DIST, '読み取りブックマークレット.txt'),
    [
      'フォームの現在の状態を読み取るブックマークレット',
      '',
      '【使い方】',
      '1. 下の javascript: から始まる1行を全部コピーする',
      '2. ブックマークを新規作成し、URL 欄にそれを貼る',
      '3. 調べたいフォームのページで、そのブックマークをクリックする',
      '4. 「何番に何が入っているか」の一覧が出るので、コピーして送る',
      '',
      '※ 読み取るだけです。入力も選択も送信も一切しません。',
      '※ ドロップダウンを開くこともしません（開くと回答が変わる事故があったため）。',
      '',
      readbackUrl,
      ''
    ].join('\n'),
    'utf8'
  );

  /* 4番の選択肢の正確な文字列を読み取り、テストURLをその場で作るブックマークレット。
   * 選択肢の空白（全角・二重）を人が目で写すのは無理なので、機械に読ませる。 */
  const q4Url = 'javascript:' + encodeURIComponent('(function(){' + shrink(read('form', 'q4test.js')) + '})();');
  fs.writeFileSync(
    path.join(DIST, '4番テスト.txt'),
    [
      '4番（加入を希望する補償制度）の事前入力を判定するブックマークレット',
      '',
      '【なぜ必要か】',
      '選択肢の事前入力は「フォームが持っている文字列と完全一致」でないと効きません。',
      'この選択肢には全角スペースや改行なし空白（NBSP）が混ざっていて、目で写すと必ずずれます。',
      'このツールは input の value 属性から正確な文字列を読み取り、テストURLを自動で作ります。',
      '',
      '【使い方】',
      '1. 下の javascript: の1行をコピーして、ブックマークに登録',
      '2. 活動届のフォームを開く',
      '3. そのブックマークをクリック',
      '4. **青いボタン**を押す（いま選ばれていない方の選択肢を送ります）',
      '5. 4番の丸がそちらに移ったかどうかを見る',
      '',
      '【なぜ「いま選ばれていない方」を送るのか】',
      'いま選ばれている方を送っても、もともとそうだっただけかもしれず、区別がつきません。',
      '選ばれていない方に変われば、事前入力が効いたと確定できます。',
      '',
      '【判定】',
      '  変わった            → 事前入力は効く。押したボタン（A=引用符あり / B=引用符なし）が正解',
      '  変わらない          → どちらの書式でも効いていない',
      '  1番に ZZ対照 も無い → リンク自体が届いていない',
      '',
      '※ 読み取りとURL表示だけです。入力も選択も送信もしません。',
      '',
      q4Url,
      ''
    ].join('\n'),
    'utf8'
  );

  const kb = (n) => Math.round(n / 1024 * 10) / 10 + ' KB';
  console.log('生成しました:');
  console.log('  ' + outPath + '  (' + kb(Buffer.byteLength(html)) + ')');
  console.log('  ' + path.join(DIST, probeName) + '  (ブックマークレット ' + kb(probeUrl.length) + ')');
  console.log('  ' + path.join(DIST, '読み取りブックマークレット.txt') + '  (' + kb(readbackUrl.length) + ')');
}

main();
