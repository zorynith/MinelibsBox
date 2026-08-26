/**
 * 只读 zip central directory 快速列目录 (zip 预览列表)。
 *
 * 通过 Range 请求只下载文件尾部 (定位 EOCD) 与 central directory 本身,
 * 避免为预览大 zip 而全量下载整个压缩包 (七牛等对象存储慢链路下全量下载
 * 会超出前端 5s 长任务轮询窗口, 导致"操作失败")。
 *
 * 仅解析元数据, 不解压内容; 非标准 zip (加密/分卷/zip64 缺失) 返回 null,
 * 由调用方回退到 JSZip 全量解析。
 */

export interface ZipCentralEntry {
  /** 原始文件名 (可能含 ../ 等, 由调用方 sanitize) */
  name: string;
  dir: boolean;
  /** 解压后大小 (字节), 目录为 0 */
  size: number;
  /** 修改时间 (秒) */
  mtimeSec: number;
}

export interface ZipCentralRangeResult {
  bytes: Uint8Array | null;
  /** 对象总字节数 (首个响应可带出; 未知为 null) */
  totalSize: number | null;
}

export interface ZipCentralOpts {
  /** 可选; 缺省时由首个 readRange 响应中的 totalSize 推断 */
  size?: number;
  /** Range 读取 [start, endInclusive] 区间的字节 */
  readRange: (start: number, endInclusive: number) => Promise<ZipCentralRangeResult>;
}

const EOCD_SIG = [0x50, 0x4b, 0x05, 0x06] as const;
const CD_SIG = [0x50, 0x4b, 0x01, 0x02] as const;
const Z64_LOC_SIG = [0x50, 0x4b, 0x06, 0x07] as const;
const Z64_SIG = [0x50, 0x4b, 0x06, 0x06] as const;
const TAIL_BYTES = 64 * 1024;
const MAX_CD_BYTES = 256 * 1024 * 1024;

function matchSig(buf: Uint8Array, sig: readonly number[], off: number): boolean {
  if (off < 0 || off + sig.length > buf.length) return false;
  for (let i = 0; i < sig.length; i++) if (buf[off + i] !== sig[i]) return false;
  return true;
}

/** DOS 时间戳 -> 秒 (UTC), 无法解析返回 0 */
function dosTimeToSec(dosTime: number): number {
  const year = ((dosTime >> 25) & 0x7f) + 1980;
  const month = (dosTime >> 21) & 0x0f;
  const day = (dosTime >> 16) & 0x1f;
  const hour = (dosTime >> 11) & 0x1f;
  const minute = (dosTime >> 5) & 0x3f;
  const second = (dosTime & 0x1f) * 2;
  if (!year || !month || !day || day > 31) return 0;
  return Math.floor(Date.UTC(year, month - 1, day, hour, minute, second) / 1000);
}

/** 文件名解码: UTF-8 flag 用 UTF-8; 否则 GBK 失败回退 latin1 (对齐 zipDecodeFileName) */
function decodeZipName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder("utf-8").decode(bytes);
  try {
    return new TextDecoder("gbk").decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

/** zip64 EOCD 定位: EOCD 前 20 字节为 zip64 locator, 其 offset 字段指向 zip64 EOCD 记录 */
async function readZip64Eocd(
  opts: ZipCentralOpts,
  tail: Uint8Array,
  eocd: number,
): Promise<{ entries: number; cdSize: number; cdOffset: number } | null> {
  const locOff = eocd - 20;
  if (!matchSig(tail, Z64_LOC_SIG, locOff)) return null;
  const z64Off = Number(new DataView(tail.buffer, tail.byteOffset + locOff + 8, 8).getBigUint64(0, true));
  const z64 = await opts.readRange(z64Off, z64Off + 55);
  if (!z64.bytes || z64.bytes.length < 56 || !matchSig(z64.bytes, Z64_SIG, 0)) return null;
  const dv = new DataView(z64.bytes.buffer, z64.bytes.byteOffset, 56);
  return {
    entries: Number(dv.getBigUint64(32, true)),
    cdSize: Number(dv.getBigUint64(40, true)),
    cdOffset: Number(dv.getBigUint64(48, true)),
  };
}

/**
 * 读取 zip central directory 并解析全部条目。
 * 成功返回条目数组 (按 central directory 顺序); 无法解析返回 null。
 */
export async function readZipCentralDirectory(opts: ZipCentralOpts): Promise<ZipCentralEntry[] | null> {
  let total = opts.size != null && Number.isFinite(opts.size) ? opts.size : null;
  if (total != null && total < 22) return null;
  if (total == null) {
    // 未知总大小: 先读 1 字节取 Content-Range 的总大小 (外部存储, 避免慢速 head API)
    const probe = await opts.readRange(0, 0);
    if (probe.bytes == null || probe.totalSize == null || !Number.isFinite(probe.totalSize)) return null;
    total = probe.totalSize;
    if (total < 22) return null;
  }

  const tailStart = Math.max(0, total - TAIL_BYTES);
  const tailRes = await opts.readRange(tailStart, total - 1);
  if (!tailRes.bytes || tailRes.bytes.length < 22) return null;
  const tail = tailRes.bytes;

  // EOCD 从尾部倒查 (22 字节 + 最长 65535 字节注释)
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (matchSig(tail, EOCD_SIG, i)) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const eocdDv = new DataView(tail.buffer, tail.byteOffset + eocd, 22);
  const diskNo = eocdDv.getUint16(4, true);
  const cdDisk = eocdDv.getUint16(6, true);
  if (diskNo !== 0 || cdDisk !== 0) return null;

  let entries = eocdDv.getUint16(10, true);
  let cdSize = eocdDv.getUint32(12, true);
  let cdOffset = eocdDv.getUint32(16, true);

  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const z64 = await readZip64Eocd(opts, tail, eocd);
    if (!z64) return null;
    entries = z64.entries;
    cdSize = z64.cdSize;
    cdOffset = z64.cdOffset;
  }

  if (cdSize < 0 || cdSize > MAX_CD_BYTES || cdOffset < 0 || cdOffset > total || cdOffset + cdSize > total) return null;

  const cd = await opts.readRange(cdOffset, cdOffset + cdSize - 1);
  if (!cd.bytes || cd.bytes.length < cdSize) return null;
  const cdbuf = cd.bytes;

  const out: ZipCentralEntry[] = [];
  let p = 0;
  for (;;) {
    if (p + 46 > cdbuf.length || !matchSig(cdbuf, CD_SIG, p)) break;
    const dv = new DataView(cdbuf.buffer, cdbuf.byteOffset + p, 46);
    const flags = dv.getUint16(8, true);
    const dosTime = dv.getUint32(12, true);
    const uncompressedSize = dv.getUint32(24, true);
    const nameLen = dv.getUint16(28, true);
    const extraLen = dv.getUint16(30, true);
    const cmtLen = dv.getUint16(32, true);
    if (p + 46 + nameLen > cdbuf.length) break;
    const name = decodeZipName(cdbuf.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
    const dir = name.endsWith("/");
    out.push({ name, dir, size: dir ? 0 : uncompressedSize, mtimeSec: dosTimeToSec(dosTime) });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  if (out.length === 0) return null;
  return out;
}
