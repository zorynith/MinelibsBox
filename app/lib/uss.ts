/**
 * 又拍云 USS 对象存储驱动 (对齐官方 upyun npm SDK 签名)。
 *
 * 管理操作走又拍云 REST API (api.upyun.com, 新版签名 = HMAC-SHA1(操作员密码, method&uri&date));
 * 列表用 x-list-limit/x-list-iter 分页; 上传用 REST PUT; 下载走加速域名或源站。
 * 配置字段(前端驱动模板): bucket/username/userpass(操作员密码)/domain(加速域名)/token
 */
import type { IoClient, IoGetOptions, IoGetResult, IoListResult } from "./io";
import { b64HmacSha1 } from "./hmac-sha1";

export interface UssConfig {
  bucket: string;
  /** 操作员名 */
  username: string;
  /** 操作员密码 */
  userpass: string;
  /** 加速域名(下载, 可带协议前缀) */
  domain?: string;
  /** 表单 API 密钥(预留, REST 方式上传无需) */
  token?: string;
}

/** 逐段 url 编码但保留 `/` (仅用于请求 URL, 签名用原始 uri) */
function urlPath(key: string): string {
  return key
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

/**
 * 又拍云 REST 新版签名(官方 npm SDK):
 *   sign = base64(hmac_sha1(操作员密码, "<METHOD>&<uri>&<date>"))
 *   Authorization: UPYUN <操作员名>:<sign>, 请求带 X-Date 头(值=date)。
 * uri 为未编码的原始路径(形如 /bucket/dir/file.txt)。
 */
async function ussSign(cfg: UssConfig, uri: string, method: string, date: string): Promise<string> {
  return b64HmacSha1(cfg.userpass || "", `${method}&${uri}&${date}`);
}

export class UssClient implements IoClient {
  constructor(private cfg: UssConfig) {}

  /** rawUri 形如 /bucket/path(未编码, 用于签名); 请求 URL 用 urlPath 编码 */
  private async request(
    rawUri: string,
    method: string,
    opts?: { headers?: Record<string, string>; body?: BodyInit }
  ): Promise<Response> {
    const date = new Date().toUTCString();
    const auth = await ussSign(this.cfg, rawUri, method, date);
    return fetch(`https://api.upyun.com${urlPath(rawUri)}`, {
      method,
      body: opts?.body,
      headers: {
        Authorization: `UPYUN ${this.cfg.username}:${auth}`,
        "X-Date": date,
        ...(opts?.headers || {}),
      },
    });
  }

  private async ensureOk(res: Response, what: string): Promise<void> {
    if (!res.ok) throw new Error(`uss ${what} failed: ${res.status} ${await res.text().catch(() => "")}`);
  }

  async list(prefix: string): Promise<IoListResult> {
    const uri = `/${this.cfg.bucket}/${urlPath(prefix)}`;
    let iter = "";
    const folders: string[] = [];
    const files: { key: string; size: number }[] = [];
    do {
      const headers: Record<string, string> = { Accept: "application/json", "x-list-limit": "1000" };
      if (iter) headers["x-list-iter"] = iter;
      const res = await this.request(uri, "GET", { headers });
      await this.ensureOk(res, "list");
      const data: any = await res.json();
      iter = data.iter || "";
      for (const f of data.files || []) {
        const key = (prefix || "") + (f.name as string);
        if (f.type === "folder") folders.push(key.replace(/\/+$/, "") + "/");
        else files.push({ key, size: f.length as number });
      }
      // iter 为 "g2gCZAAEbmV4dGQAA2VvZg" 表示最后一页
      if (iter === "g2gCZAAEbmV4dGQAA2VvZg") break;
    } while (iter);
    return { folders, files };
  }

  async listAll(prefix: string): Promise<{ key: string; size: number }[]> {
    const out: { key: string; size: number }[] = [];
    const append = async (dir: string): Promise<void> => {
      const uri = `/${this.cfg.bucket}/${urlPath(dir)}`;
      let iter = "";
      do {
        const headers: Record<string, string> = { Accept: "application/json", "x-list-limit": "1000" };
        if (iter) headers["x-list-iter"] = iter;
        const res = await this.request(uri, "GET", { headers });
        await this.ensureOk(res, "listAll");
        const data: any = await res.json();
        iter = data.iter || "";
        for (const f of data.files || []) {
          const key = (dir || "") + (f.name as string);
          if (f.type === "folder") await append(key.replace(/\/+$/, "") + "/");
          else out.push({ key, size: f.length as number });
        }
        if (iter === "g2gCZAAEbmV4dGQAA2VvZg") break;
      } while (iter);
    };
    await append(prefix.endsWith("/") ? prefix : prefix + "/");
    return out;
  }

  async head(key: string): Promise<{ size: number; contentType: string; lastModified: string } | null> {
    const uri = `/${this.cfg.bucket}/${urlPath(key)}`;
    const res = await this.request(uri, "HEAD");
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("uss head failed: " + res.status);
    return {
      size: Number(res.headers.get("x-upyun-file-size") || "0"),
      contentType: res.headers.get("content-type") || "",
      lastModified: res.headers.get("x-upyun-last-modified") || "",
    };
  }

  private downloadUrl(key: string): string {
    const domain = String(this.cfg.domain || "").trim().replace(/\/+$/, "");
    if (domain) return /^https?:\/\//.test(domain) ? `${domain}/${urlPath(key)}` : `https://${domain}/${urlPath(key)}`;
    return `http://${this.cfg.bucket}.b0.upaiyun.com/${urlPath(key)}`;
  }

  async get(key: string, opts?: IoGetOptions): Promise<IoGetResult> {
    const res = await fetch(this.downloadUrl(key), {
      headers: opts?.range ? { Range: `bytes=${opts.range[0]}-${opts.range[1]}` } : undefined,
    });
    if (!res.ok) throw new Error("uss get failed: " + res.status);
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

  async put(key: string, body: string | ArrayBuffer | Uint8Array, contentType?: string): Promise<{ ok: boolean; status: number }> {
    const uri = `/${this.cfg.bucket}/${urlPath(key)}`;
    // 目录占位 (key 以 / 结尾): USS 目录是真实对象, 用 POST + folder:true 创建
    if (key.endsWith("/")) {
      const res = await this.request(uri.replace(/\/$/, ""), "POST", { headers: { folder: "true" } });
      return { ok: res.ok, status: res.status };
    }
    const res = await this.request(uri, "PUT", {
      body: body as BodyInit,
      headers: contentType ? { "Content-Type": contentType } : undefined,
    });
    return { ok: res.ok, status: res.status };
  }

  async delete(key: string): Promise<void> {
    const uri = `/${this.cfg.bucket}/${urlPath(key)}`;
    const res = await this.request(uri, "DELETE");
    if (res.status === 404) return;
    await this.ensureOk(res, "delete");
  }

  async deleteDir(prefix: string): Promise<void> {
    const all = await this.listAll(prefix);
    for (const o of all) {
      const uri = `/${this.cfg.bucket}/${urlPath(o.key)}`;
      const res = await this.request(uri, "DELETE");
      if (!res.ok && res.status !== 404) throw new Error("uss delete failed: " + res.status);
    }
    const dirKey = prefix.replace(/\/+$/, "");
    if (dirKey) {
      const uri = `/${this.cfg.bucket}/${urlPath(dirKey)}`;
      await this.request(uri, "DELETE");
    }
  }

  async copy(srcKey: string, dstKey: string): Promise<void> {
    const uri = `/${this.cfg.bucket}/${urlPath(dstKey)}`;
    const res = await this.request(uri, "COPY", { headers: { "X-Upyun-Copy-Source": `/${this.cfg.bucket}/${urlPath(srcKey)}` } });
    await this.ensureOk(res, "copy");
  }
}
