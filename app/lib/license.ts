/**
 * 开发版授权状态常量
 * 将系统整体呈现为「授权开发版」：versionType=B（非 A 免费版、非 T），
 * 用户数不限、所有授权功能解锁，且彻底去除任何授权/服务到期日期机制。
 */

export function devLicenseItem(userUse: number) {
  return {
    versionType: "B",
    versionText: "开发版",
    user: "-", // "-" 开头 => 隐藏「授权对象」行
    userAllow: "不限",
    userLimit: 10000, // >= 10000 => 显示「不限」
    userUse: userUse,
    // timeTo/timeToService 均置 0（falsy）：前端模板 a.timeTo && / a.timeToService && 分支跳过，
    // 「授权到期时间」「服务到期时间」两行都不渲染，彻底无到期日期概念。
    timeTo: 0,
    timeToService: 0,
    deviceSN: "DEV-MB-0001",
  };
}

export const DEV_KOD = {
  kodID: "DEV-MB-0001",
  // 与 MbesBox 官方最新版保持一致，避免 main-v5.js 判定为「旧版本」触发更新弹窗
  version: "1.68",
  build: "10",
  channel: "default",
  versionType: "B",
};

/**
 * 开发版授权 hash 生成器
 *
 * 前端 main.dec.js 的 `checkVersion`/`checkBefore` 会校验三个字段：
 *   - `kod.versionType`      —— 必须非 "A"（免费版），否则 `support()` 返回 false
 *   - `kod.versionHash`      —— checkBefore Part1 二次校验
 *   - `kod.versionHashUser`  —— checkBefore Part2 二次校验
 *   - `system.all.hash`      —— checkVersion 主校验
 *
 * 这些值由前端 `encodeString`（3 次迭代 + authCrypt）生成，后端这里按同一
 * 算法（等价实现）生成，保证前端解码后取出的 versionType 与下发值一致。
 */
import { md5 } from "./mcrypt";

// ---------- base64 / RC4（与前端 Base64Hex + authcode 等价） ----------

function bytesToBinaryStr(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function binaryStrToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}

// 标准 base64（带 padding），对应前端 Base64Hex.encode（对 ASCII 内容等价）
function b64Encode(bytes: Uint8Array): string {
  return btoa(bytesToBinaryStr(bytes));
}

// 标准 base64 解码，容忍被去掉 padding 的串（authcode 内部会去掉 "="）
function b64Decode(str: string): Uint8Array {
  const mod = str.length % 4;
  if (mod === 2) str += "==";
  else if (mod === 3) str += "=";
  return binaryStrToBytes(atob(str));
}

// RC4（加密与解密同构）
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

// ---------- authcode / authCrypt（等价前端实现） ----------

function authcode(str: string, operation: "ENCODE" | "DECODE", key: string, expiry = 0): string {
  const keyMd5 = md5(key || "");
  const keya = md5(keyMd5.substring(0, 16));
  const keyb = md5(keyMd5.substring(16));

  let sec: string;
  let strbuf: Uint8Array;
  if (operation === "DECODE") {
    sec = str.substring(0, 4);
    strbuf = b64Decode(str.substring(4));
  } else {
    sec = md5(Date.now() + ":" + Math.random()).slice(-4);
    let tmpstr = (expiry ? expiry + Math.floor(Date.now() / 1000) : 0).toString();
    if (tmpstr.length >= 10) {
      str = tmpstr.substring(0, 10) + md5(str + keyb).substring(0, 16) + str;
    } else {
      while (tmpstr.length < 10) tmpstr = "0" + tmpstr;
      str = tmpstr + md5(str + keyb).substring(0, 16) + str;
    }
    strbuf = binaryStrToBytes(str);
  }

  const cryptkey = keya + md5(keya + sec);

  if (operation === "DECODE") {
    const s = bytesToBinaryStr(rc4Crypt(strbuf, cryptkey));
    const theTime = parseInt(s.substring(0, 10), 10);
    const now = Math.floor(Date.now() / 1000);
    const timeValid = theTime === 0 || theTime - now > 0;
    const checkValid = s.substring(10, 26) === md5(s.substring(26) + keyb).substring(0, 16);
    return timeValid && checkValid ? s.substring(26) : "";
  } else {
    const enc = rc4Crypt(strbuf, cryptkey);
    return sec + b64Encode(enc).replace(/=/g, "");
  }
}

function authCryptEncode(str: string, key: string): string {
  str = encodeURIComponent(str);
  str = authcode(str, "ENCODE", key, 0);
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ".");
}

function strReverse(s: string): string {
  return s.split("").reverse().join("");
}

// encodeString：固定 case "3"（key = md5(o + kodID)），迭代 3 次
function encodeString(plaintext: string, kodID: string): string {
  let result = plaintext;
  for (let i = 0; i < 3; i++) {
    const n = "3";
    const o = randomString(15);
    const key = md5(o + kodID);
    const r = authCryptEncode(result, key);
    result = strReverse(n + o + r);
  }
  return result;
}

function randomString(len: number): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export interface DevLicenseHashes {
  versionHash: string;
  versionHashUser: string;
  systemHash: string;
}

/**
 * 生成开发版授权三件套，供 options 端点下发。
 * 明文结构严格对齐前端解码逻辑：
 *   - system.all.hash   : 前10 + versionType + 后5   (substr(10, len-15) === versionType)
 *   - versionHash        : 前10 + versionType + 后16  (checkBefore Part1)
 *   - versionHashUser    : 前16(key) + versionType + authCrypt.encode(data, key) (checkBefore Part2)
 */
export function devLicenseHashes(kodID = DEV_KOD.kodID, versionType = DEV_KOD.versionType): DevLicenseHashes {
  // system.all.hash
  const sysPlain = "0123456789" + versionType + "01234";
  const systemHash = encodeString(sysPlain, kodID);

  // versionHash（key 与前端 checkBefore 一致）
  const VH_KEY = "@dfq[-)&*^*%(_90";
  const vhPlain = "0123456789" + versionType + "abcdefghijklmnop";
  const vhBody = authCryptEncode(vhPlain, VH_KEY);
  const versionHash = strReverse(b64Encode(binaryStrToBytes(vhBody)));

  // versionHashUser（key 与前端 checkBefore 一致）
  const VHU_KEY = "f342^&*(KJFSD9fdjv";
  const key2 = "0123456789abcdef";
  const vhuData = authCryptEncode("x", key2);
  const vhuPlain = key2 + versionType + vhuData;
  const vhuBody = authCryptEncode(vhuPlain, VHU_KEY);
  const versionHashUser = b64Encode(binaryStrToBytes(strReverse(vhuBody)));

  return { versionHash, versionHashUser, systemHash };
}
