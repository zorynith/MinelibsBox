/**
 * 外部存储驱动分类 (对齐 kodbox 001 的多云融合存储驱动)。
 *
 * 001 前端存储驱动全集: local/ftp/oss/qiniu/cos/s3/obs/oos/jos/bos/uss/minio/eos/eds。
 * 其中除 qiniu(七牛)、uss(又拍云) 走专有 API 外, 其余对象存储驱动统一走 S3 兼容协议
 * (SigV4, 见 s3.ts); ftp 依赖出站 TCP, Cloudflare Worker 无法建立, 属平台限制。
 */
export type IoDriverKind = "local" | "s3" | "qiniu" | "uss" | "ftp" | "unknown";

/** S3 兼容协议驱动 (含各家云厂商: OSS/COS/OBS/OOS/BOS/JOS/MOSS/NOS/EOS/EDS + 通用 S3/MinIO) */
export const S3_COMPAT_DRIVERS = [
  "s3",
  "minio",
  "oss",
  "cos",
  "obs",
  "oos",
  "jos",
  "bos",
  "eos",
  "eds",
  "moss",
  "nos",
];

/** 由驱动名推断存储类别 */
export function ioDriverKind(driver: string): IoDriverKind {
  const d = String(driver || "").toLowerCase();
  if (!d || d === "local") return "local";
  if (S3_COMPAT_DRIVERS.includes(d)) return "s3";
  if (d === "qiniu" || d === "kodo") return "qiniu";
  if (d === "uss") return "uss";
  if (d === "ftp" || d === "sftp") return "ftp";
  return "unknown";
}

/** ftp 驱动在当前 Worker 部署环境下不可用 (无出站 TCP 能力) */
export const FTP_UNSUPPORTED_MSG = "FTP/SFTP 驱动需要出站 TCP 连接, 当前云端部署环境不支持, 请改用对象存储(S3/OSS/COS/七牛/又拍云)驱动";

import type { SourceRef } from "./source";
import { buildS3Config, s3List, s3ListAll, s3Head, s3Get, s3Put, s3Delete, s3DeleteDir, s3Copy } from "./s3";
import type { S3Config } from "./s3";
import { QiniuClient } from "./qiniu";
import type { QiniuConfig } from "./qiniu";
import { UssClient } from "./uss";
import type { UssConfig } from "./uss";

/** S3 兼容驱动包装成统一 IoClient */
export function s3Client(cfg: S3Config): IoClient {
  const enc = new TextEncoder();
  return {
    list: (prefix) => s3List(cfg, prefix),
    listAll: (prefix) => s3ListAll(cfg, prefix),
    head: (key) => s3Head(cfg, key),
    get: (key, opts) => s3Get(cfg, key, opts),
    put: async (key, body, contentType) => {
      const bytes: ArrayBuffer | Uint8Array = typeof body === "string" ? enc.encode(body) : body;
      const resp = await s3Put(cfg, key, bytes, contentType);
      return { ok: resp.ok, status: resp.status };
    },
    delete: (key) => s3Delete(cfg, key),
    deleteDir: (prefix) => s3DeleteDir(cfg, prefix),
    copy: (src, dst) => s3Copy(cfg, src, dst),
  };
}

/**
 * 由驱动名 + 连接配置构造外部存储客户端。
 * 供 admin 存储统计等不持有完整 SourceRef 的场景使用。
 */
export function ioClientFromConfig(driver: string, config: Record<string, unknown>): IoClient | null {
  const kind = ioDriverKind(driver);
  if (kind === "s3") {
    const s3c = buildS3Config(config);
    return s3c ? s3Client(s3c) : null;
  }
  if (kind === "qiniu") {
    const q: QiniuConfig = {
      accessKey: String(config.accessKey || ""),
      secret: String(config.secret || ""),
      bucket: String(config.bucket || ""),
      domain: String(config.domain || ""),
      region: String(config.region || ""),
    };
    if (!q.accessKey || !q.secret || !q.bucket) return null;
    return new QiniuClient(q);
  }
  if (kind === "uss") {
    const u: UssConfig = {
      bucket: String(config.bucket || ""),
      username: String(config.username || ""),
      userpass: String(config.userpass || ""),
      domain: String(config.domain || ""),
      token: String(config.token || ""),
    };
    if (!u.bucket || !u.username || !u.userpass) return null;
    return new UssClient(u);
  }
  return null;
}

/**
 * 解析 {io:N} 挂载对应的外部存储客户端。
 * 系统内置存储(R2 本地, system=1) / 个人空间 / 部门空间返回 null (走 R2);
 * ftp 与未知驱动返回 null (resolveIoSource 已对 ftp 拦截)。
 */
export function ioClientOf(source: SourceRef): IoClient | null {
  if (source.type !== "io") return null;
  if (parseInt(String(source.system ?? "0"), 10) === 1) return null;
  return ioClientFromConfig(String(source.driver || ""), source.ioConfig || {});
}

/**
 * 统一外部存储客户端接口 (对齐 001 KodIO 抽象)。
 * explorer-api 对 {io:N} 挂载的读写全部经由该接口分发,
 * S3 兼容驱动包装 s3.ts, 七牛/又拍云走各自专有实现。
 */
export interface IoListResult {
  folders: string[]; // 目录 key (以 / 结尾)
  files: { key: string; size: number }[];
}

export interface IoGetResult {
  body: ReadableStream<Uint8Array>;
  size: number;
  contentType: string;
  lastModified: string;
  /** 对象总字节数 (Range 响应从 Content-Range 解析; 全量下载或未知时为 undefined) */
  totalSize?: number;
}

/** 读取选项: range 为 [start, endInclusive] 字节区间 */
export interface IoGetOptions {
  range?: [start: number, endInclusive: number];
}

export interface IoClient {
  list(prefix: string): Promise<IoListResult>;
  listAll(prefix: string): Promise<{ key: string; size: number }[]>;
  head(key: string): Promise<{ size: number; contentType: string; lastModified: string } | null>;
  get(key: string, opts?: IoGetOptions): Promise<IoGetResult>;
  put(key: string, body: string | ArrayBuffer | Uint8Array, contentType?: string): Promise<{ ok: boolean; status: number }>;
  delete(key: string): Promise<void>;
  deleteDir(prefix: string): Promise<void>;
  copy(srcKey: string, dstKey: string): Promise<void>;
}
