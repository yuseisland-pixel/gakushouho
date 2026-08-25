/* app.js — 画面の制御。状態は Store、名簿生成は Roster、フォーム関連は Bookmarklet/Prefill に任せる。 */
(function (root) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var state = root.Store.load();

  // ビルド時に差し込まれる値
  var BUILD = { version: '__VERSION__', builtAt: '__BUILT_AT__', templateStamp: '__TEMPLATE_STAMP__' };
  var FORM_MAP = __FORM_MAP__;
  var TEMPLATE_B64 = '__TEMPLATE_B64__';

  function templateBytes() {
    var bin = atob(TEMPLATE_B64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function activeMap() {
    return (state.formMap && state.formMap.questions) || FORM_MAP.questions;
  }

  function entryBySource(source) {
    return activeMap().filter(function (q) { return q.source === source; })[0] || null;
  }

  function choicesFor(source) {
    var e = entryBySource(source);
    return (e && e.choices) || null;
  }

  /* 設定値をフォームの正式文字列に揃える。
   * 以前は「学生生活課」のような短い呼び名で持っていたが、フォームが要求するのは
   * 「学生生活課 Student Affairs Section」。事前入力は完全一致でないと通らない。
   * 保存済みの短い値は、選択肢の中から部分一致で一意に決まるものへ読み替える。
   * 一意に決まらなければ空にして、利用者に選び直してもらう。 */
  function migrateChoiceValues() {
    var changed = [];
    ['org.加入区分', 'org.活動区分', 'org.申請先', 'org.既定の国内外'].forEach(function (source) {
      var choices = choicesFor(source);
      if (!choices) return;
      var parts = source.split('.');
      var cur = state[parts[0]][parts[1]];
      if (!cur || choices.indexOf(cur) !== -1) return;   // 未設定か、既に正式文字列

      var hits = choices.filter(function (c) { return c.indexOf(cur) !== -1; });
      state[parts[0]][parts[1]] = hits.length === 1 ? hits[0] : '';
      changed.push(parts[1] + ': 「' + cur + '」→ ' + (hits.length === 1 ? '「' + hits[0] + '」' : '（選び直してください）'));
    });
    if (changed.length) persist();
    return changed;
  }

  function persist() {
    var r = root.Store.save(state);
    if (!r.ok) setMsg($('io-msg'), r.error, false);
  }

  function setMsg(node, text, ok) {
    node.textContent = text || '';
    node.className = 'msg' + (text ? (ok ? ' ok' : ' ng') : '');
  }

  // ---- 双方向バインド ------------------------------------------------
  var FIELDS = [
    ['p-name', 'personal', '氏名'], ['p-kana', 'personal', 'カナ氏名'], ['p-sid', 'personal', '学籍番号'],
    ['p-mail', 'personal', 'メールアドレス'],
    ['ap-name', 'applicant', '氏名'], ['ap-mail', 'applicant', 'メール'], ['ap-share-mail', 'applicant', '共有メール'],
    ['o-org', 'org', '団体名'], ['o-act', 'org', '活動名'], ['o-resp', 'org', '責任者名'],
    ['o-ins', 'org', '加入区分'], ['o-kind', 'org', '活動区分'],
    ['o-allreg', 'org', '全員科目登録者'], ['o-window', 'org', '申請先'],
    ['o-window-other', 'org', '申請先その他'],
    ['o-place', 'org', '既定の活動場所'], ['o-area', 'org', '既定の国内外'],
    ['a-content', 'draft', '活動内容'], ['a-place', 'draft', '活動場所'],
    ['a-start', 'draft', '活動開始日'], ['a-end', 'draft', '活動終了日'],
    ['a-remarks', 'draft', '備考']
  ];

  /* 選択式の項目に、フォームの選択肢をそのまま並べる。
   * 自由入力のままだと表記ゆれで一致しなくなるので、選ばせるのが確実。 */
  var SELECTS = [
    ['o-ins', 'org.加入区分'],
    ['o-kind', 'org.活動区分'],
    ['o-allreg', 'org.全員科目登録者'],
    ['o-window', 'org.申請先'],
    ['o-area', 'org.既定の国内外']
  ];

  // 申請者情報の辞書対象フィールド [input要素ID, state上のキー, state上のオブジェクト, chips要素ID, save要素ID]
  var HISTORY_FIELDS = [
    ['ap-name', 'applicant', '氏名', 'ap-name-chips', 'ap-name-save'],
    ['ap-mail', 'applicant', 'メール', 'ap-mail-chips', 'ap-mail-save']
  ];

  // 団体プリセットの対象フィールド（state.org のキー）
  var ORG_PRESET_FIELDS = ['団体名', '活動名', '責任者名', '加入区分', '活動区分', '全員科目登録者', '申請先', '申請先その他', '既定の活動場所', '既定の国内外'];

  function populateSelects() {
    SELECTS.forEach(function (s) {
      var node = $(s[0]);
      var choices = choicesFor(s[1]);
      node.textContent = '';
      if (!choices) {
        // 選択肢が未取得のときは自由入力に退避する（フォーム未調査の状態）
        node.appendChild(new Option('（選択肢が未取得です）', ''));
        return;
      }
      node.appendChild(new Option('選択してください', ''));
      choices.forEach(function (c) { node.appendChild(new Option(c, c)); });
    });
  }

  function syncSelfMember() {
    var sid = state.personal.学籍番号 || '';
    if (sid) {
      state.members = state.members.filter(function (m) { return m.id === 'self' || m.学籍番号 !== sid; });
    }
    var self = state.members.filter(function (m) { return m.id === 'self'; })[0];
    if (!self) {
      self = { id: 'self', 学籍番号: '', カナ氏名: '', 表示名: '' };
      state.members.unshift(self);
    }
    self.学籍番号 = sid;
    self.カナ氏名 = state.personal.カナ氏名 || '';
    self.表示名 = state.personal.氏名 || self.カナ氏名;
  }

  function bindFields() {
    FIELDS.forEach(function (f) {
      var node = $(f[0]);
      node.value = state[f[1]][f[2]] || '';
      node.addEventListener('input', function () {
        state[f[1]][f[2]] = node.value;
        if (f[1] === 'personal') {
          state.personal.設定日時 = state.personal.設定日時 || new Date().toISOString();
          if (f[2] === '氏名' || f[2] === 'カナ氏名' || f[2] === '学籍番号') {
            syncSelfMember();
          }
          if (f[2] === 'メールアドレス' && state.applicant.共有メール自分を使う) {
            state.applicant.共有メール = node.value;
            $('ap-share-mail').value = node.value;
          }
        }
        persist();
        refresh();
      });
    });
  }

  // 指定された ID の input/select の値だけを再同期（リスナーの重複登録を避けるため、bindFields() の軽量版）
  function syncFieldValues(ids) {
    FIELDS.forEach(function (f) {
      if (ids.indexOf(f[0]) === -1) return;
      $(f[0]).value = state[f[1]][f[2]] || '';
    });
  }

  // 個人情報履歴をチップとして描画
  function renderFieldHistory(key, chipsId, inputId) {
    var box = $(chipsId);
    box.textContent = '';
    var input = $(inputId);
    (state.history[key] || []).forEach(function (value) {
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = '<span class="chip-text"></span><button type="button" class="chip-del">✕</button>';
      chip.querySelector('.chip-text').textContent = value;

      chip.querySelector('.chip-text').addEventListener('click', function () {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      chip.querySelector('.chip-del').addEventListener('click', function () {
        state.history[key] = (state.history[key] || []).filter(function (v) { return v !== value; });
        persist();
        renderFieldHistory(key, chipsId, inputId);
      });

      box.appendChild(chip);
    });
  }

  // 個人情報の値を履歴に保存するボタンのハンドラー
  function wireHistorySave(saveId, inputId, key) {
    $(saveId).addEventListener('click', function () {
      var value = $(inputId).value.trim();
      if (!value) return;
      var hist = state.history[key] = state.history[key] || [];
      if (hist.indexOf(value) === -1) {
        hist.unshift(value);
        if (hist.length > 10) hist.pop();
        persist();
        renderFieldHistory(key, HISTORY_FIELDS.find(function (f) { return f[4] === saveId; })[3], inputId);
      }
    });
  }

  // ---- メンバー辞書 --------------------------------------------------
  function renderMembers() {
    var box = $('member-list');
    box.textContent = '';
    var filter = $('m-filter').value.trim();
    var selected = new Set(state.draft.参加者 || []);

    state.members
      .filter(function (m) {
        if (!filter) return true;
        return (m.表示名 + m.カナ氏名 + m.学籍番号).indexOf(filter) !== -1;
      })
      .forEach(function (m) {
        var problems = root.Roster.validateMember(m);
        var row = document.createElement('div');
        row.className = 'member' + (problems.length ? ' bad' : '') + (m.id === 'self' ? ' self' : '');
        if (problems.length) row.title = problems.join('\n');

        var lab = document.createElement('label');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selected.has(m.id);
        cb.addEventListener('change', function () {
          var s = new Set(state.draft.参加者 || []);
          if (cb.checked) s.add(m.id); else s.delete(m.id);
          state.draft.参加者 = Array.from(s);
          persist();
          refresh();
        });

        var who = document.createElement('span');
        who.className = 'who';
        var b = document.createElement('b');
        b.textContent = m.表示名 || m.カナ氏名;
        var s2 = document.createElement('span');
        s2.textContent = m.学籍番号 + ' / ' + m.カナ氏名 + (problems.length ? '  ⚠ 書式要確認' : '');
        who.appendChild(b); who.appendChild(s2);

        lab.appendChild(cb); lab.appendChild(who);

        var del = document.createElement('button');
        del.className = 'del';
        del.textContent = '✕';
        del.title = 'このメンバーを削除';

        if (m.id === 'self') {
          del.style.display = 'none';
          var tag = document.createElement('span');
          tag.className = 'self-tag';
          tag.textContent = 'あなた自身（削除不可）';
          row.appendChild(lab); row.appendChild(tag);
        } else {
          del.addEventListener('click', function () {
            if (!confirm(m.表示名 + ' を辞書から削除します。よろしいですか？')) return;
            state.members = state.members.filter(function (x) { return x.id !== m.id; });
            state.draft.参加者 = (state.draft.参加者 || []).filter(function (id) { return id !== m.id; });
            persist(); refresh();
          });
          row.appendChild(lab); row.appendChild(del);
        }
        box.appendChild(row);
      });

    $('m-count').textContent = '登録 ' + state.members.length + ' 名 / 選択 ' + (state.draft.参加者 || []).length + ' 名';
  }

  function addMember(sid, kana, name) {
    sid = String(sid || '').trim().split('-')[0];   // ハイフン以降は不要
    kana = String(kana || '').trim();
    name = String(name || '').trim() || kana;
    if (!sid || !kana) { alert('学籍番号とカナ氏名は必須です。'); return false; }
    if (state.members.some(function (m) { return m.学籍番号 === sid; })) {
      alert('学籍番号 ' + sid + ' は既に登録されています。');
      return false;
    }
    var m = { id: root.Store.newId(), 学籍番号: sid, カナ氏名: kana, 表示名: name };
    state.members.push(m);
    var s = new Set(state.draft.参加者 || []);
    s.add(m.id);
    state.draft.参加者 = Array.from(s);
    persist();
    return true;
  }

  // ---- プリセット ----------------------------------------------------
  function renderPresets() {
    var sel = $('preset-sel');
    var keep = sel.value;
    sel.textContent = '';
    var head = document.createElement('option');
    head.value = ''; head.textContent = 'プリセットを選ぶ…';
    sel.appendChild(head);
    state.presets.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id; o.textContent = p.name;
      sel.appendChild(o);
    });
    sel.value = keep;
  }

  function renderOrgPresets() {
    var sel = $('org-preset-sel');
    var keep = sel.value;
    sel.textContent = '';
    var head = document.createElement('option');
    head.value = ''; head.textContent = 'プリセットを選ぶ…';
    sel.appendChild(head);
    state.orgPresets.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id; o.textContent = p.name;
      sel.appendChild(o);
    });
    sel.value = keep;
  }

  // ---- 集計 ----------------------------------------------------------
  function selectedMembers() {
    var order = {};
    state.members.forEach(function (m, i) { order[m.id] = i; });
    return (state.draft.参加者 || [])
      .map(function (id) { return state.members.find(function (m) { return m.id === id; }); })
      .filter(Boolean)
      .sort(function (a, b) { return order[a.id] - order[b.id]; });
  }

  function collectIssues() {
    var out = [];
    if (!root.Store.isPersonalReady(state)) out.push('「1. あなたの情報」の氏名と、「2. 申請者の情報」の氏名・メールアドレスを入れてください。');
    var members = selectedMembers();
    if (!members.length) out.push('参加者が選ばれていません。「4. メンバー辞書」でチェックを入れてください。');
    if (members.length > root.Roster.MAX_MEMBERS) {
      out.push('参加者が ' + members.length + ' 名です。このテンプレートは ' + root.Roster.MAX_MEMBERS + ' 名までです。');
    }
    members.forEach(function (m) {
      root.Roster.validateMember(m).forEach(function (p) { out.push(m.表示名 + '：' + p); });
    });
    if (!state.draft.活動開始日) out.push('活動開始日を入れてください。');
    if (!state.draft.活動終了日) out.push('活動終了日を入れてください。');
    if (state.draft.活動開始日 && state.draft.活動終了日 && state.draft.活動終了日 < state.draft.活動開始日) {
      out.push('活動終了日が活動開始日より前になっています。');
    }
    if (!(state.draft.活動場所 || state.org.既定の活動場所)) out.push('活動場所を入れてください。');
    return out;
  }

  /* filler / prefill に渡す値。form-map.json の source 表記
   * （personal.* / applicant.* / org.* / draft.* / derived.*）とそのまま対応させる。
   * 以前は settings.* に詰め替えていたが、対応表が二重管理になるのでやめた。 */
  function fillerValues() {
    return {
      personal: state.personal,
      applicant: state.applicant,
      org: state.org,
      draft: Object.assign({}, state.draft, {
        活動場所: state.draft.活動場所 || state.org.既定の活動場所
      }),
      derived: {
        参加学生数: String(selectedMembers().length)
      }
    };
  }

  // ---- 出力 ----------------------------------------------------------
  function download(bytes, filename, mime) {
    var blob = new Blob([bytes], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  async function makeRoster() {
    var issues = collectIssues();
    if (issues.length) {
      setMsg($('roster-msg'), '入力に不足があります。上の一覧を確認してください。', false);
      return;
    }
    setMsg($('roster-msg'), '作成中…', true);
    try {
      var v = fillerValues();
      var bytes = await root.Roster.generate(templateBytes(), {
        申請者氏名: v.applicant.氏名,
        活動名: v.org.活動名 || v.draft.活動内容,
        責任者名: v.org.責任者名,
        活動場所: v.draft.活動場所,
        活動開始日: v.draft.活動開始日,
        活動終了日: v.draft.活動終了日,
        members: selectedMembers()
      });
      // File System Access API で保存を試す（Edge/Chrome で選択済みのフォルダがあれば使う）
      var saveResult = null;
      try {
        saveResult = await root.SaveTarget.saveRoster(bytes);
      } catch (e) {
        // 保存エラーは警告するが、従来の download にフォールバックして進める
        setMsg($('roster-msg'), '警告: フォルダへの保存に失敗しました。ブラウザの自動ダウンロード機能で保存します。（詳細: ' + (e && e.message || e) + '）', false);
      }
      if (!saveResult) {
        // フォルダ未選択 or API 非対応 → 従来の download を使う（固定ファイル名）
        download(bytes, root.SaveTarget.ORIGINAL_FILENAME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      }
      setMsg($('roster-msg'), '作成しました（' + selectedMembers().length + ' 名）。提出後、不要になったら削除してください。', true);
    } catch (e) {
      setMsg($('roster-msg'), '失敗しました：' + (e && e.message || e), false);
      console.error(e);
    }
  }

  /* ブックマークレットはロジックだけ。値は「フォームを開く」リンクの # で渡す。
   * これで、設定を変えても登録し直しが要らなくなる（以前は毎回必要だった）。 */
  function refreshBookmarklet() {
    var url = root.Bookmarklet.buildStatic();
    var info = root.Bookmarklet.sizeInfo(url);
    $('bm-link').href = url;
    $('bm-text').value = url;
    $('bm-size').textContent = info.サイズ + '・一度登録すればずっと同じ';
    $('bm-warn').textContent = info.警告 || '';
  }

  function formBaseUrl(src) {
    // 事前入力 URL は「?id=」を含む完全な URL から組む。短縮 URL では作れない
    return src.responseUrl
      || (src.formOrigin && src.formPath && src.formId
        ? src.formOrigin + src.formPath + '?id=' + src.formId : null);
  }

  /* 設問1つに入れる生の値。書式の調整はここではやらない。
   * 事前入力（yyyy-MM-dd＋引用符）とブックマークレット（yyyy/MM/dd）で
   * 要求される書式が違うので、それぞれの側で整える。
   * 以前ここで日付をスラッシュに変換していたため、事前入力側が壊れていた。 */
  function valueForQuestion(q, v) {
    if (!q.source) return '';
    var val = q.source.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, v);
    return val == null ? '' : String(val);
  }

  function refreshPrefill() {
    var block = $('prefill-block');
    var src = state.formMap || FORM_MAP;
    var map = src.questions || [];
    var formUrl = formBaseUrl(src);

    if (!formUrl || !map.some(function (q) { return q.qid; })) {
      block.classList.add('hidden');
      return;
    }
    block.classList.remove('hidden');

    var v = fillerValues();
    var payload = root.Bookmarklet.encodePayload(src, v);

    /* リンクは事前入力クエリだけ。ハッシュ（#gsh=）は載せない。
     *
     * AADSTS90015（URL が長すぎる）が出たとき内訳を測ったら、
     * 全体 7,089文字のうち **5,652文字（80%）がハッシュ**で、
     * 事前入力クエリは 1,292文字だった。膨らませていたのはハッシュのほうだった。
     * ハッシュを外すだけで 1,437文字に収まる。
     *
     * ブックマークレットへは、リンクを押したときにクリップボード経由で渡す。
     * filler は ハッシュ → クリップボード → 貼り付け欄 の順に値を探す。 */
    var r = root.Prefill.build(formUrl, map, function (q) { return valueForQuestion(q, v); }, {
      prefix: src.prefillPrefix || '',
      /* 短縮時の目安。1,050 にすると長い自由記述3つ（活動内容・活動場所・科目名）だけが
       * 外れて 1,005 文字に収まり、氏名やメールのような短い項目は残る。
       * これ以上下げると短い項目まで削れて損なので、下げすぎない。 */
      maxUrl: state.shortenUrl ? 1050 : root.Prefill.MAX_URL
    });
    var link = r.url || formUrl;
    $('prefill-link').href = link;
    $('prefill-count').textContent = 'URL ' + link.length.toLocaleString() + ' 文字 / '
      + r.included.length + ' 問';

    $('prefill-link').onclick = function () {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(payload).catch(function () { /* 失敗しても開く */ });
        }
      } catch (e) { /* 開く動作は妨げない */ }
    };

    var note = $('prefill-note');
    note.textContent = '';
    var lead = 'このフォームは、5番に答えると6〜8番、8番に答えるとその先が出てくる段階表示です。';
    note.appendChild(document.createTextNode(lead));
    if (r.skipped.length) {
      note.appendChild(document.createTextNode(' 次の項目はリンクに載せていません（③で埋まります）：'));
      var ul = document.createElement('ul');
      r.skipped.forEach(function (s) {
        var li = document.createElement('li');
        li.textContent = s.label + '（' + s.reason + '）';
        ul.appendChild(li);
      });
      note.appendChild(ul);
    }
  }

  function refreshIssues() {
    var box = $('issues');
    var issues = collectIssues();
    box.textContent = '';
    if (!issues.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    var h = document.createElement('strong');
    h.textContent = '入力を確認してください';
    var ul = document.createElement('ul');
    issues.forEach(function (t) {
      var li = document.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    });
    box.appendChild(h); box.appendChild(ul);
  }

  /* フォームに入る内容を、設問見出し付きの一覧で見せる。
   * フォームを17問スクロールして目視するより、ここで1画面で確認するほうが確実。 */
  function refreshReview() {
    var box = $('review');
    box.textContent = '';
    var v = fillerValues();
    var table = document.createElement('table');
    table.className = 'review';

    activeMap().forEach(function (q) {
      var tr = document.createElement('tr');
      var name = document.createElement('td');
      name.textContent = q.label;
      var val = document.createElement('td');

      if (q.type === 'file') {
        val.textContent = '（手で添付します）';
        val.className = 'muted';
      } else if (q.condition) {
        var dep = activeMap().filter(function (x) { return x.qid === q.condition.dependsOn; })[0];
        var depVal = dep ? String(q.source.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, v) || '') : '';
        var depNow = dep ? String(dep.source.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, v) || '') : '';
        if (depNow.indexOf(q.condition.startsWith) === 0) {
          val.textContent = depVal || '（未入力）';
          if (!depVal) val.className = 'warn-cell';
        } else {
          val.textContent = '（対象外なので入力しません）';
          val.className = 'muted';
        }
      } else {
        var raw = q.source
          ? q.source.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, v)
          : null;
        if (raw == null || raw === '') {
          val.textContent = '（未入力・そのままにします）';
          val.className = 'muted';
        } else {
          val.textContent = String(raw);
        }
      }
      tr.appendChild(name); tr.appendChild(val);
      table.appendChild(tr);
    });
    box.appendChild(table);
  }

  function refreshCountBadge() {
    var n = selectedMembers().length;
    var node = $('count-badge');
    if (!n) { node.textContent = ''; return; }
    node.textContent = '参加学生数は ' + n + ' 名として自動で入ります（名簿の行数と同じ）。';
  }

  function refresh() {
    var ready = root.Store.isPersonalReady(state);
    $('gate').classList.toggle('hidden', ready);
    $('btn-roster').disabled = !ready;
    /* フォームと同じ条件でだけ欄を出す。条件を満たさない設問はフォームにも現れないので、
     * ここで値を持たせても使い道がなく、選ばせると誤った申請のもとになる。 */
    // 申請先が「その他」のときだけ、箇所名の入力欄を出す
    $('o-window-other-wrap').classList.toggle('hidden', String(state.org.申請先 || '').indexOf('その他') !== 0);
    // 活動の種類が「1.授業」のときだけ、全員科目登録者かの欄を出す
    $('o-allreg-wrap').classList.toggle('hidden', String(state.org.活動区分 || '').indexOf('1.授業') !== 0);
    renderMembers();
    refreshCountBadge();
    refreshIssues();
    refreshReview();
    refreshBookmarklet();
    refreshPrefill();
  }

  // ---- 設問マッピングの取り込み --------------------------------------
  function applyProbe(json) {
    var probe = JSON.parse(json);
    var api = probe.設問;
    if (!Array.isArray(api) || !api.length) {
      throw new Error('設問一覧が入っていません。調査ブックマークレットの出力をそのまま貼り付けてください。');
    }
    // 既存マップの label/source を保ちつつ、見出しと設問 ID を埋める
    var base = (state.formMap && state.formMap.questions) || FORM_MAP.questions;
    var used = {};
    var questions = base.map(function (entry) {
      var hit = api.find(function (q) {
        if (used[q.id]) return false;
        if (entry.match && q.title.indexOf(entry.match) !== -1) return true;
        return entry.fallbackIndex != null && q.order === entry.fallbackIndex;
      });
      if (!hit) return Object.assign({}, entry);
      used[hit.id] = true;
      return Object.assign({}, entry, { match: hit.title, qid: hit.id, choices: hit.choices || null });
    });

    state.formMap = {
      formVersion: probe.収集日時 || new Date().toISOString(),
      responseUrl: probe.ページURL || null,
      host: probe.ホスト || null,
      questions: questions,
      未対応の設問: api.filter(function (q) { return !used[q.id]; }).map(function (q) {
        return { order: q.order, title: q.title, type: q.type };
      })
    };
    persist();
    return state.formMap;
  }

  // ---- 保存先フォルダの状態管理 -----------------------------------------
  async function updateSaveTargetStatus() {
    var statusEl = $('save-target-status');
    var pickBtn = $('btn-pick-folder');
    if (!root.SaveTarget.isSupported()) {
      $('save-target-section').style.display = 'none';
      return;
    }
    var handle = await root.SaveTarget.getSavedFolderHandle();
    if (handle) {
      statusEl.textContent = '✓ フォルダが選択されています';
      statusEl.style.color = '#2e7d32';
    } else {
      statusEl.textContent = '未選択';
      statusEl.style.color = '#666';
    }
  }

  // ---- 起動 ----------------------------------------------------------
  function wire() {
    $('version').textContent = 'バージョン ' + BUILD.version + '（ビルド ' + BUILD.builtAt + ' / 名簿テンプレ ' + BUILD.templateStamp + '）';

    $('m-add').addEventListener('click', function () {
      if (addMember($('m-sid').value, $('m-kana').value, $('m-name').value)) {
        $('m-sid').value = ''; $('m-kana').value = ''; $('m-name').value = '';
        refresh();
      }
    });
    $('m-filter').addEventListener('input', renderMembers);
    $('m-all').addEventListener('click', function () {
      state.draft.参加者 = state.members.map(function (m) { return m.id; });
      persist(); refresh();
    });
    $('m-none').addEventListener('click', function () {
      state.draft.参加者 = []; persist(); refresh();
    });

    // 個人情報の履歴を初期化・ハンドラー登録
    HISTORY_FIELDS.forEach(function (f) {
      var inputId = f[0], objKey = f[1], stateKey = f[2], chipsId = f[3], saveId = f[4];
      renderFieldHistory(stateKey, chipsId, inputId);
      wireHistorySave(saveId, inputId, stateKey);
    });

    // 共有用メールアドレスの「自分のアドレスを使う」チェックボックス
    $('ap-share-use-own').checked = !!state.applicant.共有メール自分を使う;
    $('ap-share-mail').disabled = !!state.applicant.共有メール自分を使う;
    $('ap-share-use-own').addEventListener('change', function () {
      state.applicant.共有メール自分を使う = $('ap-share-use-own').checked;
      if (state.applicant.共有メール自分を使う) {
        state.applicant.共有メール = state.personal.メールアドレス || '';
        $('ap-share-mail').value = state.applicant.共有メール;
      }
      $('ap-share-mail').disabled = state.applicant.共有メール自分を使う;
      persist(); refresh();
    });

    // 団体情報プリセットのハンドラー登録
    $('org-preset-sel').addEventListener('change', function () {
      var p = state.orgPresets.find(function (x) { return x.id === $('org-preset-sel').value; });
      if (!p) return;
      ORG_PRESET_FIELDS.forEach(function (key) {
        state.org[key] = p[key] || '';
      });
      persist();
      var orgFieldIds = ['o-org', 'o-act', 'o-resp', 'o-ins', 'o-kind', 'o-allreg', 'o-window', 'o-window-other', 'o-place', 'o-area'];
      syncFieldValues(orgFieldIds);
      refresh();
    });
    $('org-preset-save').addEventListener('click', function () {
      var name = prompt('プリセット名を入力してください', state.org.団体名.slice(0, 20));
      if (!name) return;
      var preset = { id: root.Store.newId(), name: name };
      ORG_PRESET_FIELDS.forEach(function (key) {
        preset[key] = state.org[key] || '';
      });
      state.orgPresets.push(preset);
      persist(); renderOrgPresets();
    });
    $('org-preset-del').addEventListener('click', function () {
      var id = $('org-preset-sel').value;
      if (!id) return;
      state.orgPresets = state.orgPresets.filter(function (p) { return p.id !== id; });
      persist(); renderOrgPresets();
    });

    $('preset-sel').addEventListener('change', function () {
      var p = state.presets.find(function (x) { return x.id === $('preset-sel').value; });
      if (!p) return;
      state.draft.活動内容 = p.活動内容 || '';
      state.draft.活動場所 = p.活動場所 || '';
      $('a-content').value = state.draft.活動内容;
      $('a-place').value = state.draft.活動場所;
      persist(); refresh();
    });
    $('preset-save').addEventListener('click', function () {
      var name = prompt('プリセット名を入力してください', state.draft.活動内容.slice(0, 20));
      if (!name) return;
      state.presets.push({
        id: root.Store.newId(), name: name,
        活動内容: state.draft.活動内容, 活動場所: state.draft.活動場所
      });
      persist(); renderPresets();
    });
    $('preset-del').addEventListener('click', function () {
      var id = $('preset-sel').value;
      if (!id) return;
      state.presets = state.presets.filter(function (p) { return p.id !== id; });
      persist(); renderPresets();
    });

    $('shorten-url').checked = !!state.shortenUrl;
    $('shorten-url').addEventListener('change', function () {
      state.shortenUrl = $('shorten-url').checked;
      persist(); refresh();
    });

    $('btn-roster').addEventListener('click', makeRoster);

    $('btn-pick-folder').addEventListener('click', function () {
      root.SaveTarget.pickFolder().then(function (handle) {
        if (handle) {
          setMsg($('roster-msg'), 'フォルダを選択しました。これ以降、名簿は同名ファイルがあれば自動的に old/ に移してから保存します。', true);
          updateSaveTargetStatus();
        } else {
          setMsg($('roster-msg'), 'キャンセルされました。', false);
        }
      }).catch(function (e) {
        setMsg($('roster-msg'), 'フォルダ選択に失敗しました：' + (e && e.message || e), false);
      });
    });

    $('bm-copy').addEventListener('click', function () {
      var ta = $('bm-text');
      ta.select();
      navigator.clipboard.writeText(ta.value).then(
        function () { setMsg($('roster-msg'), '', true); alert('コピーしました。ブックマークを新規作成し、URL 欄に貼り付けてください。'); },
        function () { alert('コピーできませんでした。テキストを手で選択してコピーしてください。'); }
      );
    });

    // データ入出力 - チェックボックスとテンプレートボタンの生成
    var expBox = $('export-checks');
    root.Store.EXPORT_FIELDS.forEach(function (f) {
      var lab = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.id = 'exp-' + f.key;
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(f.label));
      expBox.appendChild(lab);
    });

    function applyExportTemplate(keys) {
      root.Store.EXPORT_FIELDS.forEach(function (f) {
        $('exp-' + f.key).checked = keys.indexOf(f.key) !== -1;
      });
    }
    applyExportTemplate(root.Store.EXPORT_TEMPLATES.org.keys);

    var tmplBox = $('export-templates-buttons');
    Object.keys(root.Store.EXPORT_TEMPLATES).forEach(function (k) {
      var t = root.Store.EXPORT_TEMPLATES[k];
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'ghost tiny';
      btn.textContent = t.label;
      btn.addEventListener('click', function () { applyExportTemplate(t.keys); });
      tmplBox.appendChild(btn);
    });

    $('btn-export').addEventListener('click', function () {
      var keys = root.Store.EXPORT_FIELDS.map(function (f) { return f.key; }).filter(function (k) { return $('exp-' + k).checked; });
      if (!keys.length) { setMsg($('io-msg'), '書き出す項目を1つ以上選んでください。', false); return; }
      var json = root.Store.exportData(state, keys);
      var sensitive = ['personal', 'applicant', 'history', 'members'].some(function (k) { return keys.indexOf(k) !== -1; });
      if (sensitive && !confirm('このファイルには個人情報が含まれます。共有範囲に注意してください。書き出しますか？')) return;
      download(new TextEncoder().encode(json), '学傷補設定_' + (state.org.団体名 || '設定') + '_' + root.Roster.todayIso().replace(/-/g, '') + '.json', 'application/json');
      setMsg($('io-msg'), '書き出しました。', true);
    });
    $('imp-file').addEventListener('change', function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      f.text().then(function (t) {
        try {
          var r = root.Store.importData(state, t);
          state = r.data; persist();
          bindFields(); syncSelfMember(); renderPresets(); renderOrgPresets(); refresh();
          setMsg($('io-msg'), r.report.join(' / '), true);
        } catch (e) {
          setMsg($('io-msg'), '読み込めませんでした：' + (e && e.message || e), false);
        }
        ev.target.value = '';
      });
    });
    $('btn-clear').addEventListener('click', function () {
      if (!confirm('この端末に保存した設定・メンバー辞書をすべて削除します。元に戻せません。よろしいですか？')) return;
      root.Store.clear();
      state = root.Store.blank();
      bindFields(); syncSelfMember(); renderPresets(); renderOrgPresets(); refresh();
      setMsg($('io-msg'), '削除しました。', true);
    });

    $('probe-link').href = 'javascript:' + encodeURIComponent('__PROBE_SOURCE__');
    $('probe-apply').addEventListener('click', function () {
      try {
        var m = applyProbe($('probe-paste').value);
        var withQid = m.questions.filter(function (q) { return q.qid; }).length;
        setMsg($('probe-msg'),
          '取り込みました。設問見出しを ' + m.questions.filter(function (q) { return q.match; }).length + ' 件、' +
          '設問IDを ' + withQid + ' 件登録しました。' +
          (m.未対応の設問.length ? '未対応の設問が ' + m.未対応の設問.length + ' 件あります。' : ''), true);
        refresh();
      } catch (e) {
        setMsg($('probe-msg'), '取り込めませんでした：' + (e && e.message || e), false);
      }
    });
  }

  // 選択肢を先に流し込んでから値を割り当てる（順序を逆にすると select の値が入らない）
  populateSelects();
  var migrated = migrateChoiceValues();
  bindFields();
  syncSelfMember();
  renderPresets();
  renderOrgPresets();
  wire();
  updateSaveTargetStatus();
  refresh();
  if (migrated.length) {
    setMsg($('io-msg'),
      'フォームの正式な選択肢に合わせて設定を更新しました（' + migrated.join(' / ') + '）', true);
  }
})(window.GSH = window.GSH || {});
