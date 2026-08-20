/**
 * Mcrypt-compatible crypto helpers
 *
 * Re-implements the PHP `Mcrypt` class (authcode-style RC4 stream cipher)
 * used by MbesBox to encrypt passwords on the client. The SPA sends the
 * password as: `random5 + authCrypt.encode(plain, random5 + "2&$%@(*@(djfhj1923")`
 * with `salt=1`. The backend must decode it before verifying.
 *
 * Cloudflare Workers' WebCrypto does NOT support MD5, so a pure-JS MD5
 * implementation is provided here.
 */

// ---------- Pure JS MD5 ----------

const MD5_S: number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K: number[] = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) & 0xffffffff;
}

export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLenLo = (bytes.length * 8) >>> 0;
  const bitLenHi = Math.floor(bytes.length * 8 / 0x100000000) >>> 0;

  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLenLo, true);
  dv.setUint32(padded.length - 4, bitLenHi, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let off = 0; off < padded.length; off += 64) {
    const w: number[] = new Array(16);
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, true);

    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const tmp = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + MD5_K[i] + w[g]) & 0xffffffff, MD5_S[i])) & 0xffffffff;
      a = tmp;
    }
    a0 = (a0 + a) & 0xffffffff;
    b0 = (b0 + b) & 0xffffffff;
    c0 = (c0 + c) & 0xffffffff;
    d0 = (d0 + d) & 0xffffffff;
  }

  const out = new DataView(new ArrayBuffer(16));
  out.setUint32(0, a0, true);
  out.setUint32(4, b0, true);
  out.setUint32(8, c0, true);
  out.setUint32(12, d0, true);
  let hex = "";
  for (let i = 0; i < 16; i++) hex += out.getUint8(i).toString(16).padStart(2, "0");
  return hex;
}

// ---------- Base64 helpers ----------

function base64ToBytes(b64: string): Uint8Array {
  // Restore padding stripped by the client's url-safe base64 encoder
  const mod = b64.length % 4;
  if (mod === 2) b64 += "==";
  else if (mod === 3) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBinaryStr(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// ---------- RC4 (authcode) ----------

function rc4Crypt(data: Uint8Array, cryptkey: string): Uint8Array {
  const keyLength = cryptkey.length;
  const rndkey: number[] = new Array(256);
  for (let i = 0; i < 256; i++) rndkey[i] = cryptkey.charCodeAt(i % keyLength);

  const box: number[] = new Array(256);
  for (let i = 0; i < 256; i++) box[i] = i;
  for (let j = 0, i = 0; i < 256; i++) {
    j = (j + box[i] + rndkey[i]) % 256;
    const tmp = box[i];
    box[i] = box[j];
    box[j] = tmp;
  }

  const out = new Uint8Array(data.length);
  let a = 0, j = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + 1) % 256;
    j = (j + box[a]) % 256;
    const tmp = box[a];
    box[a] = box[j];
    box[j] = tmp;
    out[i] = data[i] ^ box[(box[a] + box[j]) % 256];
  }
  return out;
}

// ---------- Mcrypt decode ----------

/**
 * Decode a string produced by the frontend `authCrypt.encode()`.
 * Equivalent to PHP `Mcrypt::decode($string, $key)`.
 */
export function mcryptDecode(input: string, key: string): string {
  // Restore standard base64 charset (URL-safe variant used by the client)
  input = input.replace(/-/g, "+").replace(/_/g, "/").replace(/\./g, "=");

  const ckeyLength = 4;
  const keyMd5 = md5(key);
  const keya = md5(keyMd5.substring(0, 16));
  const keyb = md5(keyMd5.substring(16));
  const keyc = input.substring(0, ckeyLength);
  const cryptkey = keya + md5(keya + keyc);

  const cipher = base64ToBytes(input.substring(ckeyLength));
  const plain = rc4Crypt(cipher, cryptkey);
  const result = bytesToBinaryStr(plain);

  const theTime = parseInt(result.substring(0, 10), 10);
  const now = Math.floor(Date.now() / 1000);
  const timeValid = theTime === 0 || theTime - now > 0;
  const checkValid =
    result.substring(10, 26) === md5(result.substring(26) + keyb).substring(0, 16);

  if (timeValid && checkValid) {
    try {
      return decodeURIComponent(result.substring(26));
    } catch {
      return result.substring(26);
    }
  }
  return "";
}

/**
 * Decode the password sent by the MbesBox login form.
 * PHP equivalent: `KodUser::parsePass($pass)` when `in.salt == 1`.
 */
export function parseKodPassword(pass: string, salt: string | undefined): string {
  const p = (pass || "").trim();
  if (!p) return p;
  if (salt !== "1") return p;
  const key = p.substring(0, 5) + "2&$%@(*@(djfhj1923";
  const decoded = mcryptDecode(p.substring(5), key);
  return decoded.trim();
}
