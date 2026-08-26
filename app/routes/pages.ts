/**
 * Page routes - serves 003 MbesBox SPA index.html
 * The SPA frontend loads from static/ and calls API_HOST for data
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { getSessionId } from "../lib/auth";
import { getSession } from "../lib/db";
import { getStaticHost } from "../lib/user-system";
import { devLicenseItem, DEV_KOD } from "../lib/license";

const pageRoutes = new Hono<{ Bindings: Env }>();

// SPA entry - serves the main index.html (replaces PHP template)
pageRoutes.get("/", serveIndex);
pageRoutes.get("/index.php", serveIndex);

function getAppHost(c: Context<{ Bindings: Env }>) {
  const forwardedHost = c.req.header("X-Forwarded-Host");
  if (forwardedHost) {
    const proto = c.req.header("X-Forwarded-Proto") || "https";
    return proto + "://" + forwardedHost + "/";
  }
  const url = new URL(c.req.url);
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const proto = isLocal ? "http" : "https";
  return proto + "://" + url.host + "/";
}

async function serveIndex(c: Context<{ Bindings: Env }>) {
  const appHost = getAppHost(c);
  // Static files are hosted on GitHub Pages (STATIC_HOST) in production;
  // without STATIC_HOST we fall back to "/" (ASSETS binding serves ./static at root).
  const staticPath = getStaticHost(c);
  const version = "mb";

  // 真实用户数（授权卡「已用用户数」）
  let userCount = 0;
  try {
    const row = await c.env.DB.prepare("SELECT COUNT(*) AS c FROM users").first<{ c: number }>();
    userCount = row?.c ?? 0;
  } catch (e) {
    userCount = 0;
  }
  const licenseItem = devLicenseItem(userCount);

  // Helper: generate static URL with cache busting
  const linkHref = (p: string) => `${staticPath}${p}?v=${version}`;

  return c.html(`<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1" />
  <meta http-equiv="Cache-Control" content="no-transform" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, shrink-to-fit=no" />
  <meta name="renderer" content="webkit">
  <meta name="format-detection" content="telephone=no" />
  <meta name="format-detection" content="email=no" />
  <meta name="description" content="Minelibs资源管理器" />
  <meta name="keywords" content="Minelibs,资源管理器,文件管理" />
  <meta name="generator" content="MbesBox"/>
  <title>MbesBox</title>

  <link href="${appHost}index.php?user/view/manifest" rel="manifest" />
  <meta itemprop="image" content="${linkHref("images/icon/icon_512.png")}" />
  <link href="${linkHref("images/icon/icon_512.png")}" rel="apple-touch-icon"/>
  <link href="${linkHref("images/icon/fav.png")}" rel="Shortcut Icon" type="image/x-icon" />
  <link href="${linkHref("images/icon/fav.png")}" rel="icon" type="image/x-icon" />

  <meta name="apple-touch-fullscreen" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="default" />
  <meta name="apple-mobile-web-app-title" content="MbesBox" />
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="browsermode" content="application" />
  <meta name="full-screen" content="yes" />
  <meta name="x5-page-mode" content="app" />
  <meta name="x5-fullscreen" content="true" />
</head>

<body>
  <div id="app"></div>
  <style>
    .bg-black{background:#333;}
    .loading-body div{
      position:fixed;margin:auto;left:0;top:0;right:0;bottom:0;max-width:64px;
      max-height:64px;width:64px;border-radius:4px;opacity:0.8;background-size: contain;
      background-image:url("${linkHref("images/common/loading-page.gif")}");
    }
    .bg-black .loading-body div,.dark-mode .loading-body div{
      width:36px;height:36px;
      background-image:url("${linkHref("images/common/loading-pin3-dark.gif")}");
    }
  </style>

  <style>
    /* 授权开发版：隐藏授权/更新/购买/免费版相关 UI（「服务到期时间」行由 timeToService=0 在模板层隐藏） */
    .admin-menu-left li[link-href="admin/setting/license"],
    [data-action="resetLicense"],
    [data-action="setLicense"],
    .version_vip_free,
    .license-free,
    .version-free,
    .check-update,
    .bottom-tips.history-license-info,
    .admin-setting-page .info-box-version iframe {
      display: none !important;
    }
  </style>

  <div class="loading-body"><div></div></div>
  <script type="text/javascript">
    // 全局配置对象
    window.G = {
      system: {
        options: {
          systemNameType: "image",
          systemName: "MbesBox",
          systemLogo: "${staticPath}images/common/logo.png"
        }
      },
      kod: {
        versionType: "B",
        channel: "default",
        kodID: "${DEV_KOD.kodID}",
        version: "${DEV_KOD.version}",
        build: "${DEV_KOD.build}"
      },
      lang: "zh-CN",
      i18n: {
        enabled: true,
        defaultLang: "zh-CN",
        supportedLangs: ["zh-CN", "en", "zh-TW"],
        autoDetect: true
      }
    };

    // 语言包系统 - 扁平语言包对象（与001原版一致）
    // main.js 通过 LNG["key"] 下标访问语言包，因此 window.LNG 必须是扁平对象，
    // 所有语言 key 直接作为其属性。完整语言包随后通过 user/view/lang 合并进来。
    window.LNG = {
      // ---- 兜底语言包（完整语言包加载前使用，仅包含核心 key）----
      "common.copyright.homepage": "",
      "common.copyright.powerBy": "Powered by MbesBox",
      "common.copyright.name": "MbesBox",
      "common.copyright.desc": "——Minelibs资源管理器",
      "common.copyright.metaKeywords": "Minelibs,资源管理器",
      "common.copyright.metaName": "MbesBox",
      "common.copyright.downloadLink": "",
      "common.loginTitle": "登录",
      "common.login": "登录",
      "common.username": "用户名",
      "common.password": "密码",
      "common.ok": "确定",
      "common.cancel": "取消",
      "common.remember": "记住密码",
      "common.edit": "编辑",
      "common.save": "保存",
      "common.delete": "删除",
      "common.add": "添加",
      "common.update": "更新",
      "common.loading": "加载中...",
      "common.error": "错误",
      "common.success": "成功",
      "common.warning": "警告",
      "common.info": "信息",
      "user.loginError": "登录失败",
      "user.pwdError": "密码错误",
      "user.userNotExist": "用户不存在",
      "user.pwdNotNull": "密码不能为空",
      "user.rootPwdEqual": "两次密码不一致",
      "user.logout": "退出登录",
      "user.profile": "个人资料",
      "user.settings": "设置",
      "user.admin": "管理员",
      "title": "MbesBox",
      "system.loading": "系统加载中...",
      "system.error": "系统错误",
      "system.maintenance": "系统维护中",
      "system.upgrade": "系统升级中",
      "explorer.openFather": "打开上级目录",
      "explorer.shareDoc.menuUser": "分享给用户",
      "explorer.shareDoc.menuTree": "分享到树",
      "explorer.wordLoading": "正在加载文档...",
      "explorer.fileLoading": "正在加载文件...",
      "explorer.folderLoading": "正在加载文件夹...",
      "explorer.uploadSuccess": "上传成功",
      "explorer.uploadError": "上传失败",
      "explorer.deleteSuccess": "删除成功",
      "explorer.deleteError": "删除失败",
      "explorer.renameSuccess": "重命名成功",
      "explorer.renameError": "重命名失败",
      "explorer.createSuccess": "创建成功",
      "explorer.createError": "创建失败",
      "officeViewer.meta.name": "Office阅读器",
      "officeViewer.meta.title": "Office在线预览",
      "officeViewer.meta.desc": "Office文件在线预览。本应用整合了WebOffice、LibreOffice、officeLive、永中office等方式，实现office文件基本的在线预览需求。",
      "officeViewer.main.invalidType": "当前方式无法预览此文件，请选择其他打开方式！",
      "officeViewer.main.invalidExt": "不支持的文件格式",
      "officeViewer.main.error": "操作失败！",
      "officeViewer.webOffice.name": "自动解析",
      "officeViewer.webOffice.desc": "选择【自动解析】时，会优先使用前端解析方式（doc、ppt除外），如果不支持，将自动切换为下一种；前端解析无需借助外网和其他服务，加载速度快，但排版与原文件有一定差异，部分内容可能显示不全或异常。",
      "officeViewer.webOffice.parsing": "正在解析",
      "officeViewer.webOffice.reqErrPath": "请求失败，检查文件是否正常！",
      "officeViewer.webOffice.reqErrNet": "加载时间过长，检查网络是否正常！",
      "officeViewer.webOffice.reqErrUrl": "文件请求失败，请检查地址是否正常！",
      "officeViewer.webOffice.noEditTips": "不支持内容编辑，请选择其他方式！",
      "officeViewer.webOffice.warning": "⚠️ 当前模式下，公式、图表等内容可能显示不全或异常，查看完整内容请选用其他方式"
    };

    // 辅助方法（以非枚举方式挂载，避免与语言 key 冲突）
    window.LNG.set = function(langData) {
      if (typeof langData === "object" && langData) {
        Object.assign(window.LNG, langData);
      }
      return window.LNG;
    };
    window.LNG.get = function(k) {
      return window.LNG[k] !== undefined ? window.LNG[k] : (k || "");
    };
    window.LNG.find = function() { return {}; };
    window.LNG.make = function(k) { return window.LNG.get(k); };
    window.LNG.space = "";
    // logo 渲染完全由 main.js 原版 LNG.logo 逻辑接管：
    // - systemNameType==="image" 时显示 systemLogo 图标
    // - systemNameType==="text"  时显示 systemName 文字
    // 此处不覆盖，避免与 main.js 内嵌的原版定义冲突。
    window.LNG.switch = function(lang) {
      window.G.lang = lang;
      try { localStorage.setItem("userLanguage", lang); } catch (e) {}
      window.dispatchEvent(new CustomEvent("languageChanged", { detail: { language: lang } }));
    };
    window.LNG.load = function(lang) {
      // 完整语言包由 user/view/lang API 加载并合并；此处留空兼容
      if (lang) { window.G.lang = lang; }
    };

    // API主机和静态路径
    window.API_HOST = "${appHost}index.php?";
    window.STATIC_PATH = "${staticPath}";
    window.STATIC_PATH_ALL = "${staticPath}";
    
    // HTML转义函数
    window.htmlEncode = function(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    // MD5 哈希函数 - main.js 原版 LNG.logo("copyright") 版权分支依赖 window.md5
    // （001 原版前端缺失此函数，此处补充标准实现）
    window.md5 = (function() {
      function safeAdd(x, y) {
        var lsw = (x & 0xFFFF) + (y & 0xFFFF);
        var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
        return (msw << 16) | (lsw & 0xFFFF);
      }
      function bitRotateLeft(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
      function md5cmn(q, a, b, x, s, t) {
        return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
      }
      function md5ff(a, b, c, d, x, s, t) { return md5cmn((b & c) | (~b & d), a, b, x, s, t); }
      function md5gg(a, b, c, d, x, s, t) { return md5cmn((b & d) | (c & ~d), a, b, x, s, t); }
      function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
      function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | ~d), a, b, x, s, t); }
      function binlMD5(x, len) {
        x[len >> 5] |= 0x80 << (len % 32);
        x[((len + 64) >>> 9 << 4) + 14] = len;
        var i, olda, oldb, oldc, oldd, a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
        for (i = 0; i < x.length; i += 16) {
          olda = a; oldb = b; oldc = c; oldd = d;
          a = md5ff(a, b, c, d, x[i], 7, -680876936);
          d = md5ff(d, a, b, c, x[i + 1], 12, -389564586);
          c = md5ff(c, d, a, b, x[i + 2], 17, 606105819);
          b = md5ff(b, c, d, a, x[i + 3], 22, -1044525330);
          a = md5ff(a, b, c, d, x[i + 4], 7, -176418897);
          d = md5ff(d, a, b, c, x[i + 5], 12, 1200080426);
          c = md5ff(c, d, a, b, x[i + 6], 17, -1473231341);
          b = md5ff(b, c, d, a, x[i + 7], 22, -45705983);
          a = md5ff(a, b, c, d, x[i + 8], 7, 1770035416);
          d = md5ff(d, a, b, c, x[i + 9], 12, -1958414417);
          c = md5ff(c, d, a, b, x[i + 10], 17, -42063);
          b = md5ff(b, c, d, a, x[i + 11], 22, -1990404162);
          a = md5ff(a, b, c, d, x[i + 12], 7, 1804603682);
          d = md5ff(d, a, b, c, x[i + 13], 12, -40341101);
          c = md5ff(c, d, a, b, x[i + 14], 17, -1502002290);
          b = md5ff(b, c, d, a, x[i + 15], 22, 1236535329);
          a = md5gg(a, b, c, d, x[i + 1], 5, -165796510);
          d = md5gg(d, a, b, c, x[i + 6], 9, -1069501632);
          c = md5gg(c, d, a, b, x[i + 11], 14, 643717713);
          b = md5gg(b, c, d, a, x[i], 20, -373897302);
          a = md5gg(a, b, c, d, x[i + 5], 5, -701558691);
          d = md5gg(d, a, b, c, x[i + 10], 9, 38016083);
          c = md5gg(c, d, a, b, x[i + 15], 14, -660478335);
          b = md5gg(b, c, d, a, x[i + 4], 20, -405537848);
          a = md5gg(a, b, c, d, x[i + 9], 5, 568446438);
          d = md5gg(d, a, b, c, x[i + 14], 9, -1019803690);
          c = md5gg(c, d, a, b, x[i + 3], 14, -187363961);
          b = md5gg(b, c, d, a, x[i + 8], 20, 1163531501);
          a = md5gg(a, b, c, d, x[i + 13], 5, -1444681467);
          d = md5gg(d, a, b, c, x[i + 2], 9, -51403784);
          c = md5gg(c, d, a, b, x[i + 7], 14, 1735328473);
          b = md5gg(b, c, d, a, x[i + 12], 20, -1926607734);
          a = md5hh(a, b, c, d, x[i + 5], 4, -378558);
          d = md5hh(d, a, b, c, x[i + 8], 11, -2022574463);
          c = md5hh(c, d, a, b, x[i + 11], 16, 1839030562);
          b = md5hh(b, c, d, a, x[i + 14], 23, -35309556);
          a = md5hh(a, b, c, d, x[i + 1], 4, -1530992060);
          d = md5hh(d, a, b, c, x[i + 4], 11, 1272893353);
          c = md5hh(c, d, a, b, x[i + 7], 16, -155497632);
          b = md5hh(b, c, d, a, x[i + 10], 23, -1094730640);
          a = md5hh(a, b, c, d, x[i + 13], 4, 681279174);
          d = md5hh(d, a, b, c, x[i], 11, -358537222);
          c = md5hh(c, d, a, b, x[i + 3], 16, -722521979);
          b = md5hh(b, c, d, a, x[i + 6], 23, 76029189);
          a = md5hh(a, b, c, d, x[i + 9], 4, -640364487);
          d = md5hh(d, a, b, c, x[i + 12], 11, -421815835);
          c = md5hh(c, d, a, b, x[i + 15], 16, 530742520);
          b = md5hh(b, c, d, a, x[i + 2], 23, -995338651);
          a = md5ii(a, b, c, d, x[i], 6, -198630844);
          d = md5ii(d, a, b, c, x[i + 7], 10, 1126891415);
          c = md5ii(c, d, a, b, x[i + 14], 15, -1416354905);
          b = md5ii(b, c, d, a, x[i + 5], 21, -57434055);
          a = md5ii(a, b, c, d, x[i + 12], 6, 1700485571);
          d = md5ii(d, a, b, c, x[i + 3], 10, -1894986606);
          c = md5ii(c, d, a, b, x[i + 10], 15, -1051523);
          b = md5ii(b, c, d, a, x[i + 1], 21, -2054922799);
          a = md5ii(a, b, c, d, x[i + 8], 6, 1873313359);
          d = md5ii(d, a, b, c, x[i + 15], 10, -30611744);
          c = md5ii(c, d, a, b, x[i + 6], 15, -1560198380);
          b = md5ii(b, c, d, a, x[i + 13], 21, 1309151649);
          a = md5ii(a, b, c, d, x[i + 4], 6, -145523070);
          d = md5ii(d, a, b, c, x[i + 11], 10, -1120210379);
          c = md5ii(c, d, a, b, x[i + 2], 15, 718787259);
          b = md5ii(b, c, d, a, x[i + 9], 21, -343485551);
          a = safeAdd(a, olda); b = safeAdd(b, oldb); c = safeAdd(c, oldc); d = safeAdd(d, oldd);
        }
        return [a, b, c, d];
      }
      function binl2hex(binarray) {
        var hexTab = "0123456789abcdef", str = "", i;
        for (i = 0; i < binarray.length * 4; i++) {
          str += hexTab.charAt((binarray[i >> 2] >> ((i % 4) * 8 + 4)) & 0xF) +
                 hexTab.charAt((binarray[i >> 2] >> ((i % 4) * 8)) & 0xF);
        }
        return str;
      }
      function str2binl(str) {
        var bin = [], mask = (1 << 8) - 1, i;
        for (i = 0; i < str.length * 8; i += 8) {
          bin[i >> 5] |= (str.charCodeAt(i / 8) & mask) << (i % 32);
        }
        return bin;
      }
      return function(s) {
        var str = String(s);
        return binl2hex(binlMD5(str2binl(str), str.length * 8));
      };
    })();

    try{navigator.serviceWorker && navigator.serviceWorker.register('${appHost}index.php?user/view/manifestJS');}catch(err){}
    if(!navigator["mimeTypes"]) navigator["mimeTypes"] = {};
    var isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    if(isDark){document.getElementsByTagName('body')[0].setAttribute("class","bg-black");}
    // Patch String.prototype to prevent renderHtml crashes on undefined
    var _origReplace = String.prototype.replace;
    String.prototype.replace = function() {
      if(this === void 0 || this === null) return "";
      return _origReplace.apply(this, arguments);
    };
  </script>

  <link href="${linkHref("style/lib/main.css")}" rel="stylesheet" />
  <link href="${linkHref("style/dist/main.css")}" rel='stylesheet' />
  <script src="${linkHref("app/vender/es3-profill.js")}"></script>
  <script src="${linkHref("app/vender/lodash.min.js")}"></script>
  <script src="${linkHref("app/dist/vendor.js")}"></script>
  <script src="${linkHref("app/dist/main.js")}"></script>
  <script type="text/javascript">
    // 授权开发版：覆盖授权信息卡(item)为开发版状态
    window.__LICENSE_ITEM = ${JSON.stringify(licenseItem)};
    (function(){
      var _origRender = window.ClassBase && window.ClassBase.prototype.renderHtml;
      if (!_origRender) return;
      window.ClassBase.prototype.renderHtml = function(tpl, data, append){
        if (data && data.item && data.item.versionType !== undefined) {
          data.item = Object.assign({}, window.__LICENSE_ITEM);
        }
        return _origRender.call(this, tpl, data, append);
      };
    })();
  </script>
</body>
</html>`);
}

export { pageRoutes };
