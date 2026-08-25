/* readback.js — フォームの現在の回答状態を機械可読に読み出す。読み取り専用。
 *
 * これまで「何番まで入りましたか」を目視で数えてもらっていたが、
 * 17問をスクロールしながら数えるのは間違えやすく、こちらも検証しようがなかった。
 * この道具で観測から人間の判断を外す。
 *
 * ■ 絶対にやらないこと
 *   入力・選択・ドロップダウンを開く・送信。**一切の書き込みをしない。**
 *   （調査プローブがドロップダウンを開いて回答を書き換えてしまった事故があったため、
 *     ここでは開く処理そのものを持たない）
 *
 * ■ CSP
 *   forms.cloud.microsoft は require-trusted-types-for 'script' を返すので innerHTML は使えない。
 */
(function () {
  'use strict';

  function el(tag, style, txt) {
    var n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (txt != null) n.textContent = txt;
    return n;
  }
  function text(n) { return n ? String(n.textContent || '').replace(/\s+/g, ' ').trim() : ''; }

  function questionNodes() {
    var sels = ['[data-automation-id="questionItem"]', '[role="listitem"]', '.office-form-question'];
    for (var i = 0; i < sels.length; i++) {
      var f = document.querySelectorAll(sels[i]);
      if (f.length) return Array.prototype.slice.call(f);
    }
    return [];
  }

  function headingOf(q) {
    var c = q.querySelector('[data-automation-id="questionTitle"]')
      || q.querySelector('[class*="questionTitle"]')
      || q.querySelector('h1,h2,h3,h4,legend');
    // 「1.申請者氏名単一行テキスト.」から種別の読み上げ文言を落として短くする
    return text(c).replace(/(単一行テキスト|複数行テキスト|単一選択|複数選択|日付|ファイルのアップロード)\.?$/, '')
      .replace(/\(非匿名の質問\)/, '').trim();
  }

  var QID = /^QuestionId_(r[0-9a-f]{32})$/;
  function qidOf(q) {
    var own = q.id && QID.exec(q.id);
    if (own) return own[1];
    var kids = q.querySelectorAll('[id^="QuestionId_"]');
    for (var i = 0; i < kids.length; i++) {
      var m = QID.exec(kids[i].id);
      if (m) return m[1];
    }
    return null;
  }

  /** 現在の回答を読む。要素には一切触れない。 */
  function valueOf(q) {
    var file = q.querySelector('input[type="file"]');
    if (file) return { type: 'file', value: file.files ? file.files.length + ' 件添付' : '(不明)' };

    var checked = q.querySelector('[role="radio"][aria-checked="true"],[role="checkbox"][aria-checked="true"],input:checked');
    if (checked) {
      return {
        type: 'choice',
        value: checked.getAttribute('aria-label') || text(checked.closest('label') || checked.parentElement)
      };
    }
    if (q.querySelector('[role="radio"],input[type="radio"]')) return { type: 'choice', value: '' };

    var inp = q.querySelector('input:not([type="radio"]):not([type="checkbox"]):not([type="file"]), textarea');
    if (inp) {
      // 日付欄・ドロップダウンもここに来る。開かずに現在値だけ読む
      var kind = inp.getAttribute('role') === 'combobox' ? 'date/combobox' : inp.tagName.toLowerCase();
      return { type: kind, value: inp.value || '' };
    }

    var dd = q.querySelector('[aria-haspopup="listbox"],[role="combobox"]');
    if (dd) {
      /* 未選択のドロップダウンは「選択してください」のようなプレースホルダを表示する。
       * これを値として数えると「入っている」と誤判定してしまう。
       * プレースホルダ要素が存在する場合、そのテキストが「選択してください」なら未選択。 */
      var ph = dd.querySelector('[id$="_placeholder_content"]');
      var isUnselected = ph && text(ph) === '選択してください';
      return { type: 'dropdown', value: isUnselected ? '' : text(dd) };
    }

    return { type: 'unknown', value: '' };
  }

  var nodes = questionNodes();
  var lines = [];
  var filled = 0;

  lines.push('=== 読み取り結果 ===');
  lines.push('日時: ' + new Date().toISOString());
  lines.push('URL長: ' + location.href.length + ' 文字');
  lines.push('設問数: ' + nodes.length);
  lines.push('');

  nodes.forEach(function (q, i) {
    var v = valueOf(q);
    var has = v.value !== '' && v.value !== '0 件添付';
    if (has) filled++;
    lines.push(
      String(i + 1).padStart(2) + '. ' + (has ? '● ' : '○ ') +
      headingOf(q).slice(0, 28).padEnd(28) + ' [' + v.type + '] ' +
      (has ? v.value : '(空)')
    );
  });

  lines.push('');
  lines.push('入っている設問: ' + filled + ' / ' + nodes.length);
  // 連続して入っている先頭からの本数。「何問目で止まったか」が一目で分かる
  var run = 0;
  for (var i = 0; i < nodes.length; i++) {
    var v = valueOf(nodes[i]);
    if (v.value !== '' && v.value !== '0 件添付') run++; else break;
  }
  lines.push('先頭から連続で入っている数: ' + run);

  var out = lines.join('\n');
  console.log(out);

  var old = document.getElementById('gsh-readback');
  if (old) old.remove();
  var wrap = el('div', [
    'position:fixed', 'inset:4% 4%', 'z-index:2147483647', 'background:#fff', 'color:#111',
    'border:2px solid #333', 'border-radius:10px', 'padding:14px', 'display:flex',
    'flex-direction:column', 'gap:10px', 'font:14px/1.5 system-ui,sans-serif',
    'box-shadow:0 10px 50px rgba(0,0,0,.45)'
  ].join(';'));
  wrap.id = 'gsh-readback';
  wrap.appendChild(el('strong', 'font-size:15px', 'フォームの現在の状態（読み取っただけ。何も変更していません）'));

  var ta = document.createElement('textarea');
  ta.value = out;
  ta.setAttribute('style', 'flex:1;width:100%;font:12px/1.45 ui-monospace,Consolas,monospace;white-space:pre;box-sizing:border-box;border:1px solid #bbb;border-radius:4px;padding:8px');
  wrap.appendChild(ta);

  var row = el('div', 'display:flex;gap:8px;align-items:center');
  var msg = el('span', 'font-size:12px;color:#2e7d32', '');
  var copy = el('button', 'padding:8px 16px;cursor:pointer', 'コピー');
  copy.onclick = function () {
    ta.focus(); ta.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(out).then(
        function () { msg.textContent = 'コピーしました'; },
        function () { msg.textContent = 'Ctrl+A → Ctrl+C でコピーしてください'; });
    } else { msg.textContent = 'Ctrl+A → Ctrl+C でコピーしてください'; }
  };
  var close = el('button', 'padding:8px 16px;cursor:pointer', '閉じる');
  close.onclick = function () { wrap.remove(); };
  row.appendChild(copy); row.appendChild(close); row.appendChild(msg);
  wrap.appendChild(row);
  document.body.appendChild(wrap);
})();
