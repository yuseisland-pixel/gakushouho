/* filler.js — Microsoft Forms の設問を埋めるエンジン。生成されるブックマークレットの本体。
 *
 * 実行時に window.__GSH_PAYLOAD__ = { map: {...}, values: {...} } が入っている前提。
 * bookmarklet-gen.js がこの payload を頭に付けた形で組み立てる。
 *
 * 設計原則（並び順指定は設問の増減でズレるため使わない）:
 *   - 設問は「設問ID」で特定する（設問を作り直さない限り不変）
 *   - 特定できなければ黙って進まず、必ず警告する
 *   - 入力後は必ず読み戻して、意図した値が入ったか確認する
 *
 * CSP（実測）
 *   forms.cloud.microsoft は require-trusted-types-for 'script' を返すため
 *   innerHTML への代入は TypeError で落ちる。UI は DOM API だけで組む。
 */
(function () {
  'use strict';

  /* 値の受け取り。ブックマークレット自体は値を持たない（登録は一度きりにするため）。
   * 受け取り口を3段用意する。どれで受け取ったかは結果画面に必ず出す。
   *   1. location.hash … 本命。ツールの「フォームを開く」が #gsh=… を付ける
   *   2. クリップボード … Forms のリダイレクトでハッシュが消えた場合の逃げ道
   *   3. 貼り付け欄 … それも駄目なら手で貼ってもらう（黙って失敗させない）
   */
  function fromBase64Url(s) {
    var b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function parsePayload(raw) {
    if (!raw) return null;
    try {
      var json = raw.charAt(0) === '{' ? raw : fromBase64Url(raw);
      var p = JSON.parse(json);
      return (p && p.map && p.values) ? p : null;
    } catch (e) { return null; }
  }

  function payloadFromHash() {
    var m = /[#&]gsh=([^&]+)/.exec(location.hash || '');
    return m ? parsePayload(decodeURIComponent(m[1])) : null;
  }

  var payload = window.__GSH_PAYLOAD__ || payloadFromHash();
  var payloadSource = window.__GSH_PAYLOAD__ ? '直接指定' : (payload ? 'リンクの # から' : null);

  var MAP = {}, QUESTIONS = [], VALUES = {};

  /* 設問数は「決め打ち」にできない。
   * このフォームには条件付きの設問が2つあり（授業のときだけ出る6番と、
   * 活動主管箇所名がその他のときだけ出る箇所名）、答え方によって 16〜18 問に増減する。
   * Forms は表示中の設問に番号を振り直すので、表示番号もずれる
   * （活動主管箇所名は 8/24 は8番、8/25 は9番だった）。
   * 17問固定にしていたため、正常な状態でも「大学がフォームを変更した」と誤警告していた。 */
  var COUNT_MIN = null, COUNT_MAX = null;
  function readExpectedCount(v) {
    if (v == null) { COUNT_MIN = COUNT_MAX = null; return; }
    if (typeof v === 'number') { COUNT_MIN = COUNT_MAX = v; return; }
    COUNT_MIN = typeof v.min === 'number' ? v.min : null;
    COUNT_MAX = typeof v.max === 'number' ? v.max : null;
  }
  /** 想定の設問数を人に見せる形に。範囲なら「16〜18」。 */
  function expectedCountLabel() {
    if (COUNT_MIN == null && COUNT_MAX == null) return '不明';
    if (COUNT_MIN === COUNT_MAX) return String(COUNT_MIN);
    return COUNT_MIN + '〜' + COUNT_MAX;
  }
  function countOutOfRange(n) {
    if (COUNT_MIN != null && n < COUNT_MIN) return true;
    if (COUNT_MAX != null && n > COUNT_MAX) return true;
    return false;
  }

  function adoptPayload(p, source) {
    payload = p; payloadSource = source;
    MAP = p.map || {};
    QUESTIONS = MAP.questions || [];
    VALUES = p.values || {};
    readExpectedCount(MAP.expectedCount);
  }
  if (payload) adoptPayload(payload, payloadSource);

  var WAIT = 600;

  var results = [];   // { label, status, detail }
  function record(label, status, detail) { results.push({ label: label, status: status, detail: detail }); }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function text(n) { return n ? String(n.textContent || '').replace(/\s+/g, ' ').trim() : ''; }

  // ---------- 見出しの正規化 ----------
  // 実物の見出しは「1.申請者氏名単一行テキスト.」のように、大学が手で打った連番と
  // Forms が自動で付ける種別の読み上げ文言が前後に付く。両方落として比較する。
  var TYPE_SUFFIX = /(単一行テキスト|複数行テキスト|単一選択|複数選択|日付|ファイルのアップロード|評価|ランキング)\.?$/;

  function normalizeHeading(s) {
    var t = String(s || '');
    if (t.normalize) t = t.normalize('NFKC');
    t = t.replace(/\(非匿名の質問\)/g, '').replace(/\(匿名の質問\)/g, '');
    t = t.replace(/\s+/g, '');
    t = t.replace(TYPE_SUFFIX, '');
    t = t.replace(/[.。*＊:：]+$/, '');
    return t;
  }

  /** 見出しの先頭連番を取り出す（1始まり）。インデックス照合の検算に使う。 */
  function leadingNumber(s) {
    var m = /^(\d{1,2})[.．]/.exec(String(s || '').replace(/^\s+/, ''));
    return m ? Number(m[1]) : null;
  }

  function stripLeadingNumber(s) {
    return String(s || '').replace(/^\d{1,2}[.．]/, '');
  }

  // ---------- DOM 走査 ----------
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
    if (c) return text(c);
    var clone = q.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('input,textarea,button,select'), function (n) { n.remove(); });
    return text(clone).slice(0, 160);
  }

  function ownerOf(el) {
    return (el && el.closest && el.closest('[data-automation-id="questionItem"],[role="listitem"]')) || el;
  }

  // ---------- 設問の特定（3段構え）----------
  function resolve(entry, nodes) {
    // 1段目: 設問ID。並び順にも文言にも依存しない
    if (entry.qid) {
      var byId = document.getElementById('QuestionId_' + entry.qid);
      if (byId) return { node: ownerOf(byId), how: 'id' };
    }

    // 2段目: 見出しの正規化一致。複数当たったら黙って先頭を採らずに失敗させる
    if (entry.matchKey) {
      var want = normalizeHeading(entry.matchKey);
      var exact = [], partial = [];
      nodes.forEach(function (n) {
        var got = normalizeHeading(stripLeadingNumber(headingOf(n)));
        if (got === want) exact.push(n);
        else if (!entry.exactOnly && got.indexOf(want) !== -1) partial.push(n);
      });
      if (exact.length === 1) return { node: exact[0], how: 'heading' };
      if (exact.length === 0 && partial.length === 1) return { node: partial[0], how: 'heading-partial' };
      if (exact.length > 1 || partial.length > 1) {
        return { node: null, how: 'ambiguous', reason: '見出しが複数の設問に一致しました' };
      }
    }

    // 3段目: 並び順。設問数と先頭連番の両方が期待どおりのときだけ許す。
    // ここを無条件に使ったのが、今回のズレを誰も気付けなかった原因。
    if (entry.order != null && nodes[entry.order]) {
      /* 設問数が範囲内で、かつ先頭番号も期待どおりのときだけ並び順を信じる。
       * 条件付き設問が出入りすると番号は振り直されるので、先頭番号の検算は
       * 「たまたま範囲内に収まっただけ」を弾く要になる。ここは緩めない。 */
      var countOk = !countOutOfRange(nodes.length);
      var num = leadingNumber(headingOf(nodes[entry.order]));
      var numOk = num == null || num === entry.order + 1;
      if (countOk && numOk) return { node: nodes[entry.order], how: 'index' };
      return {
        node: null, how: 'index-rejected',
        reason: '並び順での代用も見送りました（設問数 ' + nodes.length
          + '、期待 ' + expectedCountLabel() + '／先頭番号 ' + num + '、期待 ' + (entry.order + 1) + '）'
      };
    }

    return { node: null, how: 'notfound', reason: '設問が見つかりませんでした' };
  }

  // ---------- 入力 ----------
  /** React 管理下の input に値を入れる。ネイティブ setter を経由しないと React が気付かない。 */
  function setNativeValue(inp, val) {
    var proto = inp.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(inp, val); else inp.value = val;
    ['input', 'change'].forEach(function (t) { inp.dispatchEvent(new Event(t, { bubbles: true })); });
  }

  function textInputOf(q) {
    return q.querySelector('input[type="text"],input:not([type="radio"]):not([type="checkbox"]):not([type="file"]),textarea');
  }

  function fillText(q, val) {
    var inp = textInputOf(q);
    if (!inp) return { ok: false, reason: '入力欄が見つかりません' };
    setNativeValue(inp, val);
    inp.dispatchEvent(new Event('blur', { bubbles: true }));
    return { ok: inp.value === val, actual: inp.value };
  }

  async function fillRadio(q, val) {
    var target = normalizeHeading(val);
    var opts = Array.prototype.slice.call(q.querySelectorAll('[role="radio"],input[type="radio"]'));
    var hits = [];
    for (var i = 0; i < opts.length; i++) {
      var label = opts[i].getAttribute('aria-label') || text(opts[i].closest('label')) || text(opts[i].parentElement);
      if (normalizeHeading(label) === target) { hits.push(opts[i]); }
    }
    if (!hits.length) return { ok: false, reason: '選択肢「' + val + '」が見つかりません' };
    if (hits.length > 1) return { ok: false, reason: '選択肢「' + val + '」が複数見つかります（曖昧です）' };
    var hit = hits[0];
    hit.click();
    var wrap = hit.closest('label,[role="radio"]');
    if (wrap && wrap !== hit) wrap.click();
    await sleep(20);
    var checked = q.querySelector('[role="radio"][aria-checked="true"],input[type="radio"]:checked');
    var actual = checked ? (checked.getAttribute('aria-label') || text(checked.closest('label') || checked.parentElement)) : '';
    return { ok: normalizeHeading(actual) === target, actual: actual };
  }

  // ---------- ドロップダウン（8番のみ）----------
  function dropdownTriggerOf(q) {
    var cands = q.querySelectorAll('[role="combobox"],[aria-haspopup="listbox"],[class*="ms-Dropdown"]');
    for (var i = 0; i < cands.length; i++) {
      if (cands[i].tagName.toLowerCase() !== 'input') return cands[i];
    }
    return null;
  }

  async function closeDropdown(trigger) {
    [trigger, document.activeElement, document.body].forEach(function (t) {
      if (!t || !t.dispatchEvent) return;
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    });
    if (trigger && trigger.blur) trigger.blur();
    await sleep(200);
    if (trigger && trigger.getAttribute('aria-expanded') === 'true') {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(200);
    }
  }

  async function fillDropdown(q, val) {
    var trigger = dropdownTriggerOf(q);
    if (!trigger) return { ok: false, reason: 'ドロップダウンが見つかりません' };

    var before = text(trigger);
    // 開く。Fluent は mousedown で開いて click で閉じる実装があるので、開いた状態を都度確認する
    trigger.focus();
    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(function (t) {
      var Ctor = (t.indexOf('pointer') === 0 && window.PointerEvent) ? PointerEvent : MouseEvent;
      trigger.dispatchEvent(new Ctor(t, { bubbles: true, cancelable: true, button: 0 }));
    });
    await sleep(350);

    if (trigger.getAttribute('aria-expanded') !== 'true') {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
      await sleep(350);
    }

    // 選択肢は document.body 直下にポータルされるので、設問の内側を探しても見つからない
    var owns = trigger.getAttribute('aria-controls') || trigger.getAttribute('aria-owns');
    var box = (owns && document.getElementById(owns)) || null;
    if (!box) {
      var boxes = document.querySelectorAll('[role="listbox"]');
      box = boxes[boxes.length - 1] || null;
    }
    var options = box
      ? Array.prototype.slice.call(box.querySelectorAll('[role="option"]'))
      : Array.prototype.slice.call(document.querySelectorAll('[role="option"]'));

    if (!options.length) {
      await closeDropdown(trigger);
      return { ok: false, reason: '選択肢を読み取れませんでした' };
    }

    var target = normalizeHeading(val);
    var hits = [];
    for (var i = 0; i < options.length; i++) {
      var label = options[i].getAttribute('aria-label') || text(options[i]);
      if (normalizeHeading(label) === target) { hits.push(options[i]); }
    }
    if (!hits.length) {
      // 開きっぱなしにすると、フォーカスが外れた時点で別の項目が確定してしまう
      await closeDropdown(trigger);
      return { ok: false, reason: '選択肢「' + val + '」が一覧にありません（' + options.length + '件中）' };
    }
    if (hits.length > 1) {
      await closeDropdown(trigger);
      return { ok: false, reason: '選択肢「' + val + '」が複数見つかります（曖昧です）' };
    }
    var hit = hits[0];

    if (hit.scrollIntoView) hit.scrollIntoView({ block: 'nearest' });
    ['mousedown', 'mouseup', 'click'].forEach(function (t) {
      hit.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0 }));
    });
    await sleep(300);
    await closeDropdown(trigger);

    var after = text(trigger);
    return {
      ok: normalizeHeading(after) === target,
      actual: after,
      reason: normalizeHeading(after) === target ? null
        : '選んだつもりが反映されていません（' + before + ' → ' + after + '）'
    };
  }

  // ---------- 日付（11/12）----------
  async function fillDate(q, iso) {
    var inp = q.querySelector('input');
    if (!inp) return { ok: false, reason: '日付欄が見つかりません' };

    // 実測: placeholder が「日付を入力してください(yyyy/MM/dd)」。書式は確定している
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
    if (!m) return { ok: false, reason: '日付の形式が不正です: ' + iso };
    var formatted = m[1] + '/' + m[2] + '/' + m[3];

    setNativeValue(inp, formatted);
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    inp.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(300);

    // ピッカーが開いていたら閉じる。開いたままだと後続の操作を食われる
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    await sleep(150);

    var got = inp.value;
    // Forms が表示を整形して返すことがあるので、数字の集合で照合する
    var wantNums = [String(Number(m[1])), String(Number(m[2])), String(Number(m[3]))].sort().join(',');
    var gotNums = (got.match(/\d+/g) || []).map(function (n) { return String(Number(n)); }).sort().join(',');
    if (got && wantNums === gotNums) return { ok: true, actual: got };

    // 受理されなかった。入力済みの値は残して、ユーザーが気付いて修正できるようにする
    return { ok: false, actual: got, reason: '日付が受理されませんでした。手で入力してください' };
  }

  // ---------- 読み戻し ----------
  function readBack(q, type) {
    if (type === 'radio') {
      var c = q.querySelector('[role="radio"][aria-checked="true"],input[type="radio"]:checked');
      return c ? (c.getAttribute('aria-label') || text(c.closest('label') || c.parentElement)) : '';
    }
    if (type === 'dropdown') {
      var t = dropdownTriggerOf(q);
      return t ? text(t) : '';
    }
    var inp = textInputOf(q);
    return inp ? inp.value : '';
  }

  // ---------- 値の取り出し ----------
  function valueOf(source) {
    if (!source) return null;
    return source.split('.').reduce(function (o, k) { return (o == null ? undefined : o[k]); }, VALUES);
  }

  // ---------- 実行 ----------
  /* このフォームは段階表示（分岐）になっている。
   * 開いた直後は 1〜5番しか出ておらず、5番に回答すると 6〜8番、
   * 8番に回答すると以降が現れる。
   * だから分岐を開く設問に回答したあとは、**設問が実際に増えるまで待つ**必要がある。
   * 固定の待ち時間だと、描画が遅れたときに以降が全部埋まらない（実際にそうなった）。 */
  var WAIT_LIMIT_MS = 3000;
  async function waitForMore(before) {
    /* 「増えたら成功」だけだと、既に全問見えている状態（2回目の実行など）で
     * 永久に増えず、正常なのに失敗と判定してしまう。
     * 実行前から想定数に達していた場合に限り、増えなくても満たされたとみなす。
     * 実行前が想定数未満なら「増えたか」だけを見る（分岐未展開の検出を守るため）。 */
    var alreadyFull = COUNT_MIN != null && before >= COUNT_MIN;
    function satisfied() {
      return questionNodes().length > before || alreadyFull;
    }
    var waited = 0;
    var step = 100;
    while (waited < WAIT_LIMIT_MS) {
      if (satisfied()) return true;
      await sleep(step);
      waited += step;
    }
    return satisfied();
  }

  var gateFailures = [];   // 開かなかった分岐の設問名
  var staleFound = false;  // 前回の内容が残っていて上書きできなかった設問があったか

  async function run() {
    var nodes = questionNodes();
    if (!nodes.length) {
      alert('フォームの設問が見つかりませんでした。活動届のフォームのページで実行しているか確認してください。');
      return;
    }

    // 選択系を先に処理する。選択で DOM が差し替わることがあり、
    // 先にテキストを入れておくと参照が古くなるため。
    var order = { radio: 0, dropdown: 0, date: 1, text: 2, textarea: 2 };
    var todo = QUESTIONS
      .filter(function (e) { return e.type !== 'file'; })
      .map(function (e, i) { return { e: e, i: i }; })
      .sort(function (a, b) {
        var d = (order[a.e.type] == null ? 3 : order[a.e.type]) - (order[b.e.type] == null ? 3 : order[b.e.type]);
        return d !== 0 ? d : a.i - b.i;
      });

    var resolvedValues = {};   // qid -> 実際に入った値（条件付き設問の判定に使う）

    for (var n = 0; n < todo.length; n++) {
      var entry = todo[n].e;

      // 条件付き設問。設定値ではなく「実際に入っている値」で判定する。
      // 8番の選択に失敗したのに9番だけ埋まる、という組み合わせを避けるため。
      if (entry.condition) {
        var dep = entry.condition.dependsOn;
        var depNow = resolvedValues[dep];
        if (depNow == null) {
          var depEntry = QUESTIONS.filter(function (x) { return x.qid === dep; })[0];
          var depNode = depEntry ? resolve(depEntry, questionNodes()).node : null;
          depNow = depNode ? readBack(depNode, depEntry.type) : '';
        }
        var met = String(depNow || '').indexOf(entry.condition.startsWith) === 0;
        if (!met) {
          // 触らない。ただし人が入れた値が残っていたら知らせる
          var cNode = resolve(entry, questionNodes()).node;
          var leftover = cNode ? readBack(cNode, entry.type) : '';
          if (leftover) {
            record(entry.label, 'warn', '条件を満たさないので入力していませんが、「' + leftover + '」が残っています。消してください');
          } else {
            record(entry.label, 'skip', '条件を満たさないため入力しません（正常）');
          }
          continue;
        }
      }

      var val = valueOf(entry.source);
      if (val == null || val === '') { record(entry.label, 'skip', '値が未設定のため入力しません'); continue; }

      /* 入力する前の値を控える。Forms は最初に開いた事前入力リンクの内容を
       * 覚えてしまう不具合があり、前回の申請内容が残っていることがある。
       * 「元から違う値が入っていた」ことを言えるようにしておく。 */
      var pre = (function () {
        var n = resolve(entry, questionNodes()).node;
        return n ? readBack(n, entry.type) : '';
      })();

      // 選択系のあとは DOM が差し替わっている可能性があるので毎回取り直す
      var live = questionNodes();
      var r = resolve(entry, live);
      if (!r.node) {
        // 分岐が開いていないなら、その設問はまだ画面に存在しない。原因を取り違えない
        if (gateFailures.length) {
          record(entry.label, 'error',
            '「' + gateFailures.join('」「') + '」に回答できなかったため、この設問がまだ出ていません（未到達）');
        } else {
          record(entry.label, 'error', r.reason || '設問を特定できませんでした');
        }
        continue;
      }

      var countBefore = live.length;
      var out;
      if (entry.type === 'radio') out = await fillRadio(r.node, val);
      else if (entry.type === 'dropdown') out = await fillDropdown(r.node, val);
      else if (entry.type === 'date') out = await fillDate(r.node, val);
      else out = fillText(r.node, entry.numeric ? String(val).replace(/[^\d]/g, '') : val);

      /* 入れたつもりで終わらせない。必ず読み戻す。
       *
       * ただし **書いた直後に読むと、書いた値がそのまま返ってくる**。
       * React やフォーム側の検証が値を差し戻す場合、その差し戻しは次のタスクで起きるので、
       * 同期的に読むと「入った」と誤判定する（模擬フォームで実際に取り違えた）。
       * 一拍おいてから読み直して、居座った値を取りこぼさないようにする。 */
      await sleep(60);
      var reread = readBack(r.node, entry.type);
      /* 比較の相手は「記入直後に入っていた値」。元の val と比べてはいけない。
       * 日付は 2026-09-01 を渡して 2026/09/01 として入るなど、
       * 設問の型によって表記が変わるので、val と比べると全部が差し戻し扱いになる。 */
      var intended = out.actual != null ? out.actual : String(val);
      var actual = reread !== '' ? reread : intended;
      if (out.actual != null) {
        var matches = normalizeHeading(actual) === normalizeHeading(intended);
        out = { ok: matches, actual: actual, reason: out.reason };
      }
      resolvedValues[entry.qid] = actual;

      if (out.ok) {
        record(entry.label, r.how === 'id' ? 'ok' : 'ok-fallback', actual
          + (r.how === 'id' ? '' : '（設問IDで特定できず ' + r.how + ' で代用）'));
      } else if (pre && normalizeHeading(pre) === normalizeHeading(actual)) {
        // 入力を試みたのに値が変わらず、しかも元から何か入っていた。
        // Forms が前回の事前入力を記憶しているときの典型的な症状
        staleFound = true;
        record(entry.label, 'error',
          '前から入っていた「' + pre + '」のままで、変更できませんでした');
      } else {
        record(entry.label, 'error', out.reason || ('入力できませんでした（現在: ' + actual + '）'));
      }

      if (entry.unlocksMore) {
        if (!out.ok) {
          // ここで失敗すると、この先の設問は画面に出てこない
          gateFailures.push(entry.label);
        } else {
          // 設問が増えるまで待つ。固定待ちだと描画が遅れたときに以降が全滅する
          var grew = await waitForMore(countBefore);
          if (!grew) {
            gateFailures.push(entry.label);
            record(entry.label, 'warn',
              '回答はしましたが、続きの設問が出てきませんでした（' + countBefore + ' 問のまま）');
          }
        }
      } else {
        await sleep(60);
      }
    }

    /* 設問数の照合は「最後」に取る。
     * 段階表示のせいで開いた直後は5問しかないので、最初に数えると
     * 毎回「大学がフォームを変更した」と誤警告することになる（実際に出ていた）。 */
    var finalCount = questionNodes().length;
    // 範囲を外れたときだけ警告する。範囲内の増減は条件付き設問による正常な変動
    var countMismatch = countOutOfRange(finalCount) && gateFailures.length === 0;
    banner(countMismatch, finalCount);
    // サポート用ログ。問い合わせ時に開発者ツールで結果一覧を確認できるよう意図的に残す
    console.log('[学傷補・学賠補 自動入力]', results);
  }

  // ---------- 結果表示 ----------
  // 件数だけ出しても意味がない。「どの設問に何が入ったか」を見せる。
  function el(tag, style, txt) {
    var n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (txt != null) n.textContent = txt;
    return n;
  }

  function banner(countMismatch, actualCount) {
    var old = document.getElementById('gsh-filler-banner');
    if (old) old.remove();

    var errors = results.filter(function (r) { return r.status === 'error' || r.status === 'warn'; });
    var fallbacks = results.filter(function (r) { return r.status === 'ok-fallback'; });
    var bad = errors.length > 0 || countMismatch;

    var box = el('div', [
      'position:fixed', 'top:10px', 'right:10px', 'z-index:2147483647',
      'max-width:520px', 'max-height:80vh', 'overflow:auto',
      'background:' + (bad ? '#fff4e5' : '#e8f5e9'), 'color:#111',
      'border:2px solid ' + (bad ? '#e08600' : '#2e7d32'), 'border-radius:8px', 'padding:12px 14px',
      'font:13px/1.6 system-ui,sans-serif', 'box-shadow:0 6px 24px rgba(0,0,0,.25)'
    ].join(';'));
    box.id = 'gsh-filler-banner';

    box.appendChild(el('div', 'font-weight:700;font-size:14px;margin-bottom:6px',
      bad ? '自動入力しましたが、確認が必要です' : '自動入力しました'));
    // どの経路で値を受け取ったかを出す。ハッシュが消えていた場合に気付けるように
    if (payloadSource) {
      box.appendChild(el('div', 'font-size:12px;color:#555;margin-bottom:4px',
        '値の受け取り: ' + payloadSource));
    }

    /* 前から入っていた値が居座って上書きできなかったとき。
     * 「入らなかった」だけでは原因が分からないので、まとめて名指しする。 */
    if (staleFound) {
      box.appendChild(el('div', 'color:#b00;font-weight:700;margin-bottom:6px',
        'フォームに前から入っていた内容を、上書きできなかった項目があります。'
        + '下の一覧で [失敗] の付いた設問を、手で直してください。'));
    }

    if (gateFailures.length) {
      box.appendChild(el('div', 'color:#b00;font-weight:700;margin-bottom:6px',
        '「' + gateFailures.join('」「') + '」に回答できなかったため、'
        + 'その先の設問が画面に出ていません。ここを手で選ぶと残りも入力できるようになります。'));
    } else if (countMismatch) {
      box.appendChild(el('div', 'color:#b00;font-weight:700;margin-bottom:6px',
        'フォームの設問数が ' + actualCount + ' 問で、想定の ' + expectedCountLabel()
        + ' 問の範囲を外れています。大学がフォームを変更した可能性があります。'));
    }

    var table = el('table', 'width:100%;border-collapse:collapse;margin-top:4px');
    results.forEach(function (r) {
      var tr = el('tr');
      var mark = { ok: '[OK]', 'ok-fallback': '[注意]', skip: '[スキップ]', warn: '[注意]', error: '[失敗]' }[r.status] || '?';
      var color = (r.status === 'error') ? '#b00' : (r.status === 'warn' || r.status === 'ok-fallback') ? '#a05000' : '#333';
      tr.appendChild(el('td', 'vertical-align:top;padding:2px 6px 2px 0', mark));
      tr.appendChild(el('td', 'vertical-align:top;padding:2px 6px 2px 0;white-space:nowrap;font-weight:600', r.label));
      tr.appendChild(el('td', 'vertical-align:top;padding:2px 0;color:' + color, r.detail || ''));
      table.appendChild(tr);
    });
    box.appendChild(table);

    if (fallbacks.length) {
      box.appendChild(el('div', 'margin-top:8px;color:#a05000',
        '設問IDで特定できなかった項目があります。フォームが変更された可能性があるので、内容をよく確認してください。'));
    }

    box.appendChild(el('div', 'margin-top:10px;font-weight:700;color:#b00',
      '送信前に、フォームの内容を必ず自分の目で確認してください。'));
    box.appendChild(el('div', 'margin-top:4px;color:#555',
      '参加者名簿の添付と送信は自動化していません。手で行ってください。'));

    var close = el('button', 'margin-top:10px;padding:6px 12px;cursor:pointer', '閉じる');
    close.onclick = function () { box.remove(); };
    box.appendChild(close);
    document.body.appendChild(box);
  }

  /** ハッシュが無かったときの逃げ道。クリップボード → 貼り付け欄の順に試す。 */
  async function recoverPayload() {
    if (navigator.clipboard && navigator.clipboard.readText) {
      try {
        var p = parsePayload((await navigator.clipboard.readText() || '').trim());
        if (p) { adoptPayload(p, 'クリップボードから'); return true; }
      } catch (e) { /* 許可されなければ貼り付け欄に回す */ }
    }
    return await askPaste();
  }

  function askPaste() {
    return new Promise(function (resolve) {
      var wrap = el('div', [
        'position:fixed', 'inset:20% 10%', 'z-index:2147483647', 'background:#fff', 'color:#111',
        'border:2px solid #333', 'border-radius:10px', 'padding:16px', 'display:flex',
        'flex-direction:column', 'gap:10px', 'font:14px/1.6 system-ui,sans-serif',
        'box-shadow:0 10px 40px rgba(0,0,0,.4)'
      ].join(';'));
      wrap.appendChild(el('strong', null, '入力する値が見つかりませんでした'));
      wrap.appendChild(el('div', 'font-size:13px;color:#555',
        'ツールの「フォームを開く」から開き直すのが確実です。'
        + 'すでに値をコピーしてある場合は、下に貼り付けてから「これで入力する」を押してください。'));
      var ta = document.createElement('textarea');
      ta.setAttribute('style', 'flex:1;min-height:120px;font:12px ui-monospace,monospace');
      wrap.appendChild(ta);
      var row = el('div', 'display:flex;gap:8px');
      var ok = el('button', 'padding:8px 16px;cursor:pointer', 'これで入力する');
      var cancel = el('button', 'padding:8px 16px;cursor:pointer', 'やめる');
      ok.onclick = function () {
        var p = parsePayload(ta.value.trim());
        if (!p) { ta.setAttribute('style', ta.getAttribute('style') + ';border:2px solid #b00'); return; }
        adoptPayload(p, '貼り付けから');
        wrap.remove();
        resolve(true);
      };
      cancel.onclick = function () { wrap.remove(); resolve(false); };
      row.appendChild(ok); row.appendChild(cancel);
      wrap.appendChild(row);
      document.body.appendChild(wrap);
      ta.focus();
    });
  }

  // 遅延描画された設問も対象にするため、一度最下部まで送ってから戻す
  (async function () {
    if (!payload) {
      var got = await recoverPayload();
      if (!got) return;
    }
    var y0 = window.scrollY;
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(WAIT);
    window.scrollTo(0, 0);
    await sleep(WAIT);
    try {
      await run();
    } catch (e) {
      console.error('[学傷補・学賠補 自動入力] 失敗', e);
      alert('自動入力の途中で問題が起きました: ' + (e && e.message || e));
    }
    window.scrollTo(0, y0);
  })();
})();
