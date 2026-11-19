/**
 * 路由层通用工具 - 统一 001 show_json 响应结构与参数合并方式
 *
 * 目的: 各 route 文件此前各自复制一份 ok/fail/allParams, 实现虽相同但四处漂移;
 * 这里收敛为一个实现, 新增路由直接 import 即可。
 *
 * 注意: 少数文件(autotask-api 的 ok/fail 会走 i18n t()、comment-api / user-account-api
 * 有附加的 code/infoMore 参数、adminer 的 fail 直接返回 Response)语义不同, 保持原样不迁移。
 */

/** 成功响应: { code: true, data, info? } */
export function ok(data: any, info?: any) {
  const res: any = { code: true, data };
  if (info !== undefined) res.info = info;
  return res;
}

/** 失败响应: { code: false, data } */
export function fail(data: any) {
  return { code: false, data };
}

/**
 * 合并 query 与 body 参数 (body 覆盖 query)。
 * 非字符串值(上传的 File 等)按空字符串处理, 与 001 request 语义一致。
 */
export async function allParams(c: any): Promise<Record<string, string>> {
  const merged: Record<string, string> = { ...c.req.query() };
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  for (const [k, v] of Object.entries(body)) merged[k] = typeof v === "string" ? v : "";
  return merged;
}
