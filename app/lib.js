/* lib.js — 画像まわりの下請け。EXIF / サムネ / ハッシュ / zip。
   外部ライブラリなし。移行先を選ばないよう、ブラウザ標準だけで書く。 */
(function (g) {
  'use strict';

  /* ---------- EXIF（JPEG の APP1 だけ読む） ----------
     欲しいのは2つだけ: 撮影日時(DateTimeOriginal) と 回転(Orientation)。 */
  function readExif(buf) {
    var out = { date: null, orientation: 1 };
    try {
      var v = new DataView(buf);
      if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return out; // JPEG でない
      var p = 2;
      while (p + 4 <= v.byteLength) {
        if (v.getUint8(p) !== 0xFF) break;
        var marker = v.getUint8(p + 1);
        if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { p += 2; continue; }
        if (marker === 0xDA) break;                       // 画像本体に入った
        var size = v.getUint16(p + 2);
        if (size < 2) break;
        if (marker === 0xE1 && p + 10 <= v.byteLength &&
            v.getUint32(p + 4) === 0x45786966 && v.getUint16(p + 8) === 0x0000) {
          parseTiff(v, p + 10, out);
          return out;
        }
        p += 2 + size;
      }
    } catch (e) { /* 壊れた EXIF は無いものとして扱う */ }
    return out;
  }

  function parseTiff(v, base, out) {
    var le = v.getUint16(base) === 0x4949;                // II = little endian
    var u16 = function (o) { return v.getUint16(o, le); };
    var u32 = function (o) { return v.getUint32(o, le); };
    if (u16(base + 2) !== 0x002A) return;
    var ifd0 = base + u32(base + 4);
    var exifPtr = walkIfd(v, base, ifd0, le, out);
    if (exifPtr) walkIfd(v, base, base + exifPtr, le, out);
  }

  function walkIfd(v, base, off, le, out) {
    var exifPtr = 0;
    if (off + 2 > v.byteLength) return 0;
    var n = v.getUint16(off, le);
    for (var i = 0; i < n; i++) {
      var e = off + 2 + i * 12;
      if (e + 12 > v.byteLength) break;
      var tag = v.getUint16(e, le), type = v.getUint16(e + 2, le), cnt = v.getUint32(e + 4, le);
      if (tag === 0x0112 && type === 3) out.orientation = v.getUint16(e + 8, le) || 1;
      else if (tag === 0x8769 && type === 4) exifPtr = v.getUint32(e + 8, le);
      else if ((tag === 0x9003 || tag === 0x9004 || tag === 0x0132) && type === 2 && cnt >= 19) {
        var p = base + v.getUint32(e + 8, le), s = '';
        for (var k = 0; k < 19 && p + k < v.byteLength; k++) s += String.fromCharCode(v.getUint8(p + k));
        var m = s.match(/^(\d{4}):(\d{2}):(\d{2})/);
        // DateTimeOriginal(0x9003) を最優先。無ければ DateTimeDigitized → DateTime。
        if (m && (tag === 0x9003 || !out.date)) out.date = m[1] + '-' + m[2] + '-' + m[3];
      }
    }
    return exifPtr;
  }

  /* ---------- サムネイル ----------
     グリッドに原寸を並べるとスクロールが死ぬので、必ず縮小したものを別に持つ。
     imageOrientation:'from-image' で EXIF の回転をここで焼き込む（横倒しバグ対策）。 */
  var THUMB_MAX = 480;

  function makeThumb(blob) {
    return decode(blob).then(function (img) {
      var w = img.width, h = img.height;
      var s = Math.min(1, THUMB_MAX / Math.max(w, h));
      var tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
      var c = document.createElement('canvas');
      c.width = tw; c.height = th;
      c.getContext('2d').drawImage(img, 0, 0, tw, th);
      if (img.close) img.close();
      return new Promise(function (res) {
        c.toBlob(function (b) { res({ thumb: b, w: w, h: h }); }, 'image/jpeg', 0.82);
      });
    }).catch(function () {
      return { thumb: null, w: 0, h: 0 };   // HEIC など、この環境で開けない形式
    });
  }

  function decode(blob) {
    if (g.createImageBitmap) {
      return createImageBitmap(blob, { imageOrientation: 'from-image' })
        .catch(function () { return createImageBitmap(blob); })
        .catch(function () { return decodeViaImg(blob); });
    }
    return decodeViaImg(blob);
  }

  function decodeViaImg(blob) {
    return new Promise(function (res, rej) {
      var u = URL.createObjectURL(blob), im = new Image();
      im.onload = function () { URL.revokeObjectURL(u); res(im); };
      im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('decode')); };
      im.src = u;
    });
  }

  /* ---------- ハッシュ（重複の目印） ----------
     crypto.subtle は安全なコンテキスト(https / localhost)でしか使えない。
     file:// で開いたときのために、弱いが安定した代替を持たせる。 */
  function hashBuf(buf) {
    if (g.crypto && g.crypto.subtle && g.crypto.subtle.digest) {
      return crypto.subtle.digest('SHA-256', buf).then(function (d) {
        var a = new Uint8Array(d), s = '';
        for (var i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0');
        return s;
      }).catch(function () { return fnv(buf); });
    }
    return Promise.resolve(fnv(buf));
  }

  function fnv(buf) {
    var a = new Uint8Array(buf), h = 0x811c9dc5;
    var step = Math.max(1, Math.floor(a.length / 65536));
    for (var i = 0; i < a.length; i += step) {
      h ^= a[i]; h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return 'fnv-' + a.length.toString(16) + '-' + h.toString(16);
  }

  /* ---------- zip（無圧縮 store。書き出しと読み込み） ----------
     持ち出せない試作は、消える場所では作った意味がない。 */
  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function zipWrite(entries) {
    // entries: [{name, data:Uint8Array}] — 名前は UTF-8、フラグ bit11 を立てる
    var enc = new TextEncoder(), parts = [], central = [], offset = 0;
    entries.forEach(function (e) {
      var nm = enc.encode(e.name), c = crc32(e.data), sz = e.data.length;
      var lh = new Uint8Array(30 + nm.length), lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true); lv.setUint16(10, 0, true); lv.setUint16(12, 0, true);
      lv.setUint32(14, c, true); lv.setUint32(18, sz, true); lv.setUint32(22, sz, true);
      lv.setUint16(26, nm.length, true); lv.setUint16(28, 0, true);
      lh.set(nm, 30);
      parts.push(lh, e.data);

      var ch = new Uint8Array(46 + nm.length), cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
      cv.setUint32(16, c, true); cv.setUint32(20, sz, true); cv.setUint32(24, sz, true);
      cv.setUint16(28, nm.length, true); cv.setUint32(42, offset, true);
      ch.set(nm, 46);
      central.push(ch);
      offset += lh.length + sz;
    });
    var cs = central.reduce(function (a, b) { return a + b.length; }, 0);
    var end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cs, true); ev.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [end]), { type: 'application/zip' });
  }

  function zipRead(buf) {
    var v = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder();
    var eocd = -1;
    for (var i = u8.length - 22; i >= 0 && i > u8.length - 66000; i--) {
      if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('zip ではありません');
    var n = v.getUint16(eocd + 10, true), p = v.getUint32(eocd + 16, true), out = [];
    for (var k = 0; k < n; k++) {
      if (v.getUint32(p, true) !== 0x02014b50) throw new Error('zip が壊れています');
      var method = v.getUint16(p + 10, true);
      var sz = v.getUint32(p + 24, true);
      var nl = v.getUint16(p + 28, true), el = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true);
      var lo = v.getUint32(p + 42, true);
      var name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
      if (method !== 0) throw new Error('無圧縮の zip だけ読めます: ' + name);
      var lnl = v.getUint16(lo + 26, true), lel = v.getUint16(lo + 28, true);
      var ds = lo + 30 + lnl + lel;
      out.push({ name: name, data: u8.subarray(ds, ds + sz) });
      p += 46 + nl + el + cl;
    }
    return out;
  }

  g.LIB = {
    readExif: readExif, makeThumb: makeThumb, decode: decode,
    hashBuf: hashBuf, zipWrite: zipWrite, zipRead: zipRead
  };
})(window);
