# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent during task execution should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[前端 dist/dev/orig 目录组织规则]
- Date: 2026-08-19
- Context: 用户明确要求的目录组织约定
- Instructions:
  - static/app/dist/dev/ 存放的永远是反混淆版文件，禁止改动。
  - static/app/dist/orig/ 存放的永远是原版混淆文件，禁止改动。
  - 只改动 static/app/dist/ 根目录的文件：已完成反混淆的文件用 dev 版，未完成反混淆的文件用 orig 原版。
  - 替换时从 dev/ 或 orig/ 复制到 dist 根目录，dev 和 orig 目录内容保持不变。

[Project Knowledge Summary]
- Date: 2026-08-15
- Context: Discovered by Agent while performing fav(收藏夹)功能本地冒烟测试
- Category: Build Methods
- Instructions:
  - 本地 dev 必须先用 `npm run build` 生成 dist 产物，再执行 `npm run dev`（即 `wrangler dev`）。此时 wrangler 读取 `dist/ssr/wrangler.json` 并自动绑定本地 D1/R2/ASSETS 环境，API 才能正常响应。
  - 缺少根目录 `wrangler.jsonc` 时 `npm run build` 只生成 dist/client（无 ssr worker bundle），wrangler dev 会 404；必须先 `cp wrangler.jsonc.example wrangler.jsonc` 再 build。
  - 本地 dev 时 ASSETS 绑定指向 `dist/client`，`static/` 源目录内容必须通过 `vite.config.ts` 的 `publicDir: "static"` 复制进 dist/client，否则前端与插件静态资源全部 404（线上部署用 wrangler.jsonc.example 的 assets.directory=./static，与本地机制不同）。
  - `npx vite dev` 只启动前端静态服务，worker API（/api/...、/index.php?MOD/ST/ACT）全部 404，不能用于后端接口测试。
  - 需要本地 D1/R2 绑定前，先执行 `cp wrangler.jsonc.example wrangler.jsonc`；该文件已被 .gitignore 忽略，测试后可删除。
  - 001 前端接口参数可通过 query（`/index.php?explorer/fav/add&path=...&name=...`）或 JSON body 传递，后端路由需兼容两种方式。

[Project Knowledge Summary]
- Date: 2026-08-15
- Context: Discovered by Agent while performing 001 插件系统复刻（纯前端五件套 DPlayer/jPlayer/photoSwipe/picasa/htmlEditor）
- Category: Build Methods
- Instructions:
  - `/api/user/view/plugins` 输出格式为 `var kodReady=[];` + 各插件 echoJs 拼接，Content-Type application/javascript；003 前端 `loadPlugin()` 遍历 `window.kodReady` 逐个执行。
  - 插件模板替换（001 PluginBase echoFile 顺序）：先 parseFile（`{{pluginHost}}`/`{{pluginHostDefault}}`/`{{pluginApi}}`/`{{pluginName}}`/`{{pluginPath}}`/`{{APP_HOST}}`/`{{staticPath}}` + `{{LNG}}`整体 + `{{config}}`整体），再 parseLang（`{{LNG['key']}}`）、parseConfig（`{{config.key}}`）、parsePackage（`{{package.key}}`）；`{{LNG}}` 替换为 urlencoded JSON 语言包、`{{config}}` 替换为 urlencoded JSON 配置。
  - 插件 package.json 是无效 JSON（`//`注释、行尾逗号、键无引号场景），须用逐字符容错解析（字符串外才剥离注释/尾逗号），勿直接 JSON.parse。
  - 插件 package.json 的 name/title 等字段本身含 `{{LNG['xxx']}}`，替换 `{{package.*}}` 前必须先对该字段做语言解析（001 appPackage 先 parseFile+parseLang 再 json_decode）。
  - 插件静态资源挂 `static/plugins/{name}/`，模板 `{{pluginHost}}` 替换为 `${appHost}plugins/{name}/`（001 中 pluginHost 指向 `?plugin/{name}/`，本实现用 ASSETS 静态直服）。
  - 插件 i18n 存 `static/plugins/i18n/{name}.{lang}.json`（从 001 `{name}/i18n/{lang}.php` 转换），语言检测复用 i18n-lang 的 detectLang。

[User Instruction Summary]
- Date: 2026-08-15
- Context: 用户要求以后提交代码时同时推送到两个远程仓库
- Instructions:
  - 每次 `git push` 需同时推送到 GitHub（https://github.com/zorynith/MinelibsBox，用户名 zorynith）与 Gitee（https://gitee.com/minelibs/mbesbox）两个仓库。
  - origin 已配置双 push 地址（`git remote set-url --add --push origin <url>`），push 时自动同时推送两个仓库。
  - GitHub 认证凭据由 `/root/.local/bin/git-cred-wrapper` 按 host 分发（github.com 返回 zorynith token，其余转发给系统 agent credential helper），token 严禁泄露、严禁写入仓库或聊天输出。

[Project Knowledge Summary]
- Date: 2026-08-20
- Context: 用户提供新主域名（替换旧主域名）
- Category: Operations & Deployment
- Instructions:
  - 主域名已更换为 https://cloud.minelibs.eu.org/，需要测试时直接使用该地址（旧 mbos.minelibs.eu.org 不再作为主域名）。
  - 静态文件域名保持 https://static.minelibs.eu.org/ 不变。
  - 主域名通过 Cloudflare 控制台/DNS 绑定，仓库代码无主域名硬编码（getAppHost 动态生成）。

[Project Knowledge Summary]
- Date: 2026-08-15
- Context: Discovered by Agent while performing 001 用户系统核心账户接口复刻
- Category: Troubleshooting & Debugging
- Instructions:
  - 001 用户接口响应格式统一 `{code:true/false, data:...}`；登录返回 `{code:true, data:{userID,name,nickname,...}}`，失败 `{code:false, data:"错误文案"}`。
  - 前端密码一律 `authCrypt.encode(plain, rand5+"2&$%@(*@(djfhj1923")` 并以 `salt:1` 发送，后端用 `parseKodPassword(pass, salt)` 解码；salt 非 "1" 时按明文处理。
  - 图形验证码存 D1 `verify_code` 表（`captcha_{key}` + `kod_captcha` cookie 对 key），发送消息码必须先校验图形码。
  - `setVerifyCode` 参数顺序为 `(key, type, code)`，曾因顺序颠倒导致验证码存储错乱。
  - 找回密码两步：step0 `{type:'email'|'phone', input, msgCode}` 返回 md5 token 存 D1；step1 `{token, password, salt:1}` 重置密码。`/index/findPassword` 与 `/setting/findPassword` 双路由共用 handler。
  - userLog/userDevice 分页返回 `{list, info:{totalNum, pageNum, pageTotal, page}}`，前端消费 `pageInfo.totalNum` 而非 `total`。
  - userSearch 需将 001 列名映射为 DB 列名（name→username, nickName→nickname, userID→id, sizeMax→size_max, lastLogin→last_login）。
  - 本地 D1 状态早于 schema 扩展时，需手工 `ALTER TABLE` 补列；CI 每次 DROP 重建，线上靠 `initDatabase()` 自动建表。

[Project Knowledge Summary]
- Date: 2026-08-15
- Context: Discovered by Agent while performing 静态文件托管从 R2 切换至 GitHub Pages
- Category: Operations & Deployment
- Instructions:
  - 静态文件（static/ 目录）托管于 GitHub Pages https://static.minelibs.eu.org/（`.github/workflows/deploy-pages.yml` 将 ./static 上传发布），Worker 仅保留 API + SPA index.html 生成。
  - 静态基址由 `getStaticHost(c)` 决定：设置 `STATIC_HOST` 环境变量时返回该域名，未设置时返回 `"/"`（ASSETS binding 将 ./static 映射到 worker 根，本地 dev 兜底）。GitHub vars 已显式配置 `STATIC_HOST=https://static.minelibs.eu.org/`，CI deploy.yml 的 `--var "STATIC_HOST:${STATIC_HOST:-https://static.minelibs.eu.org/}"` 优先读 vars，缺省时用默认值兜底。
  - `wrangler.jsonc` / `wrangler.jsonc.example` 均为 .gitignore 生成物，但 `npm run typecheck` 会从 example 重新生成 worker-configuration.d.ts，新增环境变量必须同步修改 example，否则类型检查报 Env 缺字段。
  - Worker `/static/*` 路由不再读 R2，改为代理到 STATIC_HOST（前端 main.js 硬编码 `./static/...` 相对路径仍会命中该路由）；R2 FILES bucket 仅存用户数据（key 为 `{username}/...` 前缀），与 static 前缀无冲突。
  - 切换涉及点：pages.ts 的 linkHref/systemLogo/STATIC_PATH/STATIC_PATH_ALL、user-api.ts 的 kod.staticPath/logo/favicon/systemLogo/manifest icons、explorer-api.ts desktopApp 图标、plugins.ts pluginHost，全部拼 getStaticHost(c)。
  - `window.STATIC_PATH_ALL` 必须随 STATIC_PATH 一并设置指向 Pages，否则 main.js 回退到 `G.kod.APP_HOST+"static/"`（katex 等资源 404）。

[Project Knowledge Summary]
- Date: 2026-08-15
- Context: Discovered by Agent while performing 用户管理/账号设置页接口排查与 adminModel(模块 7) apiConfig 解码
- Category: Troubleshooting & Debugging
- Instructions:
  - 前端 adminModel(模块 7) 的 URL 在压缩混淆产物里是 apiConfig 对象，映射 `groupList→admin/group/get、memberList→admin/member/get、roleList→admin/role/get、jobList→admin/job/get、authList→admin/auth/get` 等；解码方法见 `/tmp/opencode/decode_root_mod7.js`（旋转 381 + RC4）。
  - 用户管理页前端用 adminModel 的 groupList/memberList/roleList，账号设置页用 userModel 的 user/setting/*（setConfig/setUserInfo/sendMsg 等），两者 URL 与 001 完全一致。
  - 后端 admin API 必须注册 `all` 路由并同时兼容 query 与 body 参数（`{...c.req.query(), ...(await parseBody(c))}`），因为前端 GET/POST 均可能使用；仅注册 get 时 POST 请求会落入 catch-all 返回 `data:null`，表现为用户目录为空。
  - 前端请求 URL 形如 `/index.php?admin/group/get&parentID=root`（参数用 `&` 分隔拼在 MOD/ST/ACT 后，不是第二个 `?`）；用 `?` 拼参数会被 URL 重写当成路径编码（`%3F`），导致参数丢失返回 data:null。
  - 根目录 `static/app/dist/main.js` 模块数组拆分不可靠（混淆代码含字符串内括号/正则），朴素括号计数会合并错模块；按 `i(4)` 引用定位模块边界或以 var s,r=[ 混淆块锚定更稳。

[Project Knowledge Summary]
- Date: 2026-08-16
- Context: Discovered by Agent while performing 账号设置无反应排查与 versionType 功能解锁
- Category: Troubleshooting & Debugging
- Instructions:
  - 账号中心「账号设置」页 init 读 `G.system.options.loginConfig.allowPhone`，根目录 options 缺 `loginConfig` 键会 TypeError 渲染中断（点击无反应）；补齐 `loginConfig:{loginWith:[],allowPhone:"1",openRegist:"0"}` 即可，无需改 handler。
  - 前端 `authCrypt.encode` 生成的 base64 去掉了 `=` padding（url-safe），后端 `atob` 直接解码报 `invalid base64` 500；`base64ToBytes` 需按 `length%4` 补 padding（mod2 补 `==`、mod3 补 `=`）。
  - `G.kod.versionType` 控制功能限制（比较值仅 `"A"` 与 `"T"`）：`"A"==` 时回收站清空/配置、用户导入、bakSupFile 备份等被 `LNG["common.version.notSupport"]` 拦截；设为非 "A" 非 "T" 值（如 `"B"`）即解锁且不影响 app 市场 `"T"!=` 判断。需同步改 `options.kod.versionType`、`system.options.versionType`、`pages.ts` SSR 预置三处。
  - 001 后端对 versionType 的限制全部是 `== 'A'` 判断（historyLocal、msg、storeImport、lightApp、msgWarning），非 A 即完整版，无其他语义。
  - 登录接口 `/user/index/loginSubmit` 未传 salt 时密码按明文处理（`parseKodPassword` salt!="1" 直接返回原文），curl 测试登录用明文即可；改密码接口必须带 `salt=1` 加密值。
  - 部署触发链：GitHub Actions `deploy.yml` 在 push 到 main 分支时自动 build + D1 迁移/重置 + `wrangler deploy` 到 Cloudflare Worker；功能分支改动必须合并到 main 并 push 才会生效，仅 push 功能分支不会触发线上更新。CI 每次会 DROP 重建 D1 表并重新初始化 admin/admin123，线上管理员密码会被重置。
  - 登录后「密码强度不足」提示是 001 预期行为：登录成功走 `passwordCheckTips`，admin123 不满足 `passwordRule:strongMore` 规则（需大小写+数字），弹窗确定后 `Router.go("setting/user/account")` 跳转账号设置页并自动聚焦改密框；该弹窗与账号设置页空白无因果关系。
  - R2 免费版额度有限，需防目录自嵌套导致对象指数膨胀：paste/cut 目录到自身子树（如 A 粘贴到 A/B 下）时前端无防护，后端 `/paste` 必须检查 `destKey.startsWith(srcKey+"/")` 并拒绝；`/rename` 同样需拒绝 `newName` 为空/含 `/`/newKey 在 oldKey 子树内。错误码用 001 现成 `explorer.moveSubPathError`（父目录不能移动到子目录）与 `common.invalidParam`。
  - `deleteDirectory`（r2.ts）默认 `maxObjects=100000, maxRounds=1000` 保护，防止活锁/并发写入时游标追着新对象无限删；正常删除大目录不受影响。
   - R2 mkdir 用 `.keep` 占位文件表示空目录，`listDirectory` 的 folders 从 `delimitedPrefixes` 解析；测试时若把 mkdir 的 `path` 与 `name` 合并传入会生成 `undefined` 名称脏对象。

[Project Knowledge Summary]
- Date: 2026-08-16
- Context: Discovered by Agent while performing 去除前端授权/版权校验机制（checkLang/showError/checkVersion）
- Category: Troubleshooting & Debugging
- Instructions:
  - 前端授权/版权校验集中在 main.js 模块 34（License 类，`ClassBase.extend(r)` 定义，被模块 145/380/547/552 以 c(34) 引用）。核心方法：`checkVersion`（versionType==="A" 或 `G.kod` 无 versionHash 时走 free 分支 `addApp=""` 后 return，不校验）、`checkLang`（仅 `!support()` 即 version==="A" 时执行，校验 5 个 `common.copyright.*` 文案是否含 kodcloud/kodbox，否则延迟 `showError(true)`）、`checkBefore`（versionHash 二次解密校验，free 分支下不会被调用）、`showError`（所有授权错误统一出口：重置版本、清 addApp、跳 `user/license&reset=1`）。
  - 压缩混淆产物中 checkLang/showError/lisenseStyleSet/checkVersion 等方法名均为编码串，正文按字面量搜索为 0 次，不能直接按方法名 patch；需先 `node deobfuscate.js 34 > mod34_deob.js` 反混淆定位，仅 `support` 为明文。
  - Backbone（vendor.js 末尾 `window.ClassBase=Backbone.View`）的 extend 实现为 `child.prototype=_.create(parent.prototype, protoProps)` 原地复制 protoProps 自有属性。因此可在 vendor.js 加载后、main.js 加载前 hook `window.ClassBase.extend`，在调用前改写传入的 protoProps（如把 `protoProps.checkLang/showError` 替换为 no-op），即可在不改压缩 dist 的前提下禁用特定类的方法——这是改造混淆产物的通用手段。
  - 该方法仅匹配 `protoProps.checkLang` 为 function 的类（只有模块 34），不会误伤其它类；Backbone extend 的 `_.extend(child,parent,staticProps)` 会把父级静态属性复制到 child，但 hook 只作用于 `ClassBase.extend` 入口，不影响继承链。

[Project Knowledge Summary]
- Date: 2026-08-16
- Context: Discovered by Agent while performing 预览环境登录失败排查（卡登录页）
- Category: Troubleshooting & Debugging
- Instructions:
  - `getAppHost` 严禁回退到 `PUBLIC_HOST` 环境变量：预览代理不转发 X-Forwarded-Host，回退 PUBLIC_HOST 会使 `window.API_HOST`/`options.kod.appApi`/`APP_HOST` 全部指向线上域名，登录请求打不到本地 worker，表现为卡在登录页。
  - 预览代理 https 终止后以 http 转发到本地 worker，`c.req.url` 的 protocol 是 http；getAppHost 必须对非 localhost 主机强制 https，否则 https 页面发 http 请求会被浏览器按混合内容拦截，登录仍失败。
  - 正确实现：有 X-Forwarded-Host 用 `(X-Forwarded-Proto||"https")+"://"+forwardedHost`；否则用 `c.req.url` 的 host，hostname 为 localhost/127.0.0.1 时用 http，其余强制 https。
  - getAppHost 共三处需同步修改：pages.ts 内联实现、user-system.ts 的 getAppHost、user-api.ts 的 view/options 与 view/manifest 内联逻辑（后两处曾硬编码 PUBLIC_HOST，漏改会导致 appApi 仍指向线上）。
  - 本地调试登录 curl 用 `Cookie: kod_session=<sessionId>`（登录时 accessToken 与 kod_session 值相同）；`kod_session` 为 HttpOnly、`accessToken` 供前端 JS 读取。
  - wrangler dev 偶发 miniflare loopback 崩溃（报 "Network connection lost"、预览 530），多为环境内存紧张（balloon）导致 workerd 被杀；重启 `npx wrangler dev --port 8787` 即可恢复，非代码问题。

[Project Knowledge Summary]
- Date: 2026-08-17
- Context: Discovered by Agent while performing 左侧分类点击报「此类型目录不支持该操作」、面包屑显示 {block:root}>桌面>桌面>桌面、点击无反应空白警告排查
- Category: Troubleshooting & Debugging
- Instructions:
  - user/view 返回的 `io` 字段（前端 `G.io`）值必须是实际 path 类型字符串（`{source}`/`{block}`/`{userRencent}`/`{shareToMe}`/`{userFileTag}`/`{userFileType}` 等），不能是 `"KOD_SOURCE"` 字面量；值错误会让前端 pathInfoParse 的 switch、parsePathAuth、parse 的 isTruePath 全部走 default，表现为分类点击弹「此类型目录不支持该操作」、面包屑渲染异常。
  - 前端 parse path 用正则 `^\{(\w+):?(\d|[-\w]+)?\}(.*)$`，type = `{`+单词+`}`；KOD 常量值必须与之一致（KOD_USER_RECENT=`{userRencent}`、KOD_USER_SHARE_TO_ME=`{shareToMe}`、KOD_BLOCK=`{block}` 等）。
  - 虚拟路径拼写易错点：`{shareToMe}`（非 {userShareToMe}）、`{userRencent}`（非 {userRecent}）。
  - 面包屑（addressChildren）由前端 pathInfoParse 的 f(e) 用 pathDisplay 生成；source 路径缺 pathDisplay 时会显示 `{source:home}` 字面量，需给 current/folderItem/fileItem 补 pathDisplay，把 `{source:home}` 前缀替换为 rootPath 显示名（"个人空间"）。
  - block 根/子节点响应严禁内嵌 `children`（无论是布尔哨兵 `children:true` 还是数组嵌套）：前端 zTree `beforeAsync` 用 `_.isEmpty(n.children)` 判断是否丢弃 async 结果，`children:true` 会判为非空导致 `t=[]` 丢弃真实子节点（文件类型/个人标签展开无反应）；内嵌数组则因 item 未走 `dataFilterTree` 递归而缺 `_itemDataBefore`/`isTreeNode`，直点导航 getSourceInfo 返回 UNDEFINED → 空白警告。正确做法是 block 节点只返回 `type/isParent/path` 不内嵌 children，子节点统一由前端展开时请求 `{block:xxx}` / `{source:home}` 异步加载。

[Project Knowledge Summary]
- Date: 2026-08-20
- Context: Discovered by Agent while performing 后台新建部门/用户/角色空成功提示、系统设置保存刷新还原排查
- Category: Troubleshooting & Debugging
- Instructions:
  - 001 后端 `show_json($data, $code, $info)` 的 `data` 是 **PHP 端已翻译文案**（LNG() 翻译后的字符串），不是 i18n key；SPA 直接 `Tips.close(data, code)` 展示 data。因此 Worker 后端返回 `"explorer.success"` 这类 key 会导致前端要么显示 key 字面量、要么因 data 非字符串回退成 `LNG["explorer.success/error"]`，表现为空成功提示/提示无文案。
  - 前端 `Tips.close`/`parseMsg` 在 vendor.js module 657：只把「字符串 data」当文案展示，不二次翻译；data 为对象/数组/空时按 `code` 回退成 `LNG["explorer.success/error"]`。所以列表类负载（对象/数组）必须直接放 data，文案类才放字符串。
  - 修复方案：新增 `app/lib/i18n.ts` 提供同步 `t(key, lang)`（内置 zh-CN/en 最小映射，缺省原样返回 key），`admin-api.ts` 与 `user-account-api.ts` 的 `ok/fail` 对「字符串 data」调用 `t()` 翻译成文案后再返回；对象/数组 data 原样返回。硬编码中文文案经 `t()` 原样透传，无需单独处理。
  - 前端 API 映射（api.js / main.js adminModel 模块 7 apiConfig）：`groupList→admin/group/get、memberList→admin/member/get、roleList→admin/role/get、jobList→admin/job/get、authList→admin/auth/get`；写接口 `admin/group/add|edit|status|remove|sort|switchGroup`、`admin/member/add|edit|status|remove|addGroup|removeGroup|switchGroup|metaInfo`、`admin/role/add|edit|remove|sort`、`admin/job/*`、`admin/auth/*`、`admin/setting/get|set`、`admin/storage/get`、`admin/server/analysis` 均已在 `app/routes/admin-api.ts` 实现，写接口成功返回 `ok("explorer.success", 回插ID?)`。
  - `admin/setting/set` 前端参数名为 `data=<json>`，Worker 逐键 UPSERT 到 `settings` 表（key=value），`admin/setting/get` JSON 优先解析返回；`allParams` 同时合并 query 与 body 以兼容前端 GET/POST。
  - `admin/member/add` 密码 `salt==="1"` 时用 `parseKodPassword` 解密，否则按明文；`groupInfo` 接受 `{"groupID":"authID"}` 或 `{"groupID":{authID:xx}}`，缺失时 fallback `{"1": roleID||3}`；写 `user_groups` 前先 `DELETE WHERE user_id=?` 再重建，`authID` 空则写 0。
