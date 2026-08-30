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
  - dev/ 与 orig/ 目录比备份文件还重要，绝不可轻易改动。
  - 只允许改动 static/app/dist/ 根目录的文件：替换时从 dev/ 或 orig/ 复制到 dist 根目录。
  - dist 根目录文件「该用 dev 版还是 orig 版」由用户决定（只有用户知道哪些文件好坏），Agent 不得自行判断好坏、不得擅自替换任何 dist 根目录文件，必须等用户明确指示。

[Project Knowledge Summary]
- Date: 2026-08-15
- Context: Discovered by Agent while performing fav(收藏夹)功能本地冒烟测试
- Category: Build Methods
- Instructions:
  - 本地 dev 必须先用 `npm run build` 生成 dist 产物，再执行 `npm run dev`（即 `wrangler dev`）。此时 wrangler 读取 `dist/ssr/wrangler.json` 并自动绑定本地 D1/R2/ASSETS 环境，API 才能正常响应。
  - 缺少根目录 `wrangler.jsonc` 时 `npm run build` 只生成 dist/client（无 ssr worker bundle），wrangler dev 会 404；必须先 `cp wrangler.jsonc.example wrangler.jsonc` 再 build。
  - 本地 dev 时 ASSETS 绑定指向 `dist/client`，`static/` 源目录内容必须通过 `vite.config.ts` 的 `publicDir: "static"` 复制进 dist/client，否则前端与插件静态资源全部 404（线上部署用 wrangler.jsonc.example 的 assets.directory=./static，与本地机制不同）。
  - build 生成的 `dist/ssr/wrangler.json` 会自动继承根 `wrangler.jsonc` 的 `compatibility_flags`（含 `nodejs_compat`），重新 build 后无需手动 patch；此前 build 丢失 flag 是改 wrangler.jsonc 之前的旧产物所致。
  - 后端返回的每个文件列表项 `type` 字段必须保持 001 语义的 `"file"`/`"folder"` 二值（普通文件 `"file"`），不得填扩展名类别；前端大量逻辑（右键菜单类型、路径处理等）依赖 `type == "file"` 判断，填类别会导致文件被当作文件夹处理（如右键无"打开为"）。扩展名类别如需保留，用单独字段（如 `typeCat`）承载。
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
- Date: 2026-08-22
- Context: 用户明确推送范围（覆盖 2026-08-15 的双仓库约定）
- Instructions:
  - 每次 `git push` 只推送到 GitHub（https://github.com/zorynith/MinelibsBox），不再推送 Gitee。
  - origin 的 push 地址只有 GitHub 一个，不要添加 gitee.com/minelibs/mbesbox 作为 push 目标。
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
   - 本地 D1 状态早于 schema 扩展时，需手工 `ALTER TABLE` 补列；CI 部署仅应用 migration（D1 重置已移除，2026-08-26），线上靠 `initDatabase()` 自动建表（CREATE TABLE IF NOT EXISTS）。

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
   - 部署触发链：GitHub Actions `deploy.yml` 在 push 到 main 分支时自动 build + D1 迁移 + `wrangler deploy` 到 Cloudflare Worker；功能分支改动必须合并到 main 并 push 才会生效，仅 push 功能分支不会触发线上更新。CI 部署的 D1 重置步骤已于 2026-08-26 移除，线上数据保留、admin/admin123 密码不再每次重置。
  - 登录后「密码强度不足」提示是 001 预期行为：登录成功走 `passwordCheckTips`，admin123 不满足 `passwordRule:strongMore` 规则（需大小写+数字），弹窗确定后 `Router.go("setting/user/account")` 跳转账号设置页并自动聚焦改密框；该弹窗与账号设置页空白无因果关系。
  - R2 免费版额度有限，需防目录自嵌套导致对象指数膨胀：paste/cut 目录到自身子树（如 A 粘贴到 A/B 下）时前端无防护，后端 `/paste` 必须检查 `destKey.startsWith(srcKey+"/")` 并拒绝；`/rename` 同样需拒绝 `newName` 为空/含 `/`/newKey 在 oldKey 子树内。错误码用 001 现成 `explorer.moveSubPathError`（父目录不能移动到子目录）与 `common.invalidParam`。
  - `deleteDirectory`（r2.ts）默认 `maxObjects=100000, maxRounds=1000` 保护，防止活锁/并发写入时游标追着新对象无限删；正常删除大目录不受影响。
   - R2 mkdir 用 `.keep` 占位文件表示空目录，`listDirectory` 的 folders 从 `delimitedPrefixes` 解析；测试时若把 mkdir 的 `path` 与 `name` 合并传入会生成 `undefined` 名称脏对象。
   - R2 中除 `.keep` 占位外，导入/迁移还可能产生 `{dir}/` 空对象占位（key 以 `/` 结尾、size 0，如 `admin/发布目录/`）。凡遍历 R2 全部对象（`listAllFiles`）再按名归类的接口（`listFilesByType`）必须跳过 `o.key.endsWith("/")`，否则文件夹被当文件：name 带尾斜杠、`kodFileType` 判为 others 落入「其他」分类，点击走文件编辑器打开失败。
   - 个人标签的 `filesAddToTag`/`filesRemoveFromTag`：前端（main.js `tagChangeRequest`）在项有 `sourceID` 时传的是 **sourceID**（= path 的 FNV-1a hash，`fileSourceID` 不可逆），只有无 sourceID 时才传 path。后端必须遍历用户 R2 按 hash 反查真实 path（`mapSourceIDToPaths`）再读写 `user_tag_source.path`，否则把 hash 当 path 存 → 标签列表显示一串数字（如 `2184162075`），点击报 `common.pathNotExists`。读取（`listTagSourcesData`）需对纯数字 path 做反查以兼容历史脏数据；删除时同时按真实 path 与原始 sourceID 删除。

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
  - 虚拟路径拼写易错点：`{shareToMe}`（非 {userShareToMe}）、`{userRencent}`（非 {userRecent}）；分享落地页前缀枚举 KOD_SHARE_LINK 必须为 `{shareItemLink}`（分享目录→点文件报「此类型目录不支持操作」、右键菜单空的根因），KOD_SHARE_ITEM=`{shareItem}`、KOD_SHARE_OUTER=`{shareOuter}`，后端 user-api.ts 的 options.io 与前端落地页生成路径必须一致。
  - 分享项 `{shareItem:<id>}` 的列表/目录 pathDisplay 严禁用 `{shareItem:<id>}/...` 字面量：前端 pathInfoParse 的 f(e)（KOD_SHARE_ITEM case）用 pathDisplay 各段名做面包屑 name，字面量会导致面包屑显示 `我的协作>{shareItem:10}`；正确做法是 `pathDisplay = path.replace(/^\{shareItem:\d+\}/, share.title)`（用分享标题替换虚拟段，段数不变即兼容 f/p 两函数）。
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

[Project Knowledge Summary]
- Date: 2026-08-21
- Context: Discovered by Agent while performing 新建普通用户后桌面「我的电脑/回收站/我的相册/轻应用/使用帮助」点击报无权限/不支持/无写权限排查
- Category: Troubleshooting & Debugging
- Instructions:
  - `G.user.role`（user/view/options 注入）契约是扁平 `{权限点: 0|1}` 对象：前端 `allow(e)=G.user.isRoot==1 || !!G.user.role[e]==1`、`adminAuth/initAuth` 直接按 key 取。严禁把嵌套 `{info, allowAction, roleList}` 塞给前端（全 undefined → 一切操作判失败）。权限点来源：普通用户 `user_groups.authID` → `roles.auth`（逗号分隔权限点），admin 固定角色 1；缺省权限点必须补 0。
  - 前端 `parseSourceAuth`（KOD_SOURCE/{source:home} 权限）对非 root 用户要求 item 满足 `targetType=="user" && targetID==G.user.userID`，否则返回空 auth（「没有权限」）。explorer list 的 current/folderItem/fileItem/emptyListData/fav 项必须带 `targetType:"user"`、`targetID: user.id`（fileItem/folderItem 需透传 userID 参数）；回收站/相册走 pathAuthList 不依赖 targetType。
  - 前端 `authCheck` 是无条件 `e!="unzip"` 的 stub；`parsePathAuth` 返回 `{auth, errorMsg, sourceInfo}`，errorMsg 仅在 auth 为空时弹「无权限/不支持」提示。

[Project Knowledge Summary]
- Date: 2026-08-22
- Context: Discovered by Agent while performing 后台 job/auth/analysis 实现与本地验证
- Category: Testing Methods
- Instructions:
  - 本地 D1 查改：`npx wrangler d1 execute minelibsbox --local --command "SQL"`（用 database 名 `minelibsbox`，非 binding `local-dev`）。
  - 本地 R2 对象核验：`npx wrangler r2 object get "minelibsbox-files/{key}" --local`；或读 `.wrangler/state/v3/r2/miniflare-R2BucketObject/*.sqlite`（python3 sqlite3 查 `_mf_objects.key`）。
  - curl 测试登录：`curl -c <cookie> -X POST /api/user/index/loginSubmit -d "name=admin&password=admin123"`（明文即可，不带 salt）；`-c` 会整体覆盖 cookie 文件，多用户并发测试必须用独立 cookie 文件（-c/-b 指向不同路径），否则后登录覆盖前 session，后续请求全以最后登录用户身份。
  - 上传测试文件到指定用户空间：`curl -b cookie -X POST /api/explorer/upload/fileUpload -F "path={source:home}/桌面/" -F "name=x.txt" -F "size=N" -F "chunks=1" -F "chunk=0" -F "file=@f"`。
  - curl 测 GET/query 里含 `{source:home}`/`{userRecycle}` 等虚拟路径必须 URL 编码花括号（`%7B...%7D`），否则服务器端收到丢 `{}` 的路径被当 real 路径解析；POST 表单体（dataArr 等 JSON）无需编码。回收站/压缩验证用 `pathDelete`（无 shiftDelete 进回收站）、`recycleRestore`/`recycleDelete`、`index/zip`/`index/unzip`/`index/unzipList`/`index/zipDownload`（经 share/fileDownloadRemove 下载并自删临时 zip）。
  - 001 新用户默认初始化三件套（settingDefault 32 项 user_option + folderDefault 我的文档/图片/音乐 + lightAppDefault 桌面高德地图/icloud.oexe）在 `app/lib/user-init.ts`，member/add 与 regist 创建用户后调用。

[Project Knowledge Summary]
- Date: 2026-08-23
- Context: Discovered by Agent while performing 轻应用/插件管理系统上线验证
- Category: Operations & Deployment / Troubleshooting & Debugging
- Instructions:
   - deploy.yml 曾含 Reset D1 步骤（硬编码 TABLES 列表，2026-08-26 已整体移除），移除后所有表数据跨部署持久保留，不再清空。
  - seedLightAppsIfEmpty 首次冷启动时顺序 INSERT 24 个内置轻应用，实际可能中途中断只落库前 17 个且接口仍返回 200（无报错）；表非空后 seed 不再执行。规避：线上通过 explorer/lightApp/add 手动补齐缺失项（内置项 sort 会排末尾，可接受）。插件状态/轻应用数据因表持久，补齐后不再复发。
  - user/view/pluginDesc 是 JSONP 接口：必须带 `callback` 参数，返回 `callback("<base64>")`，base64 内容为 `# 插件名\n\n插件描述`（描述来自 plugins/{app}/lang 的 `${app}.meta.desc` 或 package.json description）；无 callback 时返回 `("...")` 无法按 JSON 解析。测试该类接口需带 callback 并用正则提取 base64。

[Project Knowledge Summary]
- Date: 2026-08-23
- Context: Discovered by Agent while performing S3 外链存储数据面实现与本地验证
- Category: Testing Methods / Troubleshooting & Debugging
- Instructions:
  - 本地验证 S3 数据面（{io:N} 挂载的 list/upload/rename/delete）需起 mock S3：`node /tmp/opencode/mock-s3.js`（node http 监听 :9123，模拟 list-objects-v2/head/get/put/delete/copy），io_source 的 config.endpoint 配 `http://localhost:9123`（buildS3Config 支持 http:// 前缀，生产 S3 用 https）。mock 存于内存，重启即清空。
  - workerd dev 对无效域名（如 test.example.invalid）fetch 抛 `jsgInternalError`（DNS lookup failed）会绕过 JS try/catch 直接 500 返回 `internal error; reference=...`；本地必须用真实可达的 mock 端点测试，无法用假域名验证 S3 链路。
  - `keyFromBase` 对空 baseKey 不得加前导斜杠（外链存储 basePath 为空时 key 若变 `/x`，uriPath 会拼出 `//bucket/` 双斜杠导致 S3 请求 404/UNHANDLED）。
  - S3 mkdir 用 `fullPath/` 占位对象（delimiter 列表以 CommonPrefix 呈现为空目录），与 R2 的 `.keep` 占位不同；S3 目录 key 必须保留尾斜杠，否则被当成文件列出。

[Project Knowledge Summary]
- Date: 2026-08-23
- Context: Discovered by Agent while performing 修复空间显示 0B/不限制 与系统R2存储纳入挂载
- Category: Troubleshooting & Debugging / Operations & Deployment
- Instructions:
  - 前端空间条显示"0B/不限制"的根因是 `G.user.targetSpace`（user/view/options 注入）为 `{sizeMax:0,sizeUse:0}`；左侧树空间条（bindUserSpace）只读该注入值，与 explorer list 响应的 current.driverSpace/targetSpace 无关。修复须在 user/view/options 用默认存储配额+用户已用注入（getDefaultIoSource().size_max + R2 前缀扫描，带 TTL 缓存），目录面板右上的空间条才走 list 的 current.driverSpace。
  - 系统内置存储（io_source.system=1, driver=minio）"参考 S3 改进 R2"的落地：resolveIoSource 放行 system=1 让 `{io:1}` 可浏览（走 worker 原生 R2 API，s3ConfigOf 对 system=1 返回 null）；非 admin 禁止访问（noPermission），blockDriver 仅 admin 可见系统存储，防止普通用户绕开个人空间前缀。系统存储 basePath 为空 → baseKey=""。
  - `listDirectory`（app/lib/r2.ts）对空 baseKey（存储根）时 `keyFromBase` 返回空串，若补成 `/` 前缀会导致与无前导斜杠的写入 key（如 `testdir2/.keep`）不匹配，目录列不出；空 baseKey 必须保持 prefix=""。
  - explorer list 对 io 源 targetSpace 的 sizeUse：系统 R2 走 sourceUsedSize（R2 扫描），外链 S3 走 s3ListAll 统计（s3SizeCache，key 以 `:baseKey` 结尾）；写操作后统一用 `invalidateSpaceUsageByBase(baseKey)` 同时失效 R2 sizeCache 与 s3SizeCache（R2 的 sizeCache 只按 baseKey 索引，失效 S3 需遍历 s3SizeCache 匹配后缀）。

[Project Knowledge Summary]
- Date: 2026-08-24
- Context: Discovered by Agent while performing explorer/shareOut 与 explorer/seo 匿名接口复刻
- Category: Troubleshooting & Debugging
- Instructions:
  - Hono 多个子 app 挂同一前缀（api.ts 中 route("/explorer", shareApi/publishApi/explorerApi/tagGroupApi) 并存）时，各子 app 的 `use("*")` 中间件相互干扰，新增匿名路由挂 `/explorer/xxx` 会被先注册子 app 的 `use("*", authRequired)` 前缀传播拦截（即使在本 app 中间件里做路径放行也不可靠）。匿名/站间接口必须挂独立前缀：seo→`/seo`、shareOut→`/shareOut`，并在 workers/app.ts 直连段白名单数组加入该前缀。
  - shareOut 站间联合分享的 `{source}` 站点探测 URL 为 `{siteFrom}/index.php?shareOut/sendCheckAllow`（GET），对应 worker 路由必须注册 `all` 而非 `post`，否则站间探测 404。
  - worker share 表建表时严禁给 userID 设外键：001 用 userID=0 表示系统级站间协作分享，FK 会导致 shareMake 插入报 `FOREIGN KEY constraint failed`。
  - Mcrypt 签名（001 站间密钥交换）worker 端用"明文+HMAC-SHA256"自洽方案：encode(data,key,expireSec)=b64url(payload|hmac)，payload 带过期时间戳时格式 `data\n ts\n expire`；decode 校验 hmac 与过期。仅 worker↔worker 可互操作，不与 PHP Mcrypt 兼容。

[User Instruction Summary]
- Date: 2026-08-24
- Context: 用户因功能分支未触发线上部署（CI deploy.yml 仅监听 main/master push）而不满，明确要求"以后不可以再有这样的情况"
- Instructions:
  - 所有代码改动一律直接提交到 `main` 分支并 push，**严禁擅自创建功能分支**（即使遵守了某些仓库规范）。
  - push 到 main 后必须主动确认 GitHub Actions 部署已触发并检查结果，确保改动真正上线。
  - 仅当用户明确要求创建分支时才创建；不得自行判断或套用外部分支规范。
   - 线上部署的 D1 重置已移除（2026-08-26），数据持久保留；部署仅应用 migration，新表由 worker 冷启动时 initDatabase() 自动建立。
   - admin 密码/设置"变回默认"排查：后端 initDatabase/seed/migrations 全幂等（INSERT OR IGNORE / CREATE TABLE IF NOT EXISTS），无任何自动重置逻辑；唯一能把 admin 重置为 admin123 的路径是 admin 用户被删除后 seed 重建。`admin/member/remove` 曾只排除 id=1，admin 若 id≠1 可被误删（重建后密码变回 admin123、user_option 因新 id 失效）——已加固为禁止删除 role in ('admin','root') 的用户。线上改密/重置记录在 `audit_logs`（action=user.setUserInfo / user.findPassword / admin edit user），可据此核对时间线。

[Project Knowledge Summary]
- Date: 2026-08-25
- Context: Discovered by Agent while performing 复刻 5 个 kodbox 插件 (CADViewer/drawio/Photopea/bisheng/PDFTron)
- Category: Troubleshooting & Debugging / Testing Methods
- Instructions:
  - plugin-api 的通用匿名文件流端点 (act===fileOut, streamFileByToken) 必须放在 pluginHandler 最前（所有插件 render 分支之前）分发，否则 fileViewLinkOut 生成的 fileOut URL 会被 CADViewer/drawio/Photopea/bisheng/PDFTron 各自的 render 分支拦截而返回错误页。
  - curl 用 sendAsBinary 模式上传测试文件（/api/explorer/upload/fileUpload）时，必须显式 `-H "Content-Type: application/octet-stream"`：`--data-binary` 默认 Content-Type 为 application/x-www-form-urlencoded，会走 parseBody 分支导致 "No file"。
  - 分享单文件的外链落地 path 是 `{shareItemLink:hash}`（不含文件名后缀），shareFileKeyOf/parseShareLinkRel 按此解析；带后缀的 path 会被 joinShareRealPath 拼成错误的 `/test.docx/test.docx`。
  - drawio 复刻：001 template.php 的 `$content` 由 app.php 定义为文件原文（`file_get_contents(filePathLinkOut)`），worker 端 edit() 传 JSON.stringify(文件文本) 加载已有图表，newfile 由内容是否含 `<diagram>` 决定；模板中 001 的 `$.ajax`（依赖 app/dist/lib.js 的 jQuery）在独立 iframe 页面不可用，worker 版 template.html 用原生 fetch 替换。
  - HMAC-MD5（PHP hash_hmac('md5')，bisheng callURL 签名）worker 端实现：mcrypt.ts 的 md5 已重构出 md5Core(bytes) 支持字节输入，新增导出 hmacMd5(key,msg)；WebCrypto 不支持 MD5，必须用纯 JS。

[User Instruction Summary]
- Date: 2026-08-25
- Context: 用户因 getStaticHost 曾被改成返回 "/"（worker 根/ASSETS 加载静态资源）导致线上全部静态资源 404、图标全变文件夹、大量功能无法打开而明确重申
- Instructions:
  - 主站（Cloudflare Worker）绝对不能存/加载静态文件，静态资源一律全部托管在 GitHub Pages（https://static.minelibs.eu.org/），`getStaticHost` 必须始终返回 STATIC_HOST 域名，严禁改成返回 "/" 或走 worker ASSETS。
  - 任何时候都不允许把插件静态资源、前端 CSS/JS、图标等改为主站同源加载；这类改动会因 Worker 静态资源不全导致全站损坏。
  - 跨域问题（如插件 WebViewer iframe 在静态域发起数据请求）必须用「带签名 token 的匿名文件流 URL / CORS」等数据面方案解决，不得靠改静态资源归属解决。

[Project Knowledge Summary]
- Date: 2026-08-25
- Context: Discovered by Agent while performing 修复 PDFTron 预览语言始终英文（WebViewer 渲染页 cloud 域与 UI static 域跨域）
- Category: Troubleshooting & Debugging
- Instructions:
  - WebViewer 渲染页（cloud 域）加载的库从 static 域拉取时 UI iframe 位于不同域名，WebViewer() 的 promise 会被 reject（console 报 "Viewer is on a different domain...cross domain permissions"），`.then(instance => ...)` 永远不执行 → `instance.setLanguage()` 等 API 从未调用 → UI 保持英文。服务端渲染页即使输出 `setLanguage("zh_cn")` 也无效。
  - 官方跨域方案（见 docs.apryse.com/web/guides/remote-lib 与 config-files）：WebViewer `config` 选项指向一个 JS 文件，该文件在 UI iframe 上下文内执行，可用 `readerControl` 全 API（setLanguage/setTheme/disableElements/setHeaderItems 等）。加载链路：UI 发 requestConfig → 主库回 responseConfig（config URL）→ UI 用 script 标签加载执行；若主库（app）与 UI 跨域，必须把 app origin 写进 `lib/ui/configorigin.txt`（每行一个，支持通配符），否则 UI 拒绝加载并 console.warn。
  - 数据传递：WebViewer `custom` 选项（字符串）经 `_getHTML5OptionsURL` 拼进 UI iframe URL `&custom=`，config 内用 `readerControl.getCustomData()` 读取；适合把 lang/theme/权限/saveUrl 等按用户动态生成的 JSON 传进去。
  - 实施要点：config.js 是静态文件必须放 GitHub Pages（与 UI 同域，script 加载无 CORS）；template.html 不再在 `.then()` 里调 API（跨域不执行），改为 `WebViewer({..., config:"<static>/.../config.js", custom: JSON.stringify({...})}).catch(()=>{})`；config 里用"readerControl 已就绪直接执行 + viewerLoaded 监听 + 500ms 轮询兜底"三重保障处理时序竞态。
  - 无头浏览器验证 PDFTron 语言：全局 playwright（NODE_PATH=/usr/local/lib/node_modules）加载线上渲染页（先 form 登录 admin/admin123，loginSubmit 要求 form 编码而非 JSON），进 iframe 查 `window.readerControl.i18n.language`；服务端 detectLang 按 Accept-Language（=playwright locale），中文用户场景用 `newContext({locale:'zh-CN'})`，无语言 cookie + D1 重置后语言由 Accept-Language 决定。

[Project Knowledge Summary]
- Date: 2026-08-25
- Context: Discovered by Agent while performing 多云存储驱动适配层（S3兼容系+七牛+又拍云）实现与端到端验证
- Category: Testing Methods / Troubleshooting & Debugging
- Instructions:
  - 驱动全集契约（app/lib/io.ts ioDriverKind）：S3 兼容系 13 个（s3/oss/cos/obs/oos/jos/minio/eos/eds/moss/nos），前端表单字段统一 `accessKey/secret/bucket/domain(即endpoint)/basePath/ioUploadServer/ioFileOutServer`；qiniu 加 `signVer`（region z0/z1/z2/na0/as0，管理API走 rs.qiniu.com，上传 upload.qiniup.com 按 region 分端）；uss 为 `bucket/username/userpass/domain/token`，管理 API api.upyun.com + 新版 HMAC-SHA1 签名（见下条）；ftp/webdav 因 Worker 无出站 TCP 直接拦截提示（FTP_UNSUPPORTED_MSG）；baidu/onedrive 不在前端存储表单驱动列表内不处理。ioGroupType 分组 loc/obj/net/oth。
  - 端到端验证链（本地 dev :8799）：POST form-urlencoded 登录 → `admin/storage/add`（config 为 JSON 字符串，直接存前端表单字段原名，domain 即 endpoint）→ `{io:N}` 浏览/mkdir/上传/下载/rename/delete → `admin/storage/get` 的 sizeUse/fileNum 走 ioClientFromConfig+listAll 实时统计。mock S3（node /tmp/opencode/mock-s3.js :9123）验证全链路。
  - 前端存储表单无头验证要点：驱动下拉是 select2 隐藏控件（原生 select aria-hidden），须点击 `.store-type-box .select2-container .select2-selection` 展开再点 `.select2-results__option`（jQuery .val().trigger('change') 不触发 formBanner onChange，字段不渲染）；保存用 `.form-save-button`（DOM click 即可，POST 发 admin/storage/add）；前端保存后 driver 存驼峰（oss→Oss），后端统计按小写匹配需兼容。
  - 七牛签名规范（401/404 根因，2026-08-26 官方 SDK 逐行对齐确认）：新版默认 **Qiniu 时间戳签名**，sign = b64url(hmac_sha1(SK, `"<METHOD> <path?query>\nHost: <host>\nContent-Type: <ct>\nX-Qiniu-Date: <date>\n\n"`))，Authorization 头 `Qiniu AK:sign` 并带 `X-Qiniu-Date` 头；签名 base64 **必须保留 `=` padding**（只有 URL 里才可去 padding）。旧版 QBox 签名串 = `path?query+\n`（**含 query**）可作参考但官方 SDK 默认已不用。管理/列举端点域名是 **qbox.me 后缀**（华东 rs/rsf.qbox.me、华北 rs-z1/rsf-z1、华南 -z2、北美 -na0、新加坡 -as0），**不是 qiniu.com**；**列举走 RSF 服务（rsf-*），stat/delete/copy 走 RS 服务（rs-*），host 不同**，bucket 区域不符返回 401/631。上传凭证 sign = b64url(hmac(SK, putPolicy_b64)) 无换行且保留 padding。排查方法：pip 装官方 qiniu SDK 用同 AK/SK 跑 bucket.list，通则凭证有效、问题在实现细节。
  - 又拍云 uss 签名规范（2026-08-26 对齐官方 upyun npm SDK）：新版签名 sign = **base64(hmac_sha1(操作员密码, `<METHOD>&<uri>&<date>`))**，Authorization 头 `UPYUN <操作员名>:<sign>` + `X-Date` 头（GMT 字符串，值=签名里的 date）；**不含 content_type/content_md5**（GET/PUT 都不参与）。uri 用**未编码原始路径**（形如 `/bucket/dir/文件名.txt`），请求 URL 再 percent-encode，服务端按解码后 URI 校验。字符串按 `charCodeAt&0xFF`（latin1）处理而非 UTF-8——签名算法已原样移植到 app/lib/hmac-sha1.ts（b64HmacSha1，与官方 hmacsha1 包逐字节一致，含中文路径全部 MATCH）。旧式 MD5 链 `md5(pwdMd5&uri&method&contentMd5&contentType&date)` 已弃用；若误用会 401。下载走用户 domain 或 `{bucket}.b0.upaiyun.com`（公开直链）。

[Project Knowledge Summary]
- Date: 2026-08-26
- Context: Discovered by Agent while performing 修复 io 外链存储(zip/文档阅读器/编辑)功能缺失
- Category: Workflow & Collaboration / Architecture
- Instructions:
  - explorer-api 中所有对文件对象的操作(读/写/head/list/delete)必须同时具备 R2 与 io 两条分支: 用 `ioClientOf(src.source)`(别名 externalIoOf) 判断, io 非空走 io 接口, 否则走 c.env.FILES。任何新增 R2-only 的 explorer 操作都会导致 {io:N} 挂载(七牛/又拍/S3)功能报错。
  - 已抽统一 helper(explorer-api.ts 顶部): readObjectBytes(c,src,relPath)/writeObject(c,src,relPath,body,ct)/headObject(c,src,relPath)/uniqueNameInDirSrc(c,src,dir,name), 新增 io 读写一律复用, 不要手写 R2 分支。
  - 虚拟路径 {io:N}/xxx 或 {source:home}/xxx 必须保留前缀传给 resolveFileSource; 严禁先用 toRealPath/normDirPath 剥掉前缀再解析(会把目标目录解析到个人 R2 空间)。仅 baseKey 拼接相对路径时才用 toRealPath。
  - io 目录占位对象(dir/, mkdir 创建)在列出该目录自身时会被 io.list 当作子项返回, 须按 f.key===prefix 过滤(explorer-api /list/path io 分支)。
   - zip/unzipList/zipDownload/zip/unzip 与 editor/fileGet|fileSave、index/fileSave、fileView/index、fav/get 历史上均为 R2-only, 已全部修复(2026-08-26, commit 4b5e48b); 分享(share-api)对 io 挂载文件的分享仍未支持, 属已知缺口。

[Project Knowledge Summary]
- Date: 2026-08-26
- Context: Discovered by Agent while performing 修复删除/清空回收站报"参数错误"、长任务 abort 后"操作失败"误报排查
- Category: Troubleshooting & Debugging / Operations & Deployment
- Instructions:
  - 前端长任务机制：所有写操作(rename/pathPast/pathCuteTo/pathCopyTo/pathDelete/recycleDelete/recycleRestore/zip/unzipList/unzip/zipDownload 共 11 个)经 pathModel 包装，参数自动加 `longTaskID=<操作>_<md5>`，请求发出 500ms 后 xhr.abort()，随后轮询 `user/setting/taskAction?action=get&id=<longTaskID>`（5 秒窗口内重试，超时只显示"操作失败"）。后端契约：接口带 longTaskID 时必须把结果写入跨请求共享缓存；taskAction 命中缓存返回 `{code:true,data:结果,info:"task_finished"}`（未命中返回 taskEmpty 且前端不替换已显示的错误）。回收站清空/还原全量操作发 `{all:1}`（无 dataArr），后端 recycleDelete/recycleRestore 必须支持 all=1 分支，否则报"参数错误"。
  - **Cloudflare Workers 多 isolate 下模块级内存 Map 跨请求不共享**：内存缓存把 pathDelete（写）与 taskAction（轮询）常分到不同 isolate → 永远 miss → 误报"操作失败"。跨请求状态一律必须落 D1 持久化，不能存模块级内存。修复：`app/lib/task-result-cache.ts` 的 `taskResultSet(db,id,value,ttlSec=300)`(INSERT ON CONFLICT DO UPDATE) 与 `taskResultGet(db,id)`（读取即删、读时清过期），explorer-api 11 个 emit 点、user-api taskActionHandler、share 页 user/view/taskAction 共用此缓存。
  - 本地 wrangler dev 是单 isolate，内存缓存测试全会通过，会掩盖跨 isolate bug；涉及跨请求缓存/状态的机制必须线上验证（实测法：curl pathDelete 一个不存在文件触发长任务 + taskAction 轮询，看是否 task_finished 而非 taskEmpty）。
  - D1 表结构变更（新增表/列）必须同步加 `migrations/000x_*.sql` 并在 `initDatabase()` 建表（CREATE TABLE IF NOT EXISTS），本地 dev 已有旧 schema 时需手工 ALTER 补列。
  - D1 单值写入有大小上限，超大结果（如巨大 zip 的 unzipList 列表）写 task_result 会被拒导致 abort 后 miss；此类结果需控制体积或跳过缓存，不能无界直写。
