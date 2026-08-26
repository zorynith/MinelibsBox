/**
 * User ViewImage API - 壁纸图片接口转发
 * Mirrors 001 user/viewImage.class.php: 从 kodApiServer 拉取 wallpage/api 配置,
 * 再请求目标壁纸站点, 按配置解析(json/正则)出图片列表与分页信息。
 */
import { Hono } from "hono";
import { authRequired } from "../lib/auth";
import { getSetting } from "../lib/db";

type Vars = { currentUser: import("../lib/auth").AuthUser };

const viewImageApi = new Hono<{ Bindings: Env; Variables: Vars }>();

// 模块级内存缓存 (worker 无持久 Cache, 001 用 Cache 600s/3600s)
const cacheMap = new Map<string, { data: unknown; ts: number }>();
function cacheGet(key: string, ttlMs: number): unknown | undefined {
  const hit = cacheMap.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  return undefined;
}
function cacheSet(key: string, data: unknown): void {
  cacheMap.set(key, { data, ts: Date.now() });
}

/** _get(obj, 'a.b.c') 语义 */
function lngGet(value: unknown, key: string): unknown {
  if (!key) return undefined;
  const segs = key.split(".");
  let cur = value;
  for (const s of segs) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

/** PHP preg_match_all('/reg/', body) 语义: 返回按"组"聚合的结构,
 *  matchRes[0]=所有完整匹配, matchRes[1]=所有第一捕获组, ... */
function regexMatchAll(reg: string, body: string): string[][] {
  const re = new RegExp(reg, "g");
  const matches: string[][] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    for (let g = 0; g < m.length; g++) {
      if (!matches[g]) matches[g] = [];
      matches[g].push(m[g]);
    }
  }
  return matches;
}

/** PHP intval(_get(matchRes, regAt)) 语义 */
function matchSet(key: string, parse: Record<string, any>, body: string, data: any, isList: boolean): void {
  const isArr = key === "thumb" || key === "title";
  const reg = parse[key] || (isArr ? parse.link : "");
  const regAt = parse[key + "Reg"];
  const regReplace = parse[key + "Replace"];
  if (!reg && !regAt) return;

  let matchRes: string[][];
  try {
    matchRes = regexMatchAll(reg, body);
  } catch {
    return;
  }
  if (!matchRes || !matchRes.length) return;

  if (!isList) {
    // 单值处理
    const at = String(regAt || "").replace("{{last}}", String(matchRes.length - 1));
    const val = at ? lngGet(matchRes, at) : matchRes[0];
    const raw = Array.isArray(val) ? String(val[0] ?? 0) : String(val ?? 0);
    data[key] = parseInt(raw, 10) || 0;
    return;
  }

  // 多值处理
  const listMatch = regAt ? lngGet(matchRes, regAt) : matchRes[0];
  if (!Array.isArray(listMatch)) return;
  for (let i = 0; i < listMatch.length; i++) {
    let value = String(listMatch[i]);
    if (Array.isArray(regReplace) && regReplace[0]) {
      try {
        value = value.replace(new RegExp(String(regReplace[1]), "g"), String(regReplace[2]));
      } catch {
        /* ignore */
      }
    } else if (Array.isArray(regReplace) && regReplace[1] != null && regReplace[2] != null) {
      value = value.split(String(regReplace[1])).join(String(regReplace[2]));
    }
    if (!data[i]) data[i] = {};
    data[i][key] = value;
  }
}

/** 001 imageParse: 解析壁纸接口响应 -> {list, pageInfo} */
function imageParse(body: string, api: Record<string, any>): { list: any[]; pageInfo: any } | false {
  const parse: Record<string, any> = api.parse || {};
  const list: any[] = [];
  const pageInfo: any = {
    pageTotal: lngGet(parse, "pageTotalSet") ?? "",
    totalNum: lngGet(parse, "totalNumSet") ?? "",
  };
  const urlAdd = parse.urlAdd ? String(parse.urlAdd) : "";

  if (parse.type === "json") {
    let json: any;
    try {
      json = JSON.parse(body);
    } catch {
      return false;
    }
    const listData = parse.arr ? lngGet(json, parse.arr) : json;
    if (!Array.isArray(listData)) return false;
    for (const item of listData) {
      list.push({
        link: urlAdd + (lngGet(item, parse.link) ?? ""),
        thumb: lngGet(item, parse.thumb) ?? "",
        title: lngGet(item, parse.title) ?? "",
      });
    }
    pageInfo.pageTotal = lngGet(json, parse.pageTotal) ?? pageInfo.pageTotal;
    pageInfo.totalNum = lngGet(json, parse.totalNum) ?? pageInfo.totalNum;
    return { list, pageInfo };
  }

  if (!parse.link || !body) return false;
  matchSet("link", parse, body, list, true);
  matchSet("thumb", parse, body, list, true);
  matchSet("title", parse, body, list, true);
  matchSet("pageTotal", parse, body, pageInfo, false);
  matchSet("totalNum", parse, body, pageInfo, false);
  return { list, pageInfo };
}

/** 拉取 wallpage/api 配置列表 (缓存 3600s) */
async function loadApi(c: any): Promise<any> {
  const server = ((await getSetting(c.env.DB, "kodApiServer")) || "").replace(/\/+$/, "");
  if (!server) return false;
  const cached = cacheGet("wallpageImageApi", 3_600_000);
  if (cached) return cached;

  let res: Response;
  try {
    res = await fetch(server + "/wallpage/api", { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    console.error("[viewImage] loadApi fetch error:", String(err));
    return false;
  }
  if (!res.ok) {
    console.error("[viewImage] loadApi !ok:", res.status);
    return false;
  }
  let json: any;
  try {
    json = await res.json();
  } catch {
    return false;
  }
  if (!json || !json.code || !json.data || typeof json.data !== "object") return false;
  cacheSet("wallpageImageApi", json.data);
  return json.data;
}

/** 001 user/viewImage/request */
viewImageApi.all("/viewImage/request", authRequired, async (c) => {
  const query = c.req.query();
  const params = { ...(await c.req.parseBody<Record<string, string>>()), ...query };
  const type = params.type === "search" ? "search" : "show";
  const apiArr = await loadApi(c);
  if (!apiArr || typeof apiArr[type] !== "object" || !apiArr[type]) {
    return c.json({ code: false, data: "common.version.networkError" });
  }
  const api: Record<string, any> = apiArr[type];

  const search = String(params.search || "");
  let page = parseInt(String(params.page || "1"), 10);
  if (!page || page <= 0) page = 1;
  const pageMax = parseInt(String(lngGet(api, "parse.pageTotalSet") ?? 0), 10) || 0;
  if (pageMax && page >= pageMax) page = pageMax;
  const pageOffset = parseInt(String(lngGet(api, "parse.pageOffset") ?? 0), 10) || 0;
  const pageValue = pageOffset ? Math.floor(pageOffset * page) : page;

  const url = String(api.url || "")
    .split("{{page}}").join(String(pageValue))
    .split("{{search}}").join(encodeURIComponent(search));

  const cacheKey = "wallpageImageApi-" + url;
  const cacheHit = cacheGet(cacheKey, 600_000) as any;
  if (cacheHit) return c.json({ code: true, data: cacheHit });

  let res: Response;
  try {
    const headers = api.header && typeof api.header === "object" ? (api.header as Record<string, string>) : {};
    res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers });
  } catch {
    return c.json({ code: false, data: "Request data error!" });
  }
  const body = await res.text();
  const result = imageParse(body, api);
  if (!result) return c.json({ code: false, data: "Request data error!" });
  result.pageInfo.page = page;
  cacheSet(cacheKey, result);
  return c.json({ code: true, data: result });
});

export { viewImageApi };
