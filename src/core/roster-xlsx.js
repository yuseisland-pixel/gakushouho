/* roster-xlsx.js — 大学指定の名簿テンプレに値だけ差し込んで xlsx を作る。
 *
 * テンプレは原本のまま保ち、xl/worksheets/sheet1.xml と xl/workbook.xml だけを書き換え、
 * xl/calcChain.xml を落とす。それ以外のエントリ(styles.xml / customXml/* / docProps/*)は
 * 圧縮済みバイト列のまま素通しするので、大学側の SharePoint / Power Automate の処理を壊さない。
 */
(function (root) {
  'use strict';

  var SHEET = 'xl/worksheets/sheet1.xml';
  var WORKBOOK = 'xl/workbook.xml';
  var CALC_CHAIN = 'xl/calcChain.xml';

  var FIRST_ROW = 11;   // テーブル1 のデータ行は 11〜60
  var LAST_ROW = 60;
  var MAX_MEMBERS = LAST_ROW - FIRST_ROW + 1;   // 50

  function escapeXml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  /** 'YYYY-MM-DD' を Excel のシリアル値(1899-12-30 起点)に変換する。 */
  function toSerial(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
    if (!m) throw new Error('日付は YYYY-MM-DD 形式で指定してください: ' + iso);
    var days = (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000;
    return Math.round(days);
  }

  function todayIso() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // 空セル <c r="B11" s="3"/> を探して中身を入れる。
  // テンプレ側でセルが存在しない/既に埋まっている場合は、想定と違うテンプレなので例外にする。
  function fillCell(xml, ref, inner) {
    var re = new RegExp('<c r="' + ref + '"([^>/]*)/>');
    if (!re.test(xml)) {
      throw new Error('テンプレの空セル ' + ref + ' が見つかりません。名簿テンプレが更新された可能性があります。');
    }
    return xml.replace(re, function (_, attrs) { return '<c r="' + ref + '"' + attrs + '>' + inner + '</c>'; });
  }

  function setString(xml, ref, value) {
    var re = new RegExp('<c r="' + ref + '"([^>/]*)/>');
    if (!re.test(xml)) {
      throw new Error('テンプレの空セル ' + ref + ' が見つかりません。名簿テンプレが更新された可能性があります。');
    }
    return xml.replace(re, function (_, attrs) {
      return '<c r="' + ref + '"' + attrs + ' t="inlineStr"><is><t xml:space="preserve">' + escapeXml(value) + '</t></is></c>';
    });
  }

  function setNumber(xml, ref, value) {
    return fillCell(xml, ref, '<v>' + value + '</v>');
  }

  // H列の status は数式列。キャッシュ値 F が残ったままだと開いた直後に F と表示されるので
  // T に書き換える(併せて workbook.xml に fullCalcOnLoad を立てて再計算もさせる)。
  function setStatusT(xml, row) {
    var re = new RegExp('(<c r="H' + row + '"[\\s\\S]*?)<v>F</v>');
    if (!re.test(xml)) {
      throw new Error('H' + row + ' の status セルが想定と異なります。名簿テンプレが更新された可能性があります。');
    }
    return xml.replace(re, '$1<v>T</v>');
  }

  /**
   * 参加者名簿の xlsx バイト列を作る。
   *
   * @param {Uint8Array} templateBytes  テンプレ xlsx の中身
   * @param {Object} data
   *   申請者氏名, 活動名, 責任者名 : ヘッダ部(B1/B2/B3)
   *   活動場所, 活動開始日, 活動終了日 : 全参加者共通の値
   *   申請年月日 : 省略時は当日
   *   members : [{ 学籍番号, カナ氏名 }]
   * @returns {Promise<Uint8Array>}
   */
  async function generate(templateBytes, data) {
    var members = data.members || [];
    if (members.length === 0) throw new Error('参加者が 1 人も選ばれていません。');
    if (members.length > MAX_MEMBERS) {
      throw new Error('参加者が ' + members.length + ' 名です。このテンプレは ' + MAX_MEMBERS +
        ' 名までなので、超える分は Excel で行を追加し、テーブル1 の範囲を広げてください。');
    }

    var 申請年月日 = toSerial(data.申請年月日 || todayIso());
    var 活動開始日 = toSerial(data.活動開始日);
    var 活動終了日 = toSerial(data.活動終了日);
    if (活動終了日 < 活動開始日) throw new Error('活動終了日が活動開始日より前になっています。');

    var entries = root.Zip.parse(templateBytes);
    var byName = {};
    entries.forEach(function (e) { byName[e.name] = e; });
    if (!byName[SHEET] || !byName[WORKBOOK]) {
      throw new Error('テンプレの構成が想定と違います(sheet1.xml / workbook.xml が見つかりません)。');
    }

    var xml = await root.Zip.readText(byName[SHEET]);

    xml = setString(xml, 'B1', data.申請者氏名 || '');
    xml = setString(xml, 'B2', data.活動名 || '');
    xml = setString(xml, 'B3', data.責任者名 || '');

    members.forEach(function (m, i) {
      var row = FIRST_ROW + i;
      xml = setString(xml, 'B' + row, m.学籍番号);
      xml = setString(xml, 'C' + row, m.カナ氏名);
      xml = setNumber(xml, 'D' + row, 申請年月日);
      xml = setNumber(xml, 'E' + row, 活動開始日);
      xml = setNumber(xml, 'F' + row, 活動終了日);
      xml = setString(xml, 'G' + row, data.活動場所 || '');
      xml = setStatusT(xml, row);
    });

    var wb = await root.Zip.readText(byName[WORKBOOK]);
    if (!/fullCalcOnLoad/.test(wb)) {
      wb = wb.replace(/<calcPr([^>]*?)\/>/, '<calcPr$1 fullCalcOnLoad="1"/>');
    }

    var enc = new TextEncoder();
    var out = await root.Zip.build(entries, (function () {
      var r = {};
      r[SHEET] = enc.encode(xml);
      r[WORKBOOK] = enc.encode(wb);
      return r;
    })(), [CALC_CHAIN]);

    return out;
  }

  /** 入力値の問題点を配列で返す(空なら問題なし)。テンプレ行9の注意書きに対応。 */
  function validateMember(m) {
    var problems = [];
    var id = String(m.学籍番号 || '');
    var kana = String(m.カナ氏名 || '');
    if (!/^[0-9A-Za-z]{8}$/.test(id)) {
      problems.push('学籍番号「' + id + '」は半角英数字8桁ではありません(ハイフン以降は入れません。例 1A123456)');
    }
    if (!/^[ァ-ヶー]+　[ァ-ヶー]+$/.test(kana)) {
      problems.push('カナ氏名「' + kana + '」は「全角カナ + 全角スペース + 全角カナ」になっていません(例 ワセダ　タロウ)');
    }
    return problems;
  }

  root.Roster = {
    generate: generate,
    validateMember: validateMember,
    toSerial: toSerial,
    todayIso: todayIso,
    MAX_MEMBERS: MAX_MEMBERS
  };
})(window.GSH = window.GSH || {});
