/* zip.js — xlsx(=zip)を「変更しないエントリは圧縮済みバイト列のまま」で組み直すための最小実装。
 *
 * なぜライブラリを使わないか:
 *   名簿テンプレには大学側の SharePoint / Power Automate が参照するメタデータ
 *   (customXml/*, docProps/custom.xml の ContentTypeId)と、Excel テーブル定義・
 *   数式・データ検証が入っている。汎用の xlsx ライブラリは読み書きの過程でこれらを
 *   落とすことがあるため、「触るファイル以外は 1 バイトも変えない」を保証できる
 *   zip レベルの操作に寄せている。
 *
 * 圧縮/展開はブラウザ標準の CompressionStream / DecompressionStream を使うので依存ゼロ。
 */
(function (root) {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function pipe(bytes, stream) {
    var blob = new Blob([bytes]);
    var res = new Response(blob.stream().pipeThrough(stream));
    return new Uint8Array(await res.arrayBuffer());
  }

  function inflateRaw(bytes) { return pipe(bytes, new DecompressionStream('deflate-raw')); }
  function deflateRaw(bytes) { return pipe(bytes, new CompressionStream('deflate-raw')); }

  /** zip の中央ディレクトリを読んで、エントリ一覧を返す。 */
  function parse(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var eocd = -1;
    for (var i = bytes.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('zip の終端レコード(EOCD)が見つかりません。ファイルが壊れている可能性があります。');

    var count = dv.getUint16(eocd + 10, true);
    var p = dv.getUint32(eocd + 16, true);
    var dec = new TextDecoder('utf-8');
    var entries = [];

    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('中央ディレクトリの署名が不正です。');
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var cmtLen = dv.getUint16(p + 32, true);
      var lho = dv.getUint32(p + 42, true);

      // ローカルヘッダ側の可変長は中央ディレクトリ側と一致しないことがあるので、実物を読む
      var lNameLen = dv.getUint16(lho + 26, true);
      var lExtraLen = dv.getUint16(lho + 28, true);
      var dataStart = lho + 30 + lNameLen + lExtraLen;
      var csize = dv.getUint32(p + 20, true);

      entries.push({
        name: dec.decode(bytes.subarray(p + 46, p + 46 + nameLen)),
        flags: dv.getUint16(p + 8, true),
        method: dv.getUint16(p + 10, true),
        dosTime: dv.getUint16(p + 12, true),
        dosDate: dv.getUint16(p + 14, true),
        crc: dv.getUint32(p + 16, true),
        csize: csize,
        usize: dv.getUint32(p + 24, true),
        raw: bytes.subarray(dataStart, dataStart + csize)   // 圧縮されたままのバイト列
      });
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return entries;
  }

  /** エントリの中身を展開して Uint8Array で返す。 */
  function read(entry) {
    if (entry.method === 0) return Promise.resolve(entry.raw);
    if (entry.method === 8) return inflateRaw(entry.raw);
    return Promise.reject(new Error('未対応の圧縮方式です: ' + entry.method + ' (' + entry.name + ')'));
  }

  function readText(entry) {
    return read(entry).then(function (b) { return new TextDecoder('utf-8').decode(b); });
  }

  /**
   * zip を組み直す。
   * @param entries parse() の戻り値
   * @param replace {[name]: Uint8Array}  差し替える中身(非圧縮)
   * @param drop    string[]              取り除くエントリ名
   */
  async function build(entries, replace, drop) {
    replace = replace || {};
    drop = new Set(drop || []);
    var enc = new TextEncoder();
    var chunks = [];      // ローカルヘッダ + データ
    var central = [];
    var offset = 0;

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (drop.has(e.name)) continue;

      var nameBytes = enc.encode(e.name);
      var method, data, crc, usize;

      if (Object.prototype.hasOwnProperty.call(replace, e.name)) {
        var plain = replace[e.name];
        data = await deflateRaw(plain);
        method = 8;
        crc = crc32(plain);
        usize = plain.length;
      } else {
        // 手を付けないエントリは圧縮済みのバイト列をそのままコピーする
        method = e.method;
        data = e.raw;
        crc = e.crc;
        usize = e.usize;
      }

      // データ記述子(bit 3)は使わないのでフラグから落とす
      var flags = e.flags & ~0x08;

      var lh = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, flags, true);
      lv.setUint16(8, method, true);
      lv.setUint16(10, e.dosTime, true);
      lv.setUint16(12, e.dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, usize, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);

      var ch = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, flags, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, e.dosTime, true);
      cv.setUint16(14, e.dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, usize, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);

      chunks.push(lh, data);
      central.push(ch);
      offset += lh.length + data.length;
    }

    var cdSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    var total = offset + cdSize + 22;
    var out = new Uint8Array(total);
    var pos = 0;
    chunks.concat(central, [end]).forEach(function (c) { out.set(c, pos); pos += c.length; });
    return out;
  }

  root.Zip = { parse: parse, read: read, readText: readText, build: build, crc32: crc32 };
})(window.GSH = window.GSH || {});
