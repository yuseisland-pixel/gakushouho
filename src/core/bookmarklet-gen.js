/* bookmarklet-gen.js — ブックマークレットと、そこへ渡す値の受け渡しを作る。
 *
 * ■ なぜ値を埋め込まないのか
 *   以前はロジックと値を1本のブックマークレットに固めていた。そのため
 *   **活動情報を変えるたびに登録し直しが必要**で、毎回申請内容が変わるこのツールでは
 *   手軽さを最も損なっていた。さらに氏名・メール・学籍番号がコードに焼き込まれるので、
 *   ブックマークレットを人に渡すと個人情報がそのまま漏れる。
 *
 * ■ いまの作り
 *   - ブックマークレットは **ロジックだけ**。一度登録すればずっと同じ。
 *     設定を変えても、大学がフォームを変えても登録し直し不要（設問マッピングも値と一緒に渡すため）。
 *   - 値と設問マッピングは **URL のハッシュ（#gsh=…）** で渡す。
 *     ハッシュはサーバに送信されないので、クエリ長の上限とも 404/414 とも無縁。
 *
 * ■ CSP
 *   forms.cloud.microsoft は script-src に 'strict-dynamic' を含むので外部読み込みは不可。
 *   ブックマークレットは自己完結でなければならない（だからロジックは丸ごと埋め込む）。
 */
(function (root) {
  'use strict';

  // ビルド時に filler.js の中身が差し込まれる
  var FILLER_SOURCE = '__FILLER_SOURCE__';

  /** コメントと行頭の余白を落として短くする。文字列リテラルは壊さない。 */
  function shrink(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(function (line) { return line.replace(/^\s+/, ''); })
      .filter(function (line) { return line !== '' && line.indexOf('//') !== 0; })
      .join('\n');
  }

  /** 一度登録すればずっと使えるブックマークレット。値は一切含まない。 */
  function buildStatic() {
    return 'javascript:' + encodeURIComponent('(function(){' + shrink(FILLER_SOURCE) + '})();');
  }

  /** UTF-8 を base64url にする。日本語を含むので btoa に直接渡してはいけない。 */
  function toBase64Url(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /**
   * ブックマークレットに渡す値を符号化する。
   * 設問マッピングは filler が使う項目だけに絞る（36択の choices は画面用なので載せない）。
   */
  function encodePayload(map, values) {
    var slim = {
      formVersion: map.formVersion,
      expectedCount: map.expectedCount,
      questions: (map.questions || []).map(function (q) {
        var o = { qid: q.qid, order: q.order, label: q.label, matchKey: q.matchKey, type: q.type, source: q.source };
        if (q.exactOnly) o.exactOnly = true;
        if (q.numeric) o.numeric = true;
        if (q.condition) o.condition = q.condition;
        return o;
      })
    };
    return toBase64Url(JSON.stringify({ v: 1, map: slim, values: values }));
  }

  /** 値を載せた「フォームを開く」リンク。ハッシュ以降はサーバに送られない。 */
  function buildFormLink(formUrl, map, values) {
    return formUrl + '#gsh=' + encodePayload(map, values);
  }

  function sizeInfo(url) {
    var kb = Math.round(url.length / 1024 * 10) / 10;
    return {
      文字数: url.length,
      サイズ: kb + ' KB',
      警告: url.length > 60000
        ? 'ブックマークレットが長すぎます。ブラウザによっては登録できません。'
        : null
    };
  }

  root.Bookmarklet = {
    buildStatic: buildStatic,
    encodePayload: encodePayload,
    buildFormLink: buildFormLink,
    sizeInfo: sizeInfo
  };
})(window.GSH = window.GSH || {});
