/* prefill.js — Microsoft Forms の事前入力 URL を組み立てる。
 * リンクは ?id=<フォームID>&<設問ID>=<値> という素のクエリ文字列。
 *
 * 実測で確定している制約（詳細は docs/事前入力の調査.md）:
 *
 * 1. 値の書式
 *    - テキスト/複数行テキスト: そのまま（?rXXXX=山田太郎）
 *    - 選択肢（ラジオ・ドロップダウン）: ダブルクォートで囲む（?rXXXX="1.国内 Domestic"）。
 *      囲まなくても通ることは実測済みだが、文書化されている形に合わせている
 *    - 日付: yyyy-MM-dd をダブルクォートで囲む（?rXXXX="2026-09-01"）。スラッシュ区切りは不可
 *
 * 2. 選択肢は完全一致が必要
 *    フォームが持つ文字列と1文字も違ってはいけない。全角スペース（U+3000）や
 *    NBSP（U+00A0）を \s で潰すと永久に一致しない（過去にこれで選択肢が全滅した）。
 *    正確な文字列は input[type=radio] の value 属性にあり、probe v3 がそこから採る。
 *    選択肢が入らないときは書式ではなくまず文字列の一致を疑うこと。
 *
 * 3. パラメータは設問順（order 昇順）に隙間なく並べる
 *    Forms は設問順に処理し、URL に無い設問に当たると以降を捨てる（実測）。
 *    値が空でもパラメータは出す。長すぎるときは途中を抜かず末尾側の候補から削る。
 *
 * 4. URL の長さ（AADSTS90015 対策）
 *    クエリが長すぎるとサインイン自体が失敗する。maxUrl 超過時は優先度の低い
 *    自由記述から外すが、分岐を開く設問（unlocksMore）は絶対に外さない。
 *    外れると後続の設問が画面に出てこなくなる。
 */
(function (root) {
  'use strict';

  // クエリ文字列の上限は IIS 系だと 2048 バイトのことがある。
  // 実測では全15問で約1,300文字なので通常は当たらない。
  var MAX_URL = 1900;

  /** 空白を + ではなく %20 にする。選択肢は完全一致が要るので + だと外れる。 */
  function enc(s) { return encodeURIComponent(String(s)); }

  /** 改行は %0A に寄せる。CRLF のままだと余計な空行が入ることがある。 */
  function normalizeValue(v) { return String(v == null ? '' : v).replace(/\r\n?/g, '\n'); }

  /* 設問の種別ごとに値の書式を整える。ここを間違えるとその設問は入らず、
   * それが分岐を開く設問だった場合、以降がまるごと画面に出なくなる。 */
  function formatValue(q, raw) {
    var v = normalizeValue(raw);
    if (v === '') return '';
    if (q.type === 'radio' || q.type === 'checkbox' || q.type === 'dropdown') {
      /* 選択肢はダブルクォートで囲む（囲まなくても効くが、文書化されている形に合わせる）。
       * 中身は **フォームが持っている文字列と1文字も違ってはいけない**。
       * 全角スペース・NBSP・二重スペースを潰すと一致しない。
       * form-map.json の choices は probe v3 が value 属性から採った生の文字列。 */
      return '"' + v + '"';
    }
    if (q.type === 'date') {
      // yyyy-MM-dd に正規化してから囲む（スラッシュ区切りでは受理されない）
      var m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v);
      if (m) v = m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
      return '"' + v + '"';
    }
    return v;   // テキスト・複数行テキストはそのまま
  }

  /**
   * @param formUrl フォームの URL（?id= を含む）
   * @param questions form-map の questions（order 昇順である必要はない。中で並べ替える）
   * @param resolve   function(question) -> 値（無ければ '' を返す）
   * @param opts      { prefix, maxUrl }
   */
  function build(formUrl, questions, resolve, opts) {
    opts = opts || {};
    var prefix = opts.prefix || '';
    var maxUrl = opts.maxUrl || MAX_URL;

    var u;
    try { u = new URL(formUrl); } catch (e) {
      return { url: null, included: [], skipped: [], usable: false, error: 'フォーム URL が不正です' };
    }
    var id = u.searchParams.get('id');
    if (!id) {
      return {
        url: null, included: [], skipped: [], usable: false,
        error: 'フォーム URL に id パラメータがありません。短縮 URL ではなく、フォームを開いた後の URL を使ってください。'
      };
    }
    var base = u.origin + u.pathname;   // route=shorturl などは落とす

    var ordered = questions.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });

    // 事前入力できない設問に達したら、そこから先は載せても無駄（打ち切られる）
    var run = [];
    var stoppedAt = null;
    for (var i = 0; i < ordered.length; i++) {
      var q = ordered[i];
      if (!q.qid || q.type === 'file') { stoppedAt = q; break; }
      run.push(q);
    }

    var skipped = [];
    ordered.slice(run.length).forEach(function (q) {
      skipped.push({
        label: q.label,
        reason: q.type === 'file' ? 'ファイル欄は事前入力できないため（手で添付します）'
          : 'ファイル欄より後ろにあるため事前入力が届きません'
      });
    });

    function compose(items) {
      var parts = ['id=' + enc(id)];
      items.forEach(function (q) {
        // 値が空でもパラメータは出す。抜くと以降が全部無視される
        parts.push(prefix + q.qid + '=' + enc(formatValue(q, resolve(q))));
      });
      return base + '?' + parts.join('&');
    }

    /* 長すぎるときは削る。ただし外す順番が重要。
     *   - **分岐を開く設問（unlocksMore）は絶対に外さない。**
     *     5番が外れると6〜8番が、8番が外れるとその先が画面に出てこなくなる
     *   - 選択肢は選び直しが面倒なので残す
     *   - 長い自由記述（活動内容・活動場所・科目名）から外す。手で書けばよいので
     * 外した項目はブックマークレットが埋める。 */
    function droppable(q) {
      if (q.unlocksMore) return false;
      return q.type === 'text' || q.type === 'textarea';
    }
    var current = run.slice();
    var url = compose(current);
    while (url.length > maxUrl) {
      // 外してよいものの中から、URL を一番食っているものを外す
      var cands = current.filter(droppable);
      if (!cands.length) break;   // これ以上は削れない（分岐設問と選択肢しか残っていない）
      var victim = cands.reduce(function (a, b) {
        return enc(formatValue(b, resolve(b))).length > enc(formatValue(a, resolve(a))).length ? b : a;
      });
      current = current.filter(function (q) { return q !== victim; });
      skipped.push({ label: victim.label, reason: 'URL を短くするため（ブックマークレットで埋まります）' });
      url = compose(current);
    }

    return {
      url: url,
      included: current.map(function (q) { return q.label; }),
      skipped: skipped,
      usable: current.length > 0,
      length: url.length,
      stoppedAt: stoppedAt ? stoppedAt.label : null,
      prefix: prefix
    };
  }

  root.Prefill = { build: build, MAX_URL: MAX_URL, encode: enc };
})(window.GSH = window.GSH || {});
