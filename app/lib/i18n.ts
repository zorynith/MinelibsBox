/**
 * Backend i18n translation helper.
 *
 * 001 PHP backend returns localized text (via LNG()) inside `show_json($data, $code, $info)`,
 * so the SPA displays `data` verbatim via `Tips.close(data, code)`. The Worker backend must
 * therefore return translated text rather than raw i18n keys (the SPA does NOT translate
 * string keys on its own).
 *
 * This module keeps a minimal zh-CN / en fallback map for keys used in API responses.
 * The full language packs live under static/config/i18n/ and are served to the SPA via
 * user/view/lang; use loadLangPack() when full coverage is needed.
 */

const ZH: Record<string, string> = {
  "explorer.success": "操作成功",
  "explorer.error": "操作失败",
  "explorer.settingSuccess": "修改已生效",
  "common.invalid": "无效的",
  "common.invalidRequest": "不合法的请求类型",
  "common.invalidParam": "无效的参数",
  "common.illegalRequest": "非法请求",
  "common.errorExpiredRequest": "无效的请求或已经失效",
  "common.expiredRequest": "请求已失效",
  "user.nameExists": "用户名已存在",
  "user.nickNameError": "昵称不合法",
  "user.pwdError": "用户名或密码错误",
  "user.oldPwdError": "原密码错误",
  "user.pwdNotNull": "密码不能为空",
  "user.registNotAllow": "系统未开启注册，请联系管理员",
  "user.registed": "已被注册",
  "user.binded": "已绑定",
  "user.notBind": "尚未绑定",
  "user.codeErrorFreq": "发送频率过高，请稍后再试",
  "user.sendSuccess": "发送成功",
  "user.sendFail": "发送失败",
  "admin.role.delErrTips": "该角色正在被使用，无法删除",
  "admin.member.delErrTips": "该成员正在被使用，无法删除",
};

const EN: Record<string, string> = {
  "explorer.success": "Success",
  "explorer.error": "Error",
  "explorer.settingSuccess": "Saved",
  "common.invalid": "Invalid",
  "common.invalidRequest": "Invalid request",
  "common.invalidParam": "Invalid parameter",
  "common.illegalRequest": "Illegal request",
  "common.errorExpiredRequest": "Invalid or expired request",
  "common.expiredRequest": "Request expired",
  "user.nameExists": "Username already exists",
  "user.nickNameError": "Invalid nickname",
  "user.pwdError": "Incorrect username or password",
  "user.oldPwdError": "Incorrect old password",
  "user.pwdNotNull": "Password cannot be empty",
  "user.registNotAllow": "Registration is disabled, please contact the administrator",
  "user.registed": "Already registered",
  "user.binded": "Already bound",
  "user.notBind": "Not bound yet",
  "user.codeErrorFreq": "Too frequent, please try again later",
  "user.sendSuccess": "Sent",
  "user.sendFail": "Failed to send",
  "admin.role.delErrTips": "This role is in use and cannot be deleted",
  "admin.member.delErrTips": "This member is in use and cannot be deleted",
};

/** Translate an i18n key to display text. Falls back to the key itself when unknown. */
export function t(key: string, lang: string = "zh-CN"): string {
  if (!key) return "";
  const pack = lang.startsWith("en") ? EN : ZH;
  return pack[key] ?? key;
}
