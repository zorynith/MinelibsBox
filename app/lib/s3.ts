import type { IoGetOptions } from "./io";

export interface S3Config {
  scheme: "https" | "http";
  endpoint: string; // 纯 host (无协议)
  region: string;
  bucket: string;
  accessKey: string;
  secret: string;
}

const enc = new TextEncoder();
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 统一转成独立 ArrayBuffer 的 Uint8Array (规避 ArrayBufferLike 泛型问题) */
function toBytes(data: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (typeof data === "string") return enc.encode(data);
  if (data instanceof Uint8Array) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy;
  }
  return new Uint8Array(data);
}

async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = toBytes(data);
  return toHex(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const raw = key instanceof Uint8Array ? key : new Uint8Array(key);
  const k = await crypto.subtle.importKey("raw", raw as unknown as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data) as unknown as BufferSource);
}

/** AWS URI 编码: encodeURIComponent + 小写 hex + 转义 !'()* */
function uriEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
}

/** 对 URI 路径编码: 每段独立编码, 保留首尾 '/' 分隔符 */
function uriPath(p: string): string {
  if (!p) return "/";
  const hasLeading = p.startsWith("/");
  const hasTrailing = p.endsWith("/");
  const segs = p.split("/").filter((s) => s !== "");
  const body = segs.map((s) => uriEncode(s)).join("/");
  return (hasLeading ? "/" : "") + body + (hasTrailing ? "/" : "");
}

function parseEndpoint(endpoint: string): { scheme: "https" | "http"; host: string } {
  const e = String(endpoint || "s3.amazonaws.com").trim().replace(/\/+$/, "");
  const m = e.match(/^(https?):\/\/(.+)$/);
  if (m) return { scheme: m[1] === "http" ? "http" : "https", host: m[2].replace(/\/+$/, "") };
  return { scheme: "https", host: e };
}

export function buildS3Config(cfg: Record<string, unknown>): S3Config | null {
  // 前端存储表单把 endpoint 存为 config.domain (见 admin/storage 驱动模板),
  // 兼容旧配置里的 endpoint 字段名。
  const endpoint = String(cfg.domain || cfg.endpoint || "").trim();
  if (!endpoint || !cfg.bucket || !cfg.accessKey || !cfg.secret) return null;
  const { scheme, host } = parseEndpoint(endpoint);
  // Cloudflare R2: SigV4 签名 region 必须是 "auto", 否则返回 SignatureDoesNotMatch 403
  const isR2 = /\.r2\.cloudflarestorage\.com$/i.test(host);
  const region = isR2 ? "auto" : String(cfg.region || "us-east-1");
  return {
    scheme,
    endpoint: host,
    region,
    bucket: String(cfg.bucket),
    accessKey: String(cfg.accessKey),
    secret: String(cfg.secret),
  };
}

interface SignOptions {
  method: string;
  canonicalUri: string; // 已编码, 含 /bucket 前缀
  query?: Record<string, string>;
  payloadHash: string;
  contentType?: string;
  extraHeaders?: Record<string, string>;
  body?: ArrayBuffer | Uint8Array;
}

async function signedFetch(s3: S3Config, opts: SignOptions): Promise<Response> {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = s3.region || "us-east-1";
  const service = "s3";
  const host = s3.endpoint;

  const queryKeys = Object.keys(opts.query || {}).sort();
  const canonicalQuery = queryKeys
    .map((k) => uriEncode(k) + "=" + uriEncode((opts.query || {})[k]))
    .join("&");

  const payloadHash = opts.payloadHash;
  const canonicalHeaders = "host:" + host + "\n" + "x-amz-content-sha256:" + payloadHash + "\n" + "x-amz-date:" + amzDate + "\n";
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest =
    opts.method + "\n" + opts.canonicalUri + "\n" + canonicalQuery + "\n" + canonicalHeaders + "\n" + signedHeaders + "\n" + payloadHash;
  const scope = dateStamp + "/" + region + "/" + service + "/aws4_request";
  const stringToSign = "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + (await sha256Hex(canonicalRequest));

  const kDate = await hmac(enc.encode("AWS4" + s3.secret), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  const headers = new Headers({
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    Authorization:
      "AWS4-HMAC-SHA256 Credential=" + s3.accessKey + "/" + scope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature,
  });
  if (opts.contentType) headers.set("Content-Type", opts.contentType);
  for (const [k, v] of Object.entries(opts.extraHeaders || {})) headers.set(k, v);

  const url = s3.scheme + "://" + host + opts.canonicalUri + (canonicalQuery ? "?" + canonicalQuery : "");
  const init: RequestInit = { method: opts.method, headers };
  if (opts.body && opts.body.byteLength > 0) init.body = opts.body as unknown as BodyInit;
  return fetch(url, init);
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** ListObjectsV2, delimiter=/ 目录语义, 分页拉取 */
export async function s3List(s3: S3Config, prefix: string): Promise<{ folders: string[]; files: { key: string; size: number }[] }> {
  const folders: string[] = [];
  const files: { key: string; size: number }[] = [];
  let token = "";
  for (let round = 0; round < 100; round++) {
    const q: Record<string, string> = { "list-type": "2", delimiter: "/", prefix: prefix.replace(/^\//, "") };
    if (token) q["continuation-token"] = token;
    const resp = await signedFetch(s3, { method: "GET", canonicalUri: uriPath("/" + s3.bucket), query: q, payloadHash: EMPTY_SHA256 });
    if (!resp.ok) throw new Error("S3 list failed: " + resp.status + " " + (await resp.text()));
    const xml = await resp.text();
    const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => xmlUnescape(m[1]));
    const sizes = [...xml.matchAll(/<Size>(\d+)<\/Size>/g)].map((m) => Number(m[1]));
    for (let i = 0; i < keys.length; i++) files.push({ key: keys[i], size: sizes[i] || 0 });
    for (const m of xml.matchAll(/<Prefix>([\s\S]*?)<\/Prefix>/g)) {
      const p = xmlUnescape(m[1]);
      if (p && p !== prefix.replace(/^\//, "")) folders.push(p);
    }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
    const nt = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
    if (!nt) break;
    token = xmlUnescape(nt[1]);
  }
  return { folders: [...new Set(folders)].sort(), files };
}

/** 无 delimiter 全量列出 (目录删除/统计用), 含子层级 */
export async function s3ListAll(s3: S3Config, prefix: string): Promise<{ key: string; size: number }[]> {
  const out: { key: string; size: number }[] = [];
  let token = "";
  for (let round = 0; round < 100; round++) {
    const q: Record<string, string> = { "list-type": "2", prefix: prefix.replace(/^\//, "") };
    if (token) q["continuation-token"] = token;
    const resp = await signedFetch(s3, { method: "GET", canonicalUri: uriPath("/" + s3.bucket), query: q, payloadHash: EMPTY_SHA256 });
    if (!resp.ok) throw new Error("S3 list failed: " + resp.status + " " + (await resp.text()));
    const xml = await resp.text();
    const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => xmlUnescape(m[1]));
    const sizes = [...xml.matchAll(/<Size>(\d+)<\/Size>/g)].map((m) => Number(m[1]));
    for (let i = 0; i < keys.length; i++) out.push({ key: keys[i], size: sizes[i] || 0 });
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
    const nt = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
    if (!nt) break;
    token = xmlUnescape(nt[1]);
  }
  return out;
}

/** 取对象元信息, 不存在返回 null */
export async function s3Head(s3: S3Config, key: string): Promise<{ size: number; contentType: string; lastModified: string } | null> {
  const resp = await signedFetch(s3, { method: "HEAD", canonicalUri: uriPath("/" + s3.bucket + "/" + key), payloadHash: EMPTY_SHA256 });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error("S3 head failed: " + resp.status);
  return {
    size: Number(resp.headers.get("content-length") || 0),
    contentType: resp.headers.get("content-type") || "",
    lastModified: resp.headers.get("last-modified") || "",
  };
}

/** 下载对象内容 */
export async function s3Get(s3: S3Config, key: string, opts?: IoGetOptions): Promise<{ body: ReadableStream<Uint8Array>; size: number; contentType: string; lastModified: string }> {
  const resp = await signedFetch(s3, {
    method: "GET",
    canonicalUri: uriPath("/" + s3.bucket + "/" + key),
    payloadHash: EMPTY_SHA256,
    extraHeaders: opts?.range ? { Range: `bytes=${opts.range[0]}-${opts.range[1]}` } : undefined,
  });
  if (!resp.ok) throw new Error("S3 get failed: " + resp.status);
  const cr = resp.headers.get("content-range") || "";
  const m = cr.match(/\/(\d+)\s*$/);
  return {
    body: resp.body as ReadableStream<Uint8Array>,
    size: Number(resp.headers.get("content-length") || 0),
    contentType: resp.headers.get("content-type") || "application/octet-stream",
    lastModified: resp.headers.get("last-modified") || "",
    ...(m ? { totalSize: Number(m[1]) } : {}),
  };
}

/** 上传对象, body 可为 ArrayBuffer/Uint8Array/ReadableStream */
export async function s3Put(
  s3: S3Config,
  key: string,
  body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
  contentType?: string,
): Promise<Response> {
  const buf = body instanceof ReadableStream ? await new Response(body).arrayBuffer() : body;
  const bytes = toBytes(buf);
  const payloadHash = await sha256Hex(bytes);
  return signedFetch(s3, {
    method: "PUT",
    canonicalUri: uriPath("/" + s3.bucket + "/" + key),
    payloadHash,
    contentType,
    body: bytes,
  });
}

/** 删除单个对象 */
export async function s3Delete(s3: S3Config, key: string): Promise<void> {
  const resp = await signedFetch(s3, { method: "DELETE", canonicalUri: uriPath("/" + s3.bucket + "/" + key), payloadHash: EMPTY_SHA256 });
  if (!resp.ok && resp.status !== 204 && resp.status !== 404) throw new Error("S3 delete failed: " + resp.status);
}

/** 删除目录: 删占位对象 + prefix 下全部对象 */
export async function s3DeleteDir(s3: S3Config, prefix: string): Promise<void> {
  const all = await s3ListAll(s3, prefix);
  await s3Delete(s3, prefix);
  for (const item of all) await s3Delete(s3, item.key);
}

/** 复制对象 (rename 用), 源/目标同一 bucket */
export async function s3Copy(s3: S3Config, srcKey: string, dstKey: string): Promise<void> {
  const src = await s3Head(s3, srcKey);
  if (!src) return;
  const resp = await signedFetch(s3, {
    method: "PUT",
    canonicalUri: uriPath("/" + s3.bucket + "/" + dstKey),
    payloadHash: EMPTY_SHA256,
    extraHeaders: { "x-amz-copy-source": "/" + s3.bucket + "/" + uriEncode(srcKey) },
  });
  if (!resp.ok) throw new Error("S3 copy failed: " + resp.status);
}

/** R2 bucket 不存在时避免直接抛错 */
export function isS3Configured(cfg: Record<string, unknown>): boolean {
  return !!cfg && !!cfg.endpoint && !!cfg.bucket && !!cfg.accessKey && !!cfg.secret;
}
