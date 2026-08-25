/* q4test.js — 4番（加入を希望する補償制度）の選択肢を、フォームから
 * **一切加工せずに** 取り出して、事前入力のテストURLをその場で組み立てる。
 *
 * ■ なぜ必要か
 *   調査ツールが選択肢を読むときに `label.replace(/\s+/g, ' ')` で空白を潰していた。
 *   JS の \s は全角スペース（U+3000）にも改行なし空白（U+00A0）にもマッチするので、
 *     「1.［U+3000］学傷補のみ加入［U+00A0］［半角］Register only …」
 *   が
 *     「1.［半角］学傷補のみ加入［半角］Register only …」
 *   に化けていた。事前入力は完全一致が要るので、これでは永久に一致しない。
 *
 * ■ 正確な文字列の在り処（実機の HTML で確認）
 *     <span data-automation-id="radio" data-automation-value="1. 学傷補のみ加入&nbsp; Register…">
 *       <input type="radio" value="1. 学傷補のみ加入&nbsp; Register…" aria-labelledby="…">
 *   **input の value 属性が正本。** Forms が選択肢定義から出しているので、
 *   周囲のテキストを巻き込む危険がない。aria-label は空だった。
 *
 * ■ このスクリプトがすること
 *   読み取りと、テストURLの表示だけ。入力も選択も送信もしない。
 *
 * ■ なぜ「2番」を送るボタンがあるのか
 *   1番を送って1番が選ばれても、**もともと1番が選ばれていただけ**かもしれない。
 *   いま選ばれていない方を送って、それに変われば事前入力が効いたと確定できる。
 */
(function () {
  'use strict';

  var Q1 = 'r829848c24e95420e888e243416adbd6e';   // 1.申請者氏名（対照用のテキスト設問）
  var Q4 = 'ra7268c22275a48a0b642fb9044c7026c';   // 4.加入を希望する補償制度（ラジオ）

  function el(tag, style, txt) {
    var n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (txt != null) n.textContent = txt;
    return n;
  }

  /** 全ての空白と非ASCIIを見える形にする。空白の種類を目で確かめるため。 */
  function reveal(s) {
    return String(s).replace(/[^\x21-\x7E]/g, function (c) {
      var code = c.charCodeAt(0);
      if (c === ' ') return '␠';                    // 半角スペース
      if (c === '　') return '［全角空白］';
      if (c === ' ') return '［NBSP］';
      if (c === '\t') return '␉';
      if (c === '\n') return '␊';
      return code < 0x80 ? '\\x' + code.toString(16) : c;
    });
  }

  function ownerOf(qid) {
    var n = document.getElementById('QuestionId_' + qid);
    return (n && n.closest('[data-automation-id="questionItem"],[role="listitem"]')) || n;
  }

  var q4 = ownerOf(Q4);
  if (!q4) { alert('4番の設問が見つかりません。活動届のフォームのページで実行してください。'); return; }

  /* 選択肢の文字列がどこに入っているかはフォームの作りで変わる。
   * 決め打ちせず候補を全部出し、確度の高い順に採る。どれも trim も replace もしない。 */
  function candidatesOf(n) {
    var c = [];
    var add = function (name, val) {
      if (val == null || val === '') return;
      for (var i = 0; i < c.length; i++) if (c[i].value === val) return;   // 同じ文字列は1回だけ
      c.push({ source: name, value: val });
    };
    // 確度の高い順に並べる。先頭が採用される
    add('value 属性【正本】', n.getAttribute('value'));
    var av = n.closest('[data-automation-value]');
    add('data-automation-value', av && av.getAttribute('data-automation-value'));
    var lb = n.getAttribute('aria-labelledby');
    if (lb) {
      lb.split(/\s+/).forEach(function (id) {
        var t = document.getElementById(id);
        add('aria-labelledby → #' + id, t && t.textContent);
      });
    }
    add('aria-label', n.getAttribute('aria-label'));
    var lab = n.closest('label');
    add('closest(label)', lab && lab.textContent);
    add('自分の textContent', n.textContent);
    add('親', n.parentElement && n.parentElement.textContent);
    return c;
  }

  var nodes = Array.prototype.slice.call(q4.querySelectorAll('[role="radio"],input[type="radio"]'));
  if (!nodes.length) { alert('4番の選択肢が読み取れませんでした。'); return; }

  function isChecked(n) {
    return n.getAttribute('aria-checked') === 'true' || n.checked === true;
  }

  var opts = nodes.map(function (n) {
    return {
      node: n,
      checked: isChecked(n),
      cands: candidatesOf(n),
      html: n.parentElement ? n.parentElement.outerHTML : n.outerHTML
    };
  });

  /** 候補の先頭（＝いちばん確度の高い取り方）を採る。 */
  function pick(o) { return o.cands.length ? o.cands[0].value : ''; }

  var checkedIndex = -1;
  opts.forEach(function (o, i) { if (o.checked && checkedIndex === -1) checkedIndex = i; });

  var formId = (/[?&]id=([^&]+)/.exec(location.search) || [])[1] || '';
  var base = location.origin + location.pathname;

  function urlFor(optIndex, quoted) {
    var value = pick(opts[optIndex]);
    if (!value) return null;
    return base + '?id=' + formId
      + '&' + Q1 + '=' + encodeURIComponent('ZZ対照')
      + '&' + Q4 + '=' + encodeURIComponent(quoted ? '"' + value + '"' : value);
  }

  /* いま選ばれていない選択肢を送るのが本命。
   * 選ばれている方を送っても「もともとそうだった」と区別がつかない。 */
  var targetIndex = checkedIndex === 0 ? 1 : 0;
  if (targetIndex >= opts.length) targetIndex = 0;

  var lines = [];
  lines.push('=== いまの選択状態 ===');
  lines.push('');
  lines.push(checkedIndex === -1
    ? '  どれも選ばれていません'
    : '  ' + (checkedIndex + 1) + '番が選ばれています');
  lines.push('  → 判定に使うのは ' + (targetIndex + 1) + '番（いま選ばれていない方）です。');
  lines.push('     これに変われば、事前入力が効いたと確定します。');
  lines.push('');
  lines.push('=== 4番の選択肢を、加工せずに読み取った結果 ===');
  lines.push('');
  opts.forEach(function (o, i) {
    lines.push('[選択肢 ' + (i + 1) + ']' + (o.checked ? '  ← いま選ばれている' : '') + '  採用したのは ★ の行');
    if (!o.cands.length) {
      lines.push('  文字列が1つも見つかりませんでした');
    } else {
      o.cands.forEach(function (c, k) {
        lines.push('  ' + (k === 0 ? '★' : '　') + ' ' + c.source + ' [' + c.value.length + '文字]');
        lines.push('      ' + reveal(c.value));
      });
    }
    lines.push('  HTML: ' + o.html.replace(/\s+/g, ' ').slice(0, 400));
    lines.push('');
  });
  lines.push('※ ␠=半角スペース ［全角空白］=U+3000 ［NBSP］=改行なし空白');
  lines.push('');
  lines.push('=== テストURL（1番の設問に ZZ対照 が入れば、リンク自体は効いている）===');
  lines.push('');
  if (!pick(opts[0])) {
    lines.push('★ 選択肢の文字列が取れていないので、テストURLは作れません。');
    lines.push('  上の HTML: の行を開発者に送ってください。');
    lines.push('');
  } else {
    [
      ['A' + (targetIndex + 1), targetIndex, true, '★本命：' + (targetIndex + 1) + '番・引用符あり'],
      ['B' + (targetIndex + 1), targetIndex, false, '★本命：' + (targetIndex + 1) + '番・引用符なし'],
      ['A' + (1 - targetIndex + 1), 1 - targetIndex, true, '参考：' + (1 - targetIndex + 1) + '番・引用符あり'],
      ['B' + (1 - targetIndex + 1), 1 - targetIndex, false, '参考：' + (1 - targetIndex + 1) + '番・引用符なし']
    ].forEach(function (t) {
      var u = urlFor(t[1], t[2]);
      if (!u) return;
      lines.push('【' + t[0] + '】' + t[3]);
      lines.push(u);
      lines.push('');
    });
  }
  lines.push('判定：');
  lines.push('  ' + (targetIndex + 1) + '番に変わった → 事前入力は効く。押したボタンの書式が正解');
  lines.push('  変わらない（' + (checkedIndex + 1) + '番のまま）→ どちらの書式でも効いていない');
  lines.push('  1番の設問に ZZ対照 も入らない → リンク自体が届いていない');

  var out = lines.join('\n');
  console.log(out);

  var old = document.getElementById('gsh-q4test');
  if (old) old.remove();
  var wrap = el('div', [
    'position:fixed', 'inset:4% 4%', 'z-index:2147483647', 'background:#fff', 'color:#111',
    'border:2px solid #333', 'border-radius:10px', 'padding:14px', 'display:flex',
    'flex-direction:column', 'gap:10px', 'font:14px/1.5 system-ui,sans-serif',
    'box-shadow:0 10px 50px rgba(0,0,0,.45)'
  ].join(';'));
  wrap.id = 'gsh-q4test';
  wrap.appendChild(el('strong', 'font-size:15px',
    '4番の選択肢の正確な文字列とテストURL（読み取っただけです）'));
  wrap.appendChild(el('div', 'font-size:13px;color:#444',
    checkedIndex === -1
      ? 'いまはどれも選ばれていません。どちらを押しても判定できます。'
      : 'いま ' + (checkedIndex + 1) + '番が選ばれています。青いボタン（' + (targetIndex + 1) + '番）を押して、変わるかどうかを見てください。'));

  var ta = document.createElement('textarea');
  ta.value = out;
  ta.setAttribute('style', 'flex:1;width:100%;font:12px/1.45 ui-monospace,Consolas,monospace;white-space:pre;box-sizing:border-box;border:1px solid #bbb;border-radius:4px;padding:8px');
  wrap.appendChild(ta);

  var row = el('div', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap');
  var msg = el('span', 'font-size:12px;color:#2e7d32', '');

  var PRIMARY = 'padding:8px 14px;cursor:pointer;background:#1565c0;color:#fff;border:1px solid #1565c0;border-radius:6px';
  var PLAIN = 'padding:8px 14px;cursor:pointer';

  function mkBtn(label, optIndex, quoted, primary) {
    var b = el('button', primary ? PRIMARY : PLAIN, label);
    var u = urlFor(optIndex, quoted);
    if (!u) { b.disabled = true; return b; }
    b.onclick = function () { location.href = u; };
    return b;
  }

  row.appendChild(mkBtn('【A' + (targetIndex + 1) + '】' + (targetIndex + 1) + '番・引用符あり', targetIndex, true, true));
  row.appendChild(mkBtn('【B' + (targetIndex + 1) + '】' + (targetIndex + 1) + '番・引用符なし', targetIndex, false, true));
  row.appendChild(mkBtn('参考：' + (2 - targetIndex) + '番・引用符あり', 1 - targetIndex, true, false));
  row.appendChild(mkBtn('参考：' + (2 - targetIndex) + '番・引用符なし', 1 - targetIndex, false, false));

  var copy = el('button', PLAIN, '結果をコピー');
  copy.onclick = function () {
    ta.focus(); ta.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(out).then(
        function () { msg.textContent = 'コピーしました'; },
        function () { msg.textContent = 'Ctrl+A → Ctrl+C でコピーしてください'; });
    }
  };
  var close = el('button', PLAIN, '閉じる');
  close.onclick = function () { wrap.remove(); };

  row.appendChild(copy);
  row.appendChild(close);
  if (!pick(opts[0])) {
    msg.textContent = '選択肢の文字列が取れていません。結果をコピーして送ってください。';
    msg.setAttribute('style', 'font-size:12px;color:#b00');
  }
  row.appendChild(msg);
  wrap.appendChild(row);
  document.body.appendChild(wrap);
})();
