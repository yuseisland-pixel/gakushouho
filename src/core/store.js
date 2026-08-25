/* store.js — 設定・メンバー辞書の保存と入出力。
 *
 * 二次配布のために「個人設定(personal)」と「団体設定(org)」を分けている。
 * personal は各自が必ず自分で入れる層で、団体配布用のエクスポートには含めない。
 * ここを混ぜると、配られた人が全員かおるさん名義で申請してしまう。
 */
(function (root) {
  'use strict';

  var KEY = 'gakushoho.v1';
  var SCHEMA = 1;

  function blank() {
    return {
      schemaVersion: SCHEMA,
      personal: {
        氏名: '', カナ氏名: '', 学籍番号: '',
        大学メール: '', 連絡先メール: '',
        設定日時: ''
      },
      /* 選択式の項目は、フォームが要求する正式文字列をそのまま持つ。
       * 「学生生活課」ではなく「学生生活課 Student Affairs Section」。
       * 事前入力は完全一致でないと通らないし、DOM クリックも完全一致で照合するため。 */
      org: {
        団体名: '', 活動名: '', 責任者名: '',
        加入区分: '1. 学傷補のみ加入 Register only for “Compensation for Injury”',
        活動区分: '7.その他 Other',
        申請先: '学生生活課 Student Affairs Section',
        申請先その他: '',        // 申請先が「その他」のときだけ使う
        既定の活動場所: '',
        既定の国内外: '1.国内 Domestic'
      },
      members: [],
      presets: [],
      formMap: null,        // 調査ブックマークレットの結果を取り込んだら入る
      /* 事前入力のパラメータ名の綴り。実機でしか判定できないので、
       * 利用者が「効いたほう」を選んだ結果をここに保存する。
       * null = 未判定（form-map.json の既定値を使う）／'' = 設問IDそのまま／'r' = r を前置 */
      prefillPrefix: null,
      prefillMaxParams: 0,  // Forms が先頭N問しか処理しない場合の上限。0 は無制限
      shortenUrl: false,    // 「URLが長すぎる」と言われたときに、長い自由記述を事前入力から外す
      draft: {
        活動内容: '', 活動場所: '', 活動開始日: '', 活動終了日: '', 備考: '', 参加者: []
      }
    };
  }

  function load() {
    var data;
    try {
      var raw = localStorage.getItem(KEY);
      data = raw ? JSON.parse(raw) : null;
    } catch (e) {
      data = null;
    }
    if (!data || data.schemaVersion !== SCHEMA) return blank();
    // 後から足したキーが欠けていても落ちないように、既定値で埋める
    var base = blank();
    ['personal', 'org', 'draft'].forEach(function (k) {
      data[k] = Object.assign({}, base[k], data[k] || {});
    });
    data.members = data.members || [];
    data.presets = data.presets || [];
    // 後から足したトップレベルの項目も既定値で埋める
    Object.keys(base).forEach(function (k) {
      if (data[k] === undefined) data[k] = base[k];
    });
    return data;
  }

  function save(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      return { ok: true };
    } catch (e) {
      // file:// で開いている・プライベートウィンドウ等で書けないことがある
      return { ok: false, error: '設定を保存できませんでした(' + (e && e.message) + ')。' +
        'JSON書き出しでバックアップを取ってください。' };
    }
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (e) { /* 消せなくても続行 */ }
  }

  /** 個人設定が埋まっているか。埋まるまでは他の機能を使わせない。 */
  function isPersonalReady(data) {
    var p = data.personal;
    return !!(p.氏名 && p.大学メール);
  }

  function newId() {
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---- エクスポート/インポート ------------------------------------
  // 3モード。「団体配布用」だけは personal を物理的に含めない。
  var MODES = {
    org: { label: '団体配布用(個人情報を含めない)', keys: ['org', 'members', 'presets', 'formMap'] },
    all: { label: '端末移行用(すべて)', keys: ['personal', 'org', 'members', 'presets', 'formMap'] },
    members: { label: 'メンバー辞書のみ', keys: ['members'] }
  };

  function exportData(data, mode) {
    var spec = MODES[mode] || MODES.org;
    var out = { schemaVersion: SCHEMA, exportMode: mode, exportedAt: new Date().toISOString() };
    spec.keys.forEach(function (k) { out[k] = data[k]; });
    if (mode !== 'org' || (data.members && data.members.length)) {
      out._注意 = 'このファイルには参加者の学籍番号と氏名が含まれます。共有範囲に注意してください。';
    }
    return JSON.stringify(out, null, 2);
  }

  /**
   * インポート。members は学籍番号をキーに重複排除する。
   * personal は「端末移行用」を読み込んだときだけ上書きする。
   */
  function importData(current, json) {
    var incoming = JSON.parse(json);
    if (incoming.schemaVersion !== SCHEMA) {
      throw new Error('対応していないバージョンのファイルです(schemaVersion=' + incoming.schemaVersion + ')。');
    }
    var next = JSON.parse(JSON.stringify(current));
    var report = [];

    if (incoming.personal) {
      next.personal = Object.assign({}, next.personal, incoming.personal);
      report.push('個人設定を上書きしました');
    }
    if (incoming.org) {
      next.org = Object.assign({}, next.org, incoming.org);
      report.push('団体設定を取り込みました');
    }
    if (incoming.presets) {
      next.presets = incoming.presets;
      report.push('活動プリセットを ' + incoming.presets.length + ' 件取り込みました');
    }
    if (incoming.formMap) {
      next.formMap = incoming.formMap;
      report.push('設問マッピングを取り込みました');
    }
    if (incoming.members) {
      var seen = {};
      next.members.forEach(function (m) { seen[m.学籍番号] = m; });
      var added = 0, updated = 0;
      incoming.members.forEach(function (m) {
        if (seen[m.学籍番号]) { Object.assign(seen[m.学籍番号], m); updated++; }
        else { next.members.push(Object.assign({ id: newId() }, m)); added++; }
      });
      report.push('メンバーを ' + added + ' 件追加、' + updated + ' 件更新しました');
    }
    return { data: next, report: report };
  }

  root.Store = {
    load: load, save: save, clear: clear, blank: blank,
    isPersonalReady: isPersonalReady, newId: newId,
    exportData: exportData, importData: importData, MODES: MODES
  };
})(window.GSH = window.GSH || {});
