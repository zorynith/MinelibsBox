/**
 * 纯 JS MD5 实现 (Cloudflare Worker 的 WebCrypto 不支持 MD5,
 * 又拍云 USS 签名算法要求 MD5, 故自带实现)。
 * 基于 RFC 1321 标准算法, 仅输出 32 位小写十六进制。
 */

let s0 = 0;
let s1 = 0;
let s2 = 0;
let s3 = 0;

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function add(a: number, b: number): number {
  return (a + b) >>> 0;
}

const T: number[] = (() => {
  const t = new Array<number>(64);
  for (let i = 0; i < 64; i++) {
    t[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }
  return t;
})();

function toBytes(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0xd800 || c >= 0xe000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      i++;
      c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return Uint8Array.from(bytes);
}

export function md5Hex(input: string): string {
  const msg = toBytes(input);
  const bitLen = msg.length * 8;
  const msgWithOne = Uint8Array.from([...msg, 0x80]);
  const ml = msgWithOne.length + 8;
  const finalLen = Math.ceil(ml / 64) * 64;
  const buf = new Uint8Array(finalLen);
  buf.set(msgWithOne);
  const dv = new DataView(buf.buffer);
  dv.setUint32(finalLen - 8, bitLen >>> 0, true);
  dv.setUint32(finalLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let off = 0; off < finalLen; off += 64) {
    const M = new Array<number>(16);
    for (let i = 0; i < 16; i++) {
      M[i] = dv.getUint32(off + i * 4, true);
    }
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F = 0;
      let g = 0;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + T[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21][((i >> 4) << 2) + (i % 4)])) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);
  return [...out].map((b) => b.toString(16).padStart(2, "0")).join("");
}
