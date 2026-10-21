/** zip 路径/文件名处理 (explorer-api 与 share-api 共用, 避免双向依赖)。 */

/** 去除 zip 条目中的危险路径段 (.. / . / 反斜杠)。 */
export function safeZipEntryName(name: string): string {
  const n = (name || "").replace(/\\/g, "/");
  const parts = n.split("/").filter((s) => s && s !== "." && s !== "..");
  return parts.join("/");
}

/**
 * JSZip loadAsync 自定义文件名解码 (复刻 001 前端对 GBK zip 的处理语义)。
 * JSZip 默认把未置 UTF-8 flag 的条目按 UTF-8 解码 -> 中文 zip 文件名乱码;
 * 这里优先严格 UTF-8, 失败回退 GBK (Windows 老 zip), 最后 latin1 兜底。
 */
export function zipDecodeFileName(bytes: Uint8Array | ArrayLike<number> | string[]): string {
  let u8: Uint8Array;
  if (bytes instanceof Uint8Array) u8 = bytes;
  else if (Array.isArray(bytes)) u8 = new Uint8Array(bytes.map((b) => (typeof b === "number" ? b : 0)));
  else u8 = new Uint8Array(Array.from(bytes as ArrayLike<number>));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(u8);
  } catch {
    try {
      return new TextDecoder("gbk").decode(u8);
    } catch {
      return new TextDecoder("latin1").decode(u8);
    }
  }
}

/**
 * 解析 zip 预览面板传入的虚拟路径 (完整 unzipList URL 串)。
 * 前端 makeTree 生成: `explorer/index/unzipList?path={source:home}/x.zip&index=[{index,name}...]&name=/inner.txt`
 * 返回 zip 真实路径 + 条目索引数组; 无法解析返回 null。
 */
export function parseZipInnerPath(raw: string): { zipPath: string; indexArray: number[]; name: string } | null {
  const m = raw.match(/[?&]path=([^&]*)/);
  const im = raw.match(/[?&]index=([^&]*)/);
  if (!m || !im) return null;
  let zipPath = "";
  let indexArray: number[] = [];
  try {
    zipPath = decodeURIComponent(m[1]);
    const arr = JSON.parse(decodeURIComponent(im[1]));
    if (Array.isArray(arr)) indexArray = arr.map((x: any) => Number(x && x.index)).filter((n: number) => Number.isInteger(n));
  } catch {
    return null;
  }
  if (!zipPath || indexArray.length === 0) return null;
  const nm = raw.match(/[?&]name=([^&]*)/);
  let name = "";
  if (nm) {
    try {
      name = decodeURIComponent(nm[1]).replace(/^\/+/, "");
    } catch {
      name = "";
    }
  }
  return { zipPath, indexArray, name };
}
