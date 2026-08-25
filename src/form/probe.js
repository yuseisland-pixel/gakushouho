/* probe.js — Microsoft Forms の設問構造を吸い出す調査用ブックマークレット（v3）。
 *
 * このスクリプトは読み取りだけをする。値の入力も送信も一切しない。
 * 例外は「ドロップダウンを開いて選択肢を読み、Escape で閉じる」操作だけで、
 * 選択肢のクリックはしないので回答状態は変わらない。
 *
 * ■ 選択肢は属性から採る（v3 の要点）
 *   事前入力は「フォームが持っている文字列と完全一致」でないと効かない。
 *   表示テキストから採って空白を潰していたせいで、選択肢の事前入力が
 *   一つも効かなかった（2026-08-25 に判明）。正本は input[type=radio] の value 属性。
 *
 * ■ 以前あった「事前入力テスト」は削除した（2026-08-25）
 *   設問IDの綴り・日付書式・選択肢の書式を総当たりする2段階の実験を積んでいたが、
 *   すべて決着したので役目を終えた。この実験は ZZ 値を実際にフォームへ書き込むため、
 *   利用者の下書きを汚す副作用があった（実際に汚した）。調査ツールは読むだけにする。
 *
 * ■ CSP の制約（実測 2026-08-24）
 *   forms.cloud.microsoft は require-trusted-types-for 'script' を返すため、
 *   innerHTML への代入は TypeError で落ちる。UI は createElement と textContent だけで組む。
 *   （outerHTML の「読み取り」は sink ではないので問題ない）
 */
(function () {
  'use strict';

  var WAIT = 700;

  // ---------- 小道具 ----------
  function el(tag, style, txt) {
    var n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (txt != null) n.textContent = txt;
    return n;
  }
  /* 空白を潰した版。見出しの照合や人が読む用。選択肢には使わないこと（下の rawText を使う）。 */
  function text(node) {
    return node ? String(node.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }
  /* 加工しない版。事前入力は完全一致が要るので、選択肢はこちらで採る。 */
  function rawText(node) {
    return node ? String(node.textContent || '') : '';
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function attrs(node, names) {
    var out = {};
    if (!node) return out;
    names.forEach(function (n) {
      var v = node.getAttribute ? node.getAttribute(n) : null;
      if (v != null) out[n] = v;
    });
    return out;
  }
  /** 引用符などの非 ASCII を \u 形式で併記する。完全一致が要る選択肢の照合用。 */
  function escapeNonAscii(s) {
    return String(s).replace(/[^\x20-\x7E]/g, function (c) {
      return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
    });
  }
  /** 要素の骨格だけを浅く出す。outerHTML 全部だと長すぎるため。 */
  function skeleton(node, depth) {
    if (!node || depth < 0) return null;
    var rec = {
      tag: node.tagName ? node.tagName.toLowerCase() : String(node.nodeName),
      role: node.getAttribute ? node.getAttribute('role') : null,
      automationId: node.getAttribute ? node.getAttribute('data-automation-id') : null,
      id: node.id || null,
      cls: node.className && typeof node.className === 'string' ? node.className.slice(0, 60) : null
    };
    Object.keys(rec).forEach(function (k) { if (rec[k] == null) delete rec[k]; });
    var kids = node.children ? Array.prototype.slice.call(node.children, 0, 8) : [];
    if (kids.length && depth > 0) {
      rec.children = kids.map(function (c) { return skeleton(c, depth - 1); });
    }
    return rec;
  }

  // ---------- 設問の走査 ----------
  function questionNodes() {
    var sels = ['[data-automation-id="questionItem"]', '[role="listitem"]', '.office-form-question'];
    for (var i = 0; i < sels.length; i++) {
      var f = document.querySelectorAll(sels[i]);
      if (f.length) return { selector: sels[i], nodes: Array.prototype.slice.call(f) };
    }
    return { selector: null, nodes: [] };
  }

  function headingOf(q) {
    var c = q.querySelector('[data-automation-id="questionTitle"]')
      || q.querySelector('[class*="questionTitle"]')
      || q.querySelector('h1,h2,h3,h4,legend');
    if (c) return text(c);
    var clone = q.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('input,textarea,button,select'), function (n) { n.remove(); });
    return text(clone).slice(0, 160);
  }

  /* 日付欄の判定。
   * Forms の日付設問は <input role="combobox"> として描画される。これを見落として
   * ドロップダウンと誤判定し、本番フォームの日付ピッカーを開いてしまったことがある。
   * ドロップダウンより先に、確実にここで捕まえる。 */
  function dateField(q) {
    var cands = q.querySelectorAll('input');
    for (var i = 0; i < cands.length; i++) {
      var n = cands[i];
      var ph = n.getAttribute('placeholder') || '';
      var al = n.getAttribute('aria-label') || '';
      var cls = String(n.className || '');
      if (/yyyy|YYYY|年.*月.*日/.test(ph) || /日付|Date/.test(al) || /ms-TextField/.test(cls)) return n;
    }
    return null;
  }

  function typeOf(q) {
    if (q.querySelector('input[type="file"]')) return 'file';
    if (q.querySelector('[role="radio"],input[type="radio"]')) return 'radio';
    if (q.querySelector('[role="checkbox"],input[type="checkbox"]')) return 'checkbox';
    if (dateField(q)) return 'date';            // dropdown より先に判定する
    if (dropdownTrigger(q)) return 'dropdown';
    if (q.querySelector('textarea')) return 'textarea';
    if (q.querySelector('input')) return 'text';
    return 'unknown';
  }

  /* ドロップダウンのトリガ。日付欄は上で除外済みなので、ここで role="combobox" を
   * 見ても日付を掴むことはない。念のため input は除く。 */
  function dropdownTrigger(q) {
    var cands = q.querySelectorAll('[role="combobox"],[aria-haspopup="listbox"],[class*="ms-Dropdown"]');
    for (var i = 0; i < cands.length; i++) {
      if (cands[i].tagName.toLowerCase() !== 'input') return cands[i];
    }
    return null;
  }

  /* 選択肢の正確な文字列を採る。**表示テキストより属性を優先し、空白は絶対に潰さない。**
   *
   * 事前入力（?<qid>="選択肢"）は完全一致でないと効かない。
   * 以前ここで label.replace(/\s+/g, ' ') をしていたため、
   *   「1.［U+3000］学傷補のみ加入［U+00A0］［半角］Register only …」
   * が
   *   「1.［半角］学傷補のみ加入［半角］Register only …」
   * に化けて form-map.json に入り、選択肢の事前入力が一つも効かなかった。
   * （JS の \s は U+3000 にも U+00A0 にもマッチする。）
   *
   *
   * 実機の4番はこうなっていた：
   *   <span data-automation-id="radio" data-automation-value="1. 学傷補のみ加入&nbsp; Register…">
   *     <input type="radio" value="1. 学傷補のみ加入&nbsp; Register…" aria-labelledby="…">
   *     <span id="…">…</span>
   * aria-label は空。value 属性が Forms 側の正本で、周囲のテキストを巻き込む危険もない。
   * 表示テキストは整形の影響を受けるので、事前入力（完全一致が要る）には使わない。
   *
   * @returns {source, value} 採った文字列と、どこから採ったか
   */
  function exactChoiceText(n) {
    var v = n.getAttribute('value');
    if (v) return { source: 'value', value: v };
    var av = n.closest && n.closest('[data-automation-value]');
    if (av) {
      var a = av.getAttribute('data-automation-value');
      if (a) return { source: 'data-automation-value', value: a };
    }
    var lb = n.getAttribute('aria-labelledby');
    if (lb) {
      var parts = [];
      lb.split(/\s+/).forEach(function (id) {
        var t = document.getElementById(id);
        if (t) parts.push(rawText(t));
      });
      var joined = parts.join('');
      if (joined) return { source: 'aria-labelledby', value: joined };
    }
    var aria = n.getAttribute('aria-label');
    if (aria) return { source: 'aria-label', value: aria };
    var lab = n.closest && n.closest('label');
    if (lab && rawText(lab)) return { source: 'label', value: rawText(lab) };
    if (rawText(n)) return { source: 'textContent', value: rawText(n) };
    var p = n.parentElement;
    if (p && rawText(p)) return { source: '親のtextContent', value: rawText(p) };
    return { source: null, value: '' };
  }

  function inlineOptions(q) {
    var raw = [], norm = [], src = [];
    Array.prototype.forEach.call(
      q.querySelectorAll('[role="radio"],[role="checkbox"],input[type="radio"],input[type="checkbox"]'),
      function (n) {
        var got = exactChoiceText(n);
        if (!got.value) return;
        var key = got.value.replace(/\s+/g, ' ').trim();
        if (!key || norm.indexOf(key) !== -1) return;
        raw.push(got.value);    // 加工なし。これを事前入力に使う
        norm.push(key);         // 潰した版。人が読む・照合するため
        src.push(got.source);   // どこから採ったか（後で追えるように）
      }
    );
    return { raw: raw, normalized: norm, sources: src };
  }

  /* 設問IDの採取。
   * 前の版は「最初に見つかった子孫の id」を拾っていて、QuestionId_ 以外を掴む恐れがあった。
   * ここでは「要素自身の id」と「配下の QuestionId_* 全部」を分けて報告し、
   * どちらを信用してよいかを判断できるようにする。 */
  // 設問IDは「QuestionId_ + r + ダッシュ無しGUID」の形。
  // ドロップダウンのトリガのように QuestionId_xxx-trigger という派生IDも存在するので、
  // 形が完全に一致するものだけを設問IDとして認める。
  var QID_PATTERN = /^QuestionId_(r[0-9a-f]{32})$/;

  function idsOf(q) {
    var own = q.id || null;
    var descendants = Array.prototype.slice.call(q.querySelectorAll('[id^="QuestionId_"]'))
      .map(function (n) { return n.id; });

    var ownMatch = own && QID_PATTERN.exec(own);
    var validDescendants = descendants.filter(function (d) { return QID_PATTERN.test(d); });

    // 要素自身の id を最優先する。無いときだけ子孫を見て、一意に決まる場合のみ採用。
    var qid = null;
    if (ownMatch) qid = ownMatch[1];
    else if (validDescendants.length === 1) qid = QID_PATTERN.exec(validDescendants[0])[1];

    return {
      ownId: own,
      qidFrom: ownMatch ? 'self' : (qid ? 'descendant' : null),
      questionIdNodes: descendants,          // 派生IDも含めて全部報告する（構造の把握用）
      validCandidates: validDescendants,
      qid: qid
    };
  }

  function fieldDetails(q) {
    var inp = q.querySelector('input:not([type="radio"]):not([type="checkbox"]):not([type="file"]), textarea');
    if (!inp) return null;
    var d = attrs(inp, ['type', 'placeholder', 'aria-label', 'aria-describedby', 'inputmode', 'maxlength', 'aria-required', 'pattern']);
    d.tag = inp.tagName.toLowerCase();
    d.currentValue = inp.value || '';
    if (d['aria-describedby']) {
      var desc = document.getElementById(d['aria-describedby']);
      if (desc) d.describedByText = text(desc);
    }
    return d;
  }

  function requiredOf(q) {
    if (q.querySelector('[aria-required="true"],[required]')) return true;
    var t = headingOf(q);
    return /\*/.test(t) || /必須|Required/.test(t);
  }

  function fileInfo(q) {
    var inp = q.querySelector('input[type="file"]');
    // querySelector にセレクタを並べると「セレクタの順」ではなく「文書順で最初の一致」が
    // 返る。設問タイトル側のイマーシブリーダーのボタンを掴んでいたので、2段階で引く。
    var btn = q.querySelector('[data-automation-id="fileUploadButton"]')
      || q.querySelector('button[aria-label*="アップロード"], button[aria-label*="upload" i]')
      || null;
    var info = {
      hasNativeInput: !!inp,
      uploadButton: btn ? { label: text(btn) || btn.getAttribute('aria-label'), automationId: btn.getAttribute('data-automation-id') } : null,
      skeleton: skeleton(q, 4)
    };
    if (inp) {
      info.accept = inp.getAttribute('accept');
      info.multiple = inp.multiple === true;
      info.hiddenFromLayout = inp.offsetParent === null;
      info.name = inp.getAttribute('name');
    }
    // 既に何か添付されていないか（自動添付を設計するうえで重要）
    info.attachedHints = Array.prototype.slice.call(q.querySelectorAll('[class*="file" i],[data-automation-id*="file" i]'))
      .map(function (n) { return text(n).slice(0, 60); })
      .filter(function (s) { return s; })
      .slice(0, 6);
    return info;
  }

  // ---------- ドロップダウンを開いて選択肢を読む ----------
  /* 既定では実行しない。
   *
   * かつてこの処理が本番フォームの 8.活動主管箇所名 に「その他 Other」を
   * 選択させてしまった（開いたまま閉じられず、フォーカスが外れた時点で
   * 活性項目が確定したものと思われる）。選択肢はすでに採取済みなので、
   * もう開く必要がない。どうしても再取得したいときだけ明示的に有効にする。
   *
   * 有効化: ブックマークレット実行前に window.GSH_PROBE_OPEN_DROPDOWN = true */
  function dropdownOpeningEnabled() {
    return window.GSH_PROBE_OPEN_DROPDOWN === true;
  }

  async function readDropdownOptions(q) {
    var trigger = dropdownTrigger(q);
    if (!trigger) return { ok: false, reason: 'ドロップダウンのトリガが見つかりません' };

    if (!dropdownOpeningEnabled()) {
      return {
        ok: false,
        skipped: true,
        reason: '選択肢の採取は既定で行いません（回答を書き換える事故があったため）。'
          + '再取得が必要なら window.GSH_PROBE_OPEN_DROPDOWN = true を設定してから実行してください。',
        現在の表示: text(trigger),
        triggerSkeleton: skeleton(trigger, 2)
      };
    }

    var before = document.querySelectorAll('[role="option"]').length;
    // 開く前の表示を控える。閉じた後にこれと違っていたら回答を変えてしまったということ。
    var textBefore = text(trigger);
    var report = { ok: false, 開く前の表示: textBefore, triggerSkeleton: skeleton(trigger, 2), attempts: [] };

    // Fluent は onMouseDown で開いて onClick で閉じる実装があるので、
    // 「開いた状態が保てているか」を都度確かめながら手を変えて試す。
    var tries = [
      ['pointer', function () {
        trigger.focus();
        ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(function (t) {
          var Ctor = (t.indexOf('pointer') === 0 && window.PointerEvent) ? PointerEvent : MouseEvent;
          trigger.dispatchEvent(new Ctor(t, { bubbles: true, cancelable: true, button: 0 }));
        });
      }],
      ['enter', function () {
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        trigger.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      }],
      ['alt-down', function () {
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
      }]
    ];

    for (var i = 0; i < tries.length; i++) {
      try { tries[i][1](); } catch (e) { /* 次の手を試す */ }
      await sleep(350);
      var expanded = trigger.getAttribute('aria-expanded') === 'true';
      var nowCount = document.querySelectorAll('[role="option"]').length;
      report.attempts.push({ how: tries[i][0], ariaExpanded: expanded, optionCount: nowCount });
      if (expanded || nowCount > before) break;
    }

    // 選択肢リストを特定する。Callout は document.body 直下にポータルされるので、
    // 設問ノードの内側を探しても見つからない。
    var listbox = null;
    var owns = trigger.getAttribute('aria-controls') || trigger.getAttribute('aria-owns');
    if (owns) listbox = document.getElementById(owns);
    if (!listbox && trigger.id) listbox = document.getElementById(trigger.id + '-list');
    if (!listbox) {
      var boxes = Array.prototype.slice.call(document.querySelectorAll('[role="listbox"]'));
      listbox = boxes[boxes.length - 1] || null;
    }

    var optionNodes = listbox
      ? Array.prototype.slice.call(listbox.querySelectorAll('[role="option"]'))
      : Array.prototype.slice.call(document.querySelectorAll('[role="option"]'));

    // ラジオと同じ理由で、属性を優先し、空白を潰さない
    report.options = optionNodes.map(function (o) {
      var got = exactChoiceText(o);
      return {
        raw: got.value,
        source: got.source,
        normalized: got.value.replace(/\s+/g, ' ').trim(),
        escaped: escapeNonAscii(got.value),
        selected: o.getAttribute('aria-selected') === 'true'
      };
    });
    report.listboxSkeleton = listbox ? skeleton(listbox, 3) : null;
    report.ok = report.options.length > 0;
    if (!report.ok) report.reason = '開いたが選択肢を取得できませんでした';

    // 必ず閉じる。開きっぱなしだと、フォーカスが外れた時点で活性項目が確定してしまう。
    try {
      [trigger, document.activeElement, document.body].forEach(function (target) {
        if (!target || !target.dispatchEvent) return;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', keyCode: 27, bubbles: true }));
      });
      if (trigger.blur) trigger.blur();
      await sleep(250);
      // まだ開いていたら、外側をクリックして閉じさせる
      if (trigger.getAttribute('aria-expanded') === 'true') {
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await sleep(250);
      }
    } catch (e) { /* 閉じられなくても報告は返す */ }

    report.closedAfter = trigger.getAttribute('aria-expanded') !== 'true';
    report.閉じた後の表示 = text(trigger);

    // ここが要。読み取っただけのつもりで回答を変えていないかを必ず検証する。
    report.回答を変えていない = report.閉じた後の表示 === textBefore;
    if (!report.回答を変えていない) {
      report.警告 = '注意: この設問の回答が「' + textBefore + '」から「' + report.閉じた後の表示
        + '」に変わってしまいました。フォームを再読み込みして元に戻してください。';
    } else if (!report.closedAfter) {
      report.警告 = '注意: ドロップダウンを閉じられませんでした。フォームを再読み込みしてください。';
    }

    return report;
  }

  // ---------- ページに埋まっている定義を探す ----------
  function scanInlineScripts() {
    var hits = [];
    Array.prototype.forEach.call(document.scripts, function (s, i) {
      var src = s.textContent || '';
      if (!src) return;
      ['QuestionId_r', 'questionInfo', '"choices"'].forEach(function (needle) {
        var at = src.indexOf(needle);
        if (at === -1) return;
        hits.push({
          scriptIndex: i,
          needle: needle,
          length: src.length,
          excerpt: src.slice(Math.max(0, at - 200), at + 400)
        });
      });
    });
    return hits.slice(0, 6);
  }

  /* 401 になった原因を突き止めるため、ページ自身が実際に叩いた API の URL を見る。
   * 本物の URL が分かれば同じものを叩き直せる。 */
  function scanFormApiCalls() {
    try {
      return performance.getEntriesByType('resource')
        .map(function (e) { return e.name; })
        .filter(function (n) { return n.indexOf('/formapi/') !== -1; })
        .filter(function (v, i, a) { return a.indexOf(v) === i; })
        .slice(0, 20);
    } catch (e) {
      return ['(取得できませんでした: ' + (e && e.message) + ')'];
    }
  }

  // ---------- 走査本体 ----------
  async function collectStage1() {
    var found = questionNodes();
    var items = [];

    for (var i = 0; i < found.nodes.length; i++) {
      var q = found.nodes[i];
      var t = typeOf(q);
      var ids = idsOf(q);
      var rec = {
        index: i,
        heading: headingOf(q),
        type: t,
        required: requiredOf(q),
        ids: ids
      };
      var opts = inlineOptions(q);
      if (opts.raw.length) {
        /* raw が事前入力に使う正本。normalized は人が読む用。
         * escaped では全角スペース等が 　 として見えるので、
         * 「空白がどの種類か」を目で確かめられる。 */
        rec.options = opts.raw.map(function (o, k) {
          return {
            raw: o, normalized: opts.normalized[k],
            source: opts.sources[k], escaped: escapeNonAscii(o)
          };
        });
      }
      var fd = fieldDetails(q);
      if (fd) rec.field = fd;
      if (t === 'file') rec.file = fileInfo(q);
      // 日付欄は type='date' なので、ここには来ない（来たら誤判定）
      if (t === 'dropdown') {
        rec.dropdown = await readDropdownOptions(q);
      }
      items.push(rec);
    }

    // 回答を変えてしまった設問があれば、出力の先頭で目立たせる
    var damaged = items.filter(function (it) { return it.dropdown && it.dropdown.警告; });

    return {
      回答を変えていないか: damaged.length === 0
        ? 'OK（読み取りのみ。回答状態は変更していません）'
        : damaged.map(function (it) { return it.heading + ' … ' + it.dropdown.警告; }),
      収集日時: new Date().toISOString(),
      版: 'probe-v3',
      ページURL: location.href,
      オリジン: location.origin,
      ページタイトル: document.title,
      使用セレクタ: found.selector,
      設問数: items.length,
      環境: {
        lang: document.documentElement.lang || null,
        navigatorLanguage: navigator.language,
        navigatorLanguages: (navigator.languages || []).slice(0, 4),
        送信ボタン: (function () {
          var b = Array.prototype.slice.call(document.querySelectorAll('button'))
            .map(function (x) { return text(x); })
            .filter(function (s) { return s; });
          return b.slice(-5);
        })()
      },
      設問: items,
      formapi呼び出し: scanFormApiCalls(),
      埋め込み定義: scanInlineScripts()
    };
  }

  // ---------- 画面表示 ----------
  function show(json) {
    var old = document.getElementById('gsh-probe-overlay');
    if (old) old.remove();

    var wrap = el('div', [
      'position:fixed', 'inset:3% 3%', 'z-index:2147483647',
      'background:#fff', 'color:#111', 'border:2px solid #333', 'border-radius:10px',
      'box-shadow:0 10px 50px rgba(0,0,0,.45)', 'display:flex', 'flex-direction:column',
      'font:14px/1.5 system-ui,sans-serif', 'padding:14px', 'gap:10px'
    ].join(';'));
    wrap.id = 'gsh-probe-overlay';

    var head = el('div', 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap');
    head.appendChild(el('strong', 'font-size:16px', 'フォーム調査結果'));
    head.appendChild(el('span', 'font-size:12px;color:#555',
      '入力も送信もしていません。下のテキストを全部コピーして送ってください。'));

    var ta = document.createElement('textarea');
    ta.value = json;
    ta.setAttribute('style', 'flex:1;width:100%;font:12px/1.45 ui-monospace,Consolas,monospace;white-space:pre;box-sizing:border-box;border:1px solid #bbb;border-radius:4px;padding:8px');

    var btns = el('div', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap');
    var msg = el('span', 'font-size:12px;color:#2e7d32', '');

    var copy = el('button', 'padding:8px 16px;font-size:14px;cursor:pointer', 'クリップボードにコピー');
    copy.onclick = function () {
      ta.focus(); ta.select();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).then(
          function () { msg.textContent = 'コピーしました'; },
          function () { msg.textContent = 'コピーできませんでした。Ctrl+A → Ctrl+C で手動コピーしてください'; }
        );
      } else {
        msg.textContent = 'Ctrl+A → Ctrl+C で手動コピーしてください';
      }
    };
    btns.appendChild(copy);

    var close = el('button', 'padding:8px 16px;font-size:14px;cursor:pointer', '閉じる');
    close.onclick = function () { wrap.remove(); };
    btns.appendChild(close);
    btns.appendChild(msg);

    wrap.appendChild(head);
    wrap.appendChild(ta);
    wrap.appendChild(btns);
    document.body.appendChild(wrap);
  }

  // ---------- 実行 ----------
  async function run() {
    // 遅延描画された設問も対象にするため、一度最下部まで送ってから戻す
    var y0 = window.scrollY;
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(WAIT);
    window.scrollTo(0, 0);
    await sleep(WAIT);

    var result;
    try {
      result = await collectStage1();
    } catch (e) {
      result = { エラー: String((e && e.stack) || e) };
    }

    window.scrollTo(0, y0);
    var json = JSON.stringify(result, null, 2);
    console.log('[学傷補・学賠補 調査 v3]', result);
    show(json);
  }

  run();
})();
