/* mock-form.mjs — 実測データから Microsoft Forms を模した HTML を組み立てる。
 *
 * 本物のフォームは組織限定なうえ、うっかり送信する危険もあるので、
 * probe と filler の検証はこの模擬フォームに対して行う。
 * 「設問を1つ挿入したらどうなるか」のような、本物では試せない実験もできる。
 *
 * ■ 再現している Forms の性質（すべて実測に基づく）
 *   - 設問は [data-automation-id="questionItem"]
 *   - 設問ID は questionItem 自身ではなく「子孫の div」に id="QuestionId_r<hex>" として付く
 *   - 見出しは「連番 + タイトル + 種別の読み上げ文言 + 句点」
 *   - ドロップダウンは閉じている間は選択肢が DOM に無く、開くと body 直下にポータルされる
 *   - **日付欄は <input role="combobox"> である**。これを見落として probe が
 *     ドロップダウンと誤判定し、本番の日付ピッカーを開いてしまった。必ず再現する
 *   - 設問タイトル側に「イマーシブ リーダー」ボタンがあり、ファイル欄の
 *     アップロードボタンより DOM 上で先に出てくる（querySelector の取り違えを再現）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE = path.join(ROOT, 'tools', 'fixtures', 'probe-2026-08-24.json');

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderQuestion(q, i, labelMode, valueMismatch) {
  const qid = `QuestionId_${q.qid}`;
  // 実物では questionItem 自身ではなく子孫に設問IDが付く
  const head =
    `<div id="${qid}">` +
    `<span data-automation-id="questionTitle">${esc(q.heading)}</span>` +
    `<button type="button" aria-label="イマーシブ リーダー">イマーシブ リーダー</button>` +
    `</div>`;

  let body = '';
  switch (q.type) {
    case 'text':
      body = `<input type="text" placeholder="${esc(q.placeholder || '')}"`
        + ` aria-label="${esc(q.ariaLabel || '')}"${q.maxlength ? ` maxlength="${q.maxlength}"` : ''}>`;
      break;
    case 'textarea':
      body = `<textarea rows="2" placeholder="${esc(q.placeholder || '')}"`
        + ` aria-label="${esc(q.ariaLabel || '')}"${q.maxlength ? ` maxlength="${q.maxlength}"` : ''}></textarea>`;
      break;
    case 'radio':
      /* ラベル文字がどこに入るかは2通りある。
       * 'aria'    … ラジオ要素自身に aria-label と文字がある
       * 'sibling' … 本番の4番と同じ形。実機の HTML を写したもの：
       *               <span data-automation-id="radio" data-automation-value="…">
       *                 <input type="radio" role="radio" value="…" aria-labelledby="…">
       *                 <span id="…">…</span>
       *             ラジオ要素自身の aria-label と textContent は空で、
       *             正確な文字列は **value 属性** にある。
       * 決め打ちすると読み取りに失敗するので、両方を再現できるようにしておく。
       *
       * valueMismatch を立てると value 属性だけ別の文字列にする。
       * 「表示テキストではなく value を採っている」ことを確かめるため。 */
      body = (q.options || []).map((o, n) => {
        const attrVal = valueMismatch ? o + '＠VALUE' : o;
        const on = q.preChecked === n;   // 下書きが残っている状態の再現
        if (labelMode !== 'sibling') {
          return `<div role="radio" aria-checked="${on}" aria-label="${esc(o)}" tabindex="0"`
            + ` data-opt="${n}">${esc(o)}</div>`;
        }
        const lid = `QuestionChoiceOption${i}_${n}`;
        return `<span data-automation-id="radio" data-automation-value="${esc(attrVal)}">`
          + `<input type="radio" role="radio" aria-checked="${on}"${on ? ' checked' : ''}`
          + ` tabindex="0" data-opt="${n}"`
          + ` value="${esc(attrVal)}" aria-labelledby="${lid}">`
          + `<span id="${lid}">${esc(o)}</span></span>`;
      }).join('');
      break;
    case 'date':
      // ★ 実物どおり role="combobox" を付ける。ここが今回のバグの再現点
      body = `<input type="text" role="combobox" class="ms-TextField-field field-300"`
        + ` id="${esc(q.datePickerId || 'DatePicker' + i + '-label')}"`
        + ` placeholder="${esc(q.placeholder || '')}" aria-label="${esc(q.ariaLabel || '日付の選択')}"`
        + ` aria-expanded="false" data-datepicker="1">`;
      break;
    case 'dropdown':
      body = `<div role="button" aria-haspopup="listbox" aria-expanded="false" tabindex="0"`
        + ` id="${qid}-trigger" aria-controls="${qid}-list"`
        + ` data-options="${esc(JSON.stringify(q.dropdownOptions || []))}">`
        + `<span id="${q.qid}_placeholder_content">選択してください</span></div>`;
      break;
    case 'file':
      body = `<div role="group">`
        + `<button data-automation-id="fileUploadButton" type="button">ファイルのアップロード</button>`
        + `<input type="file" style="display:none"${q.multiple ? ' multiple' : ''}`
        + `${q.accept ? ` accept="${esc(q.accept)}"` : ''}>`
        + `</div>`;
      break;
    default:
      body = `<div>（未対応の設問形式）</div>`;
  }

  return `<div data-automation-id="questionItem" role="listitem">${head}${body}</div>`;
}

/**
 * @param opts.omitQids       この設問IDを出さない（条件付き設問が隠れている状態の再現）
 * @param opts.insertExtraAt  この位置に設問を1つ挿入する（ズレの再現テスト用）
 * @param opts.stripIds       設問IDを消す（見出し一致へのフォールバック検証用）
 * @param opts.noGating       段階表示を無効にして全問を最初から出す（旧模擬の再現用）
 * @param opts.revealDelay    分岐が開くまでの遅延ミリ秒（固定待ちに頼っていないかの検証用）
 * @param opts.choiceLabelMode 'aria'（既定）か 'sibling'。
 *        'sibling' は本番の4番と同じ形（input[value] が正本、表示は隣の span）。
 * @param opts.choiceValueMismatch value 属性だけ表示テキストと違う文字列にする。
 *        「表示テキストではなく value を採っているか」の検証用。
 * @param opts.preChecked {設問index: 選択肢index} あらかじめ選択済みにする。
 *        下書きが残っている状態の再現（事前入力が効いたのか区別できるかの検証）。
 * @param opts.choiceOverride {設問index: [選択肢文字列]} 選択肢を差し替える。
 *        全角スペースなど「空白の種類」を潰していないかの検証に使う。
 *        fixture 自体が過去に潰された文字列を持っている可能性があるので、
 *        検証側から独立した文字列を注入できるようにしてある。
 */
export function buildMockForm(opts = {}) {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  let questions = fixture.設問.slice();
  let stages = fixture.段階表示 || null;

  if (opts.choiceOverride) {
    questions = questions.map((q, i) =>
      opts.choiceOverride[i] ? { ...q, options: opts.choiceOverride[i] } : q);
  }
  if (opts.preChecked) {
    questions = questions.map((q, i) =>
      opts.preChecked[i] != null ? { ...q, preChecked: opts.preChecked[i] } : q);
  }

  /* 条件付きの設問が出ていない状態を再現する。
   * 実物は「授業のときだけ出る6番」「その他のときだけ出る箇所名」があるので、
   * 設問数は 16〜18 で変動する。決め打ちの警告を出さないことを確かめるのに使う。 */
  if (opts.omitQids && opts.omitQids.length) {
    questions = questions.filter((q) => opts.omitQids.indexOf(q.qid) === -1);
    stages = null;   // 並びが変わるので段階表示の定義は使えない
  }

  if (opts.insertExtraAt != null) {
    questions.splice(opts.insertExtraAt, 0, {
      heading: '99.あとから追加された設問単一行テキスト.',
      type: 'text',
      qid: 'r' + 'f'.repeat(32)
    });
    stages = null;   // 並びが変わるので段階表示の定義は使えない
  }
  if (opts.noGating) stages = null;

  let html = questions
    .map((q, i) => renderQuestion(q, i, opts.choiceLabelMode || 'aria', !!opts.choiceValueMismatch))
    .join('\n');
  // 派生ID（QuestionId_xxx-trigger など）もまとめて消す
  if (opts.stripIds) html = html.replace(/ id="QuestionId_[^"]*"/g, '');

  /* 段階表示（分岐）の再現。
   * 実物は開いた直後 1〜5番だけを出し、5番に回答すると6〜8番、
   * 8番に回答すると以降が現れる。実物が DOM から消しているのか隠しているだけかは
   * 未確認なので、**厳しいほう＝DOM に存在しない**で再現する。
   * これで通れば実物でも通る。 */
  const gating = stages ? `
    var STAGES = ${JSON.stringify(stages)};
    var REVEAL_DELAY = ${opts.revealDelay || 0};
    var all = Array.prototype.slice.call(document.querySelectorAll('[data-automation-id="questionItem"]'));
    var shown = {};
    function answered(idx) {
      var q = all[idx];
      if (!q) return false;
      if (q.querySelector('[role="radio"][aria-checked="true"]')) return true;
      var dd = q.querySelector('[aria-haspopup="listbox"]');
      if (dd && dd.getAttribute('data-selected')) return true;
      var t = q.querySelector('input:not([type=radio]):not([type=checkbox]):not([type=file]),textarea');
      return !!(t && t.value);
    }
    function applyStages() {
      STAGES.forEach(function (st) {
        var open = st.unlockedBy == null || answered(st.unlockedBy);
        st.reveals.forEach(function (i) {
          if (!all[i]) return;
          if (open && !shown[i]) {
            shown[i] = true;
            // 元の位置に戻す（並び順を保つ）
            var next = null;
            for (var j = i + 1; j < all.length; j++) { if (shown[j]) { next = all[j]; break; } }
            if (next) next.parentNode.insertBefore(all[i], next);
            else document.getElementById('gsh-mock-questions').appendChild(all[i]);
          } else if (!open && shown[i]) {
            shown[i] = false;
            if (all[i].parentNode) all[i].parentNode.removeChild(all[i]);
          }
        });
      });
    }
    // いったん全部外してから、開いている段階だけ戻す
    all.forEach(function (q) { if (q.parentNode) q.parentNode.removeChild(q); });
    applyStages();
    // 回答されたら段階を開き直す（遅延を挟めるようにしておく）
    document.addEventListener('click', function () { setTimeout(applyStages, REVEAL_DELAY); }, true);
    document.addEventListener('mousedown', function () { setTimeout(applyStages, REVEAL_DELAY); }, true);
    document.addEventListener('change', function () { setTimeout(applyStages, REVEAL_DELAY); }, true);
  ` : '';

  const behaviour = `
    // ドロップダウン: 開くと選択肢を body 直下にポータルする（本物の Callout と同じ）
    document.addEventListener('mousedown', function (ev) {
      var t = ev.target.closest && ev.target.closest('[aria-haspopup="listbox"]');
      if (!t || t.getAttribute('aria-expanded') === 'true') return;
      t.setAttribute('aria-expanded', 'true');
      var opts = JSON.parse(t.getAttribute('data-options') || '[]');
      var box = document.createElement('div');
      box.id = t.getAttribute('aria-controls') || 'listbox-portal';
      box.setAttribute('role', 'listbox');
      opts.forEach(function (o) {
        var el = document.createElement('div');
        el.setAttribute('role', 'option');
        el.setAttribute('aria-selected', 'false');
        el.textContent = o;
        el.addEventListener('mousedown', function () {
          var label = t.querySelector('span');
          if (label) label.textContent = o; else t.textContent = o;
          t.setAttribute('data-selected', o);
          t.setAttribute('aria-expanded', 'false');
          box.remove();
        });
        box.appendChild(el);
      });
      document.body.appendChild(box);
    }, true);

    // 日付ピッカー: クリックでカレンダーを開く。選択肢(role=option)は持たない
    document.addEventListener('mousedown', function (ev) {
      var d = ev.target.closest && ev.target.closest('[data-datepicker]');
      if (!d || d.getAttribute('aria-expanded') === 'true') return;
      d.setAttribute('aria-expanded', 'true');
      var cal = document.createElement('div');
      cal.className = 'ms-Callout ms-DatePicker-callout';
      cal.id = 'DatePicker-Callout-' + (d.id || 'x');
      cal.setAttribute('data-calendar-for', d.id || '');
      var dlg = document.createElement('div');
      dlg.setAttribute('role', 'dialog');
      [9, 10, 11, 12].forEach(function (n) {
        var b = document.createElement('button');
        b.textContent = String(n);
        dlg.appendChild(b);
      });
      var today = document.createElement('button');
      today.textContent = '今日へ移動';
      dlg.appendChild(today);
      cal.appendChild(dlg);
      document.body.appendChild(cal);
    }, true);

    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      document.querySelectorAll('[role="listbox"],.ms-DatePicker-callout').forEach(function (b) { b.remove(); });
      document.querySelectorAll('[aria-expanded="true"]').forEach(function (c) { c.setAttribute('aria-expanded','false'); });
    }, true);

    /* ★ 本番で観測した挙動の再現。
     * 開いたままフォーカスが外れると、活性項目（実際に選ばれてしまったのは末尾の
     * 「その他 Other」だった）が確定してしまう。ここを再現しておかないと、
     * 「開きっぱなしにしない」という修正が効いているかをテストで確かめられない。 */
    document.addEventListener('blur', function (ev) {
      var t = ev.target.closest && ev.target.closest('[aria-haspopup="listbox"]');
      if (!t || t.getAttribute('aria-expanded') !== 'true') return;
      var box = document.getElementById(t.getAttribute('aria-controls'));
      var opts = box ? box.querySelectorAll('[role="option"]') : [];
      if (opts.length) {
        var last = opts[opts.length - 1];
        var label = t.querySelector('span');
        if (label) label.textContent = last.textContent; else t.textContent = last.textContent;
        t.setAttribute('data-selected', last.textContent);
        last.setAttribute('aria-selected', 'true');
      }
      t.setAttribute('aria-expanded', 'false');
      if (box) box.remove();
    }, true);

    document.addEventListener('click', function (ev) {
      var r = ev.target.closest && ev.target.closest('[role="radio"]');
      if (!r) return;
      var group = r.closest('[data-automation-id="questionItem"]');
      group.querySelectorAll('[role="radio"]').forEach(function (x) { x.setAttribute('aria-checked','false'); });
      r.setAttribute('aria-checked', 'true');
    }, true);

    /* 前から入っていた内容が居座って上書きできない状態の再現。
     * 指定した設問の入力欄は、書き換えても元の値に戻る。
     * 記入エンジンが「入れたつもり」で済ませず、読み戻して気付けるかを確かめる。 */
    ${JSON.stringify(opts.frozen || [])}.forEach(function (i) {
      var q = document.querySelectorAll('[data-automation-id="questionItem"]')[i];
      if (!q) return;
      var inp = q.querySelector('input:not([type=radio]):not([type=checkbox]):not([type=file]),textarea');
      if (!inp) return;
      inp.value = ${JSON.stringify(opts.frozenValue || 'ZZ前回の値')};
      var locked = inp.value;
      inp.addEventListener('input', function () {
        if (inp.value !== locked) setTimeout(function () { inp.value = locked; }, 0);
      }, true);
    });
  `;

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>模擬フォーム（学傷補・学賠補用 活動届）</title>
<style>
 body{font:14px/1.6 system-ui,sans-serif;max-width:800px;margin:20px auto;padding:0 16px}
 [data-automation-id="questionItem"]{border:1px solid #ccc;border-radius:6px;padding:10px;margin:10px 0}
 [data-automation-id="questionTitle"]{font-weight:600;display:block;margin-bottom:6px}
 [role="radio"]{cursor:pointer;padding:2px 0}
 [role="radio"][aria-checked="true"]::before{content:"● "}
 [role="radio"][aria-checked="false"]::before{content:"○ "}
 [aria-haspopup="listbox"]{border:1px solid #888;border-radius:4px;padding:6px;cursor:pointer;background:#fff}
 [role="listbox"],.ms-DatePicker-callout{position:fixed;bottom:10px;right:10px;background:#fff;border:2px solid #333;padding:6px;z-index:999;max-height:40vh;overflow:auto}
 [role="option"]{cursor:pointer;padding:4px}
 input,textarea{width:100%;box-sizing:border-box;padding:6px}
</style></head>
<body>
<h1>模擬フォーム（テスト用・本物ではありません）</h1>
<div id="gsh-mock-questions">
${html}
</div>
<script>${behaviour}</script>
<script>${gating}</script>
</body></html>`;
}

/** 回答状態のスナップショットを取るスクリプト。probe 実行の前後で比較する。 */
export const SNAPSHOT_FN = `
function gshSnapshot() {
  return Array.prototype.map.call(
    document.querySelectorAll('[data-automation-id="questionItem"]'),
    function (q) {
      var inp = q.querySelector('input:not([type=radio]):not([type=checkbox]):not([type=file]), textarea');
      var checked = q.querySelector('[role="radio"][aria-checked="true"],[role="checkbox"][aria-checked="true"]');
      var dd = q.querySelector('[aria-haspopup="listbox"]');
      return {
        value: inp ? inp.value : null,
        // sibling 形式ではラジオ要素自身が空なので、親まで見て何が選ばれたかを identify する
        checked: checked
          ? (checked.getAttribute('aria-label') || checked.textContent
             || (checked.parentElement ? checked.parentElement.textContent : '')
             || checked.getAttribute('data-opt'))
          : null,
        dropdown: dd ? (dd.getAttribute('data-selected') || dd.textContent) : null,
        files: (function () { var f = q.querySelector('input[type=file]'); return f && f.files ? f.files.length : null; })()
      };
    }
  );
}
`;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.stdout.write(buildMockForm());
}
