/* prefill.js — Microsoft Forms の事前入力 URL を組み立てる。
 *
 * ★ URL の長さについて（AADSTS90015）
 *
 *   `AADSTS90015: Requested query string is too long` が出たことがある。
 *   このとき内訳を測ったら、URL 7,089文字のうち **5,652文字（80%）がハッシュ**
 *   （ブックマークレットに値を渡す `#gsh=`）で、事前入力クエリは1,292文字だった。
 *   膨らませていたのはハッシュのほうだった。
 *
 *   いまはハッシュを載せず事前入力クエリだけにしているので 1,437文字。
 *   それでも長い場合に備えて、`maxUrl` を下げると優先度の低い設問から外れる。
 *   ただし**分岐を開く設問（unlocksMore）は絶対に外さない**。
 *   ここが外れると後続の設問が画面に出てこなくなり、事前入力どころではなくなる。
 *
 * ★ 「1〜3番しか入らない」の真因（2026-08-25 に実機で決着）
 *
 *   原因は書式でもキャッシュでもURL長でもなく、**選択肢の文字列が壊れていたこと**だった。
 *   probe.js が選択肢を読むときに `label.replace(/\s+/g, ' ')` をしていて、
 *   JS の \s が全角スペース（U+3000）と改行なし空白（U+00A0）にもマッチするため、
 *   form-map.json に潰れた文字列が入っていた。
 *
 *     実物: 1.[U+3000]学傷補のみ加入[U+00A0][半角]Register only for “Compensation for Injury”
 *     保存: 1.[半角]学傷補のみ加入[半角]Register only for “Compensation for Injury”
 *
 *   事前入力は完全一致が要るので、選択肢は一つも一致しなかった。
 *   テキスト（1〜3番）は利用者の入力値をそのまま送るので無傷 → だから毎回きっちり1〜3。
 *   5番（ラジオ）が入らないので段階表示が開かず、6番以降は画面にすら出なかった。
 *
 *   正確な文字列は **input[type=radio] の value 属性**（と祖先の data-automation-value）にある。
 *   表示テキストは整形の影響を受けるので使わない。probe v3 はここから採る。
 *
 * ★ 値の書式（実測）
 *
 *   | 種別 | 書式 | 例（エンコード前） |
 *   |------|------|-------------------|
 *   | 単一行/複数行テキスト | そのまま | `?rXXXX=山田太郎` |
 *   | **選択肢（ラジオ・ドロップダウン）** | ダブルクォートで囲む | `?rXXXX="1.国内 Domestic"` |
 *   | **日付** | yyyy-MM-dd をダブルクォートで囲む | `?rXXXX="2026-09-01"` |
 *   | 評価・NPS | 数値そのまま | `?rXXXX=3` |
 *
 *   実測メモ：4番のラジオで**引用符ありとなしの両方が効いた**。囲まなくても通る。
 *   文書化されている形に合わせて囲む方を採用している。**効かない原因は書式ではない。**
 *   もし選択肢が入らなくなったら、まず疑うのは書式ではなく **文字列の一致**。
 *   詳細は docs/事前入力の調査.md。
 *
 * 事前入力リンクは ?id=<フォームID>&<設問ID>=<値> という素のクエリ文字列。
 *
 * ■ 実機で分かったこと（2026-08-24）
 *
 *   1) 事前入力は「効く」。v1.1.0 のリンクで既存の下書きが上書きされた。
 *
 *   2) ただし **設問順に並んでいないと途中で打ち切られる**。
 *      観測:
 *        - v1.1.0: 設問順に並べたが4番だけURL長で脱落 → **1,2,3 が入り、4番の手前で停止**
 *        - v1.1.1: 1,5,11,13 と飛び飛びに送った → **1問も入らない**
 *      これを一つで説明できるのが「設問順に処理し、URLに無い設問に当たったら以降を捨てる」。
 *
 *   だから、この実装では次を守る。
 *     - 設問順（order 昇順）に並べる
 *     - **値が空でもパラメータを出す**（穴を空けない）
 *     - 事前入力できない設問（ファイルアップロード）に達したら、そこで打ち切る
 *     - URL が長すぎるときは **末尾から** 削る。途中を抜くと以降が全部死ぬので、
 *       「重要度の低いものを抜く」方式は**この仕様のもとでは有害**
 *
 *   3) 綴りは素の設問ID（`r829848…`）。2通りを両方送るとパラメータ数が倍になり、
 *      打ち切りを早めるだけで害しかない。二度とやらない。
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
