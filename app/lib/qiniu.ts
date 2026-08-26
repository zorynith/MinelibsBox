/**
 * 七牛云 Kodo 对象存储驱动 (对齐 001 PathDriverQiniu)。
 *
 * 管理操作走七牛 RS 管理 API (rs.qiniu.com, QBox HMAC-SHA1 签名);
 * 上传走上传凭证 UpToken + 表单直传 (upload.qiniup.com);
 * 下载走用户配置的加速域名 (config.domain) 或源站域名。
 * 配置字段(前端驱动模板): accessKey/secret/bucket/domain(下载域名)/region(z0等)/signVer
 */
import type { IoClient, IoGetOptions, IoGetResult, IoListResult } from "./io";

const enc = new TextEncoder();

/** https 拉取失败的下载域名缓存: 域名无有效 https 时后续直接走 http, 避免每次 fetch 白白重试 TLS */
const httpsFailedDomains = new Set<string>();

/** 从 GET/HEAD 响应构造 IoGetResult (Range 响应解析 Content-Range 总大小) */
function buildGetResult(res: Response): IoGetResult {
  const cr = res.headers.get("content-range") || "";
  const m = cr.match(/\/(\d+)\s*$/);
  return {
    body: res.body!,
    size: Number(res.headers.get("content-length") || "0"),
    contentType: res.headers.get("content-type") || "",
    lastModified: res.headers.get("last-modified") || "",
    ...(m ? { totalSize: Number(m[1]) } : {}),
  };
}

export interface QiniuConfig {
  accessKey: string;
  secret: string;
  bucket: string;
  /** 下载/访问域名 (如 xxx.bkt.clouddn.com 或自定义 CDN 域名, 可带 http(s):// 前缀) */
  domain?: string;
  /** 区域: z0/z1/z2/na0/as0 (001 前端 region select 取值) */
  region?: string;
}

/** region(001 取值) → 七牛区域名 */
const REGION_NAMES: Record<string, string> = {
  "": "cn-east-1",
  z0: "cn-east-1",
  "cn-east-1": "cn-east-1",
  z1: "cn-north-1",
  "cn-north-1": "cn-north-1",
  z2: "cn-south-1",
  "cn-south-1": "cn-south-1",
  na0: "us-north-1",
  "us-north-1": "us-north-1",
  as0: "ap-southeast-1",
  "ap-southeast-1": "ap-southeast-1",
};

/** region → 上传服务器 host */
const UPLOAD_HOSTS: Record<string, string> = {
  "": "upload.qiniup.com",
  z0: "upload.qiniup.com",
  z1: "upload-z1.qiniup.com",
  z2: "upload-z2.qiniup.com",
  na0: "upload-na0.qiniup.com",
  as0: "upload-as0.qiniup.com",
};

/** region → RS 管理 API host (官方区域域名 qbox.me 后缀, bucket 区域不符会 401/631) */
const RS_HOSTS: Record<string, string> = {
  "": "rs.qbox.me",
  z0: "rs.qbox.me",
  z1: "rs-z1.qbox.me",
  z2: "rs-z2.qbox.me",
  na0: "rs-na0.qbox.me",
  as0: "rs-as0.qbox.me",
};

/** region → RSF 列举 API host (列举走 RSF 服务, 与 RS 管理端点不同) */
const RSF_HOSTS: Record<string, string> = {
  "": "rsf.qbox.me",
  z0: "rsf.qbox.me",
  z1: "rsf-z1.qbox.me",
  z2: "rsf-z2.qbox.me",
  na0: "rsf-na0.qbox.me",
  as0: "rsf-as0.qbox.me",
};

/** bytes → base64 URL-safe (七牛保留 `=` padding, 与官方 urlsafe_base64_encode 一致) */
function base64UrlSafe(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_");
}

/** HMAC-SHA1 后做 base64 URL-safe (七牛 QBox/上传凭证签名) */
async function qboxSign(secret: string, str: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(str));
  return base64UrlSafe(new Uint8Array(sig));
}

/** key 逐段 url 编码但保留 `/` */
function urlKey(key: string): string {
  return key
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

export class QiniuClient implements IoClient {
  constructor(private cfg: QiniuConfig) {}

  private get region(): string {
    return REGION_NAMES[String(this.cfg.region || "z0")] || "cn-east-1";
  }

  /** 当前 UTC 时间戳 (X-Qiniu-Date 格式 YYYYMMDDTHHMMSSZ) */
  private dateHeader(): string {
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  }

  /**
   * RS 管理 API 签名请求。
   * 对齐官方 python 新版 QiniuMacRequestsAuth(时间戳签名):
   *   sign = b64url(hmac_sha1(SK, "<METHOD> <path?query>\nHost: <host>\nContent-Type: <ct>\nX-Qiniu-Date: <date>\n\n"))
   * 管理端点按区域分开(qbox.me 后缀, bucket 区域不符会 401/631)。
   */
  private async rs(pathAndQuery: string, method = "GET", body?: BodyInit): Promise<Response> {
    const host = RS_HOSTS[String(this.cfg.region || "z0")] || "rs.qbox.me";
    const date = this.dateHeader();
    const ct = "application/x-www-form-urlencoded";
    let data = `${method} ${pathAndQuery}\nHost: ${host}\nContent-Type: ${ct}\nX-Qiniu-Date: ${date}\n\n`;
    if (body) data += body;
    const sig = await qboxSign(this.cfg.secret, data);
    return fetch(`https://${host}${pathAndQuery}`, {
      method,
      body,
      headers: { Authorization: `Qiniu ${this.cfg.accessKey}:${sig}`, "X-Qiniu-Date": date, "Content-Type": ct },
    });
  }

  private async ensureOk(res: Response, what: string): Promise<void> {
    if (!res.ok) throw new Error(`qiniu ${what} failed: ${res.status} ${await res.text().catch(() => "")}`);
  }

  /** RSF 列举请求 (GET /list, Qiniu 时间戳签名, host 按区域 qbox.me 后缀) */
  private async rsfList(q: URLSearchParams): Promise<any> {
    const host = RSF_HOSTS[String(this.cfg.region || "z0")] || "rsf.qbox.me";
    const pathQuery = "/list?" + q.toString();
    const date = this.dateHeader();
    const ct = "application/x-www-form-urlencoded";
    const data = `GET ${pathQuery}\nHost: ${host}\nContent-Type: ${ct}\nX-Qiniu-Date: ${date}\n\n`;
    const sig = await qboxSign(this.cfg.secret, data);
    const res = await fetch(`https://${host}${pathQuery}`, {
      headers: { Authorization: `Qiniu ${this.cfg.accessKey}:${sig}`, "X-Qiniu-Date": date, "Content-Type": ct },
    });
    if (!res.ok) throw new Error("qiniu list failed: " + res.status);
    return res.json();
  }

  async list(prefix: string): Promise<IoListResult> {
    const q = new URLSearchParams();
    q.set("bucket", this.cfg.bucket);
    if (prefix) q.set("prefix", prefix);
    q.set("limit", "1000");
    q.set("delimiter", "/");
    const data = await this.rsfList(q);
    return {
      folders: (data.commonPrefixes || []).map((p: string) => p),
      files: (data.items || []).map((it: any) => ({ key: it.key as string, size: it.fsize as number })),
    };
  }

  async listAll(prefix: string): Promise<{ key: string; size: number }[]> {
    let marker = "";
    const out: { key: string; size: number }[] = [];
    do {
      const q = new URLSearchParams();
      q.set("bucket", this.cfg.bucket);
      if (prefix) q.set("prefix", prefix);
      q.set("limit", "1000");
      if (marker) q.set("marker", marker);
      const data = await this.rsfList(q);
      for (const it of data.items || []) out.push({ key: it.key as string, size: it.fsize as number });
      marker = data.marker || "";
    } while (marker);
    return out;
  }

  async head(key: string): Promise<{ size: number; contentType: string; lastModified: string } | null> {
    const res = await this.rs(`/stat/${base64UrlSafe(enc.encode(`${this.cfg.bucket}:${key}`))}`);
    if (res.status === 404 || res.status === 612) return null;
    if (!res.ok) throw new Error("qiniu stat failed: " + res.status);
    const d: any = await res.json();
    return {
      size: d.fsize as number,
      contentType: d.mimeType || "",
      lastModified: d.putTime ? new Date(Math.floor((d.putTime as number) / 10000)).toISOString() : "",
    };
  }

  private downloadUrl(key: string): string {
    const domain = String(this.cfg.domain || "").trim().replace(/\/+$/, "");
    if (domain) return /^https?:\/\//.test(domain) ? `${domain}/${urlKey(key)}` : `https://${domain}/${urlKey(key)}`;
    return `https://${this.cfg.bucket}.${this.region}.qiniudns.com/${urlKey(key)}`;
  }

  async get(key: string, opts?: IoGetOptions): Promise<IoGetResult> {
    // 域名无有效 https 时直接走 http 明文直链 (失败域名按 host 缓存)
    const httpsUrl = this.downloadUrl(key);
    const host = new URL(httpsUrl).host;
    const headers: Record<string, string> = {};
    if (opts?.range) headers["Range"] = `bytes=${opts.range[0]}-${opts.range[1]}`;
    let res: Response | null = null;
    if (!httpsFailedDomains.has(host)) {
      res = await fetch(httpsUrl, { headers }).catch(() => null);
      if (res && res.ok) {
        return buildGetResult(res);
      }
      httpsFailedDomains.add(host);
    }
    res = await fetch(httpsUrl.replace(/^https:/, "http:"), { headers });
    if (!res || !res.ok) throw new Error("qiniu get failed: " + (res ? res.status : "fetch"));
    return buildGetResult(res);
  }

  async put(key: string, body: string | ArrayBuffer | Uint8Array, contentType?: string): Promise<{ ok: boolean; status: number }> {
    const putPolicy = base64UrlSafe(enc.encode(JSON.stringify({ scope: `${this.cfg.bucket}:${key}`, deadline: Math.floor(Date.now() / 1000) + 3600 })));
    const sig = await qboxSign(this.cfg.secret, putPolicy);
    const token = `${this.cfg.accessKey}:${sig}:${putPolicy}`;
    const fd = new FormData();
    fd.append("key", key);
    fd.append("token", token);
    fd.append("file", new Blob([body as BlobPart], { type: contentType || "application/octet-stream" }), "file");
    const host = UPLOAD_HOSTS[String(this.cfg.region || "z0")] || "upload.qiniup.com";
    const res = await fetch(`https://${host}/`, { method: "POST", body: fd });
    return { ok: res.ok, status: res.status };
  }

  async delete(key: string): Promise<void> {
    const res = await this.rs(`/delete/${base64UrlSafe(enc.encode(`${this.cfg.bucket}:${key}`))}`, "POST");
    if (res.status === 404 || res.status === 612) return;
    await this.ensureOk(res, "delete");
  }

  async deleteDir(prefix: string): Promise<void> {
    const all = await this.listAll(prefix);
    for (const o of all) {
      const res = await this.rs(`/delete/${base64UrlSafe(enc.encode(`${this.cfg.bucket}:${o.key}`))}`, "POST");
      if (!res.ok && res.status !== 404 && res.status !== 612) throw new Error("qiniu delete failed: " + res.status);
    }
    await this.delete(prefix.replace(/\/+$/, ""));
  }

  async copy(srcKey: string, dstKey: string): Promise<void> {
    const s = `${this.cfg.bucket}:${srcKey}`;
    const d = `${this.cfg.bucket}:${dstKey}`;
    const res = await this.rs(`/copy/${base64UrlSafe(enc.encode(s))}/${base64UrlSafe(enc.encode(d))}`, "POST");
    await this.ensureOk(res, "copy");
  }
}
