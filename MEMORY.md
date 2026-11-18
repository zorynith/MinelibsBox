# MEMORY.md

插件物料的获取与落地方法（可道云 / KodBox 生态），供后续复刻复用。

## 1. 官方 API 基址

- `https://api.kodcloud.com/?`
- 来源：`001/config/setting.php:56`，注释写明「QQ微信登录/邮件发送/插件-列表等」
- 响应统一信封：`{ code, timeUse, timeNow, data }`

## 2. 获取插件列表

**状态：接口路径未完全确证。**

- 实测 `GET/POST https://api.kodcloud.com/?pluginV5/list` 均返回 `404 not found` HTML。
- 之前拿到的 `/tmp/pluginlist.json` 就是该 API 家族的响应（同为 `code/timeUse/timeNow/data` 信封），共 111 个插件，字段结构：

```
id, name, title, version, category, description, keywords, auther,
source{className|icon}, hidden, menu,
server{ version, versionTime, price, network, downloadCount,
        commentCount, userScore, sort, size }
```

**筛选口径（已用过的组合）：**

| 条件 | 含义 |
|---|---|
| `server.price === 0` | 免费 |
| `hidden === 1` | 内部/不展示（当时 55 个） |
| `category` 含 `buy` | 收费（当时 15 个） |
| `category` 含 `oem` | 客户定制（当时 26 个） |

**可靠获取途径：** 登录真实 kodbox → 后台「插件中心」→ 浏览器 DevTools → Network 抓列表请求（该接口不在 001 源码里，由官方前端直接调用）。抓到后按上表筛选即可。

## 3. 获取单个插件的下载地址（已实测）

```
POST https://api.kodcloud.com/?pluginV5/install
```

参数（`001/app/controller/admin/plugin.class.php:164-183`）：

| 参数 | 取值 |
|---|---|
| `app` | 插件 id，如 `flashPlayer` |
| `version` | 当前 kodbox 版本号 |
| `versionHash` | 实例授权版本哈希 |
| `code` | 授权码（versionUser） |
| `deviceUUID` | 设备唯一标识 |
| `systemOS` / `phpVersion` / `channel` / `lang` | 环境信息 |

返回的 `data` 是一段 JSON 字符串，内含下载地址，交给 `Downloader::start()` 使用。

实测行为：缺参报 `data: "param error!"`；参数为假值报 `data: "该插件与您的版本不兼容,\n请先将kodbox升级到最新版再试!"` —— 说明服务端会校验 `versionHash`/`code`，**没有真实授权拿不到下载地址**。

## 4. 官方安装流程（001 实现）

`check → download → fileSize → unzip → remove`

- 临时包：`<pluginDir>/<app>.zip`（下载中为 `.zip.downloading`）
- 解压到：`<pluginDir>/<app>/`
- 主程序升级走的是另一条固定地址：`http://static.kodcloud.com/update/update/<文件名>`

## 5. 本仓库的落地方式（无授权时的替代路径）

拿不到官方下载权限时，按「复刻」处理，不依赖 zip 里的 `app.php`：

1. 静态资源放 `static/plugins/<id>/`，至少包含 `package.json` + `static/main.js`
2. 注册到 `app/lib/plugins.ts` 的 `ALL_PLUGINS` 数组（未配置的插件 `getPluginMeta` 默认 `status=1`，即默认启用）
3. 语言包放 `static/plugins/i18n/<id>.zh-CN.json` / `.en.json`，key 形如 `<id>.meta.name`
4. 入口约定：`main.js` 在 `explorer.kodApp.before` 里 push `{name,title,ext,sort,icon,callback}`，`callback` 内用 `requireAsync(pluginHost+'page.js?v=版本')` 载入播放/预览页
5. 依赖外部服务的页面（如 OnlyOffice 的 Document Server）需在 `configItem` 里暴露地址项，不要硬编码
6. 构建：`npm run build` 会生成 `static/plugins/__assets__.json`（**该文件被 `.gitignore` 忽略**，CI 必须跑 build，否则运行时只能逐个 fetch 回退）

## 6. 注意事项

- 不要把 `versionHash` / `code` / `deviceUUID` 等授权值写进仓库或文档。
- 官方 zip 解压后目录结构不等于可用：后端逻辑（`app.php`）需改写为 Workers 路由，`static` 才能直接复用。
- `package.json` 允许注释与尾逗号（服务端用 `parseLooseJson` 解析），但手写时建议保持合法 JSON。
- `/tmp` 会被环境清理：抓到 `pluginlist.json`、解压的插件包应立刻转存到仓库或工作目录。
