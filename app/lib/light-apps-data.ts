/**
 * Built-in light apps - converted from 001 data/system/apps.php (initApp).
 * Mirrors 001 explorer/lightApp initApp() item structure:
 *   { name, group, desc, content: { type, value, icon, options: {width,height,simple,resize,openType} } }
 */
import type { LightAppItem } from "./db";

export const BUILTIN_LIGHT_APPS: LightAppItem[] = [
  { name: "哔哩哔哩", group: "movie", desc: "哔哩哔哩视频站", content: { type: "url", value: "https://www.bilibili.com/", icon: "https://static.hdslb.com/mobile/img/512.png", options:       { width: "140", height: "140", simple: 1, resize: 0, openType: "window" } } },
  { name: "飞书文档", group: "tools", desc: "在线协作", content: { type: "url", value: "https://docs.feishu.cn/", icon: "feishu.jpg", options:       { width: "90%", height: "80%", simple: 0, resize: 1, openType: "window" } } },
  { name: "ProcessOn", group: "tools", desc: "免费在线作图，实时协作", content: { type: "url", value: "https://processon.com/diagrams", icon: "on.png", options:       { width: "90%", height: "80%", simple: 0, resize: 1, openType: "window" } } },
  { name: "desmos", group: "tools", desc: "Desmos Calculus", content: { type: "url", value: "https://www.desmos.com/calculator/noanuckuli", icon: "desmos.png", options:       { width: "90%", height: "80%", simple: 0, resize: 1 } } },
  { name: "知乎", group: "tools", desc: "有问题,就会有答案", content: { type: "url", value: "https://www.zhihu.com/", icon: "zhihu.svg", options:       { width: "90%", height: "80%", simple: 0, resize: 1, openType: "window" } } },
  { name: "豆瓣", group: "tools", desc: "豆瓣", content: { type: "url", value: "https://www.douban.com/", icon: "douban.svg", options:       { width: "90%", height: "80%", simple: 0, resize: 1, openType: "window" } } },
  { name: "微博", group: "tools", desc: "微博", content: { type: "url", value: "https://weibo.com/", icon: "weibo.svg", options:       { width: "90%", height: "80%", simple: 0, resize: 1, openType: "window" } } },
  { name: "icloud", group: "others", desc: "icloud", content: { type: "url", value: "https://www.icloud.com/", icon: "icloud.png", options:       { width: "800", height: "600", simple: 0, resize: 1, openType: "window" } } },
  { name: "时钟", group: "tools", desc: "时钟挂件", content: { type: "url", value: "./?plugin/simpleClock", icon: "time.png", options:       { width: "140", height: "140", simple: 1, resize: 0 } } },
  { name: "快递查询", group: "tools", desc: "", content: { type: "url", value: "https://baidu.kuaidi100.com/index2.html", icon: "kuaidi.gif", options:       { width: "545", height: "420", simple: 0, resize: 1 } } },
  { name: "js在线压缩", group: "others", desc: "js在线压缩", content: { type: "url", value: "https://tool.lu/js/", icon: "js.png", options:       { width: "860", height: "620", simple: 0, resize: 1 } } },
  { name: "高德地图", group: "life", desc: "gaode map", content: { type: "url", value: "https://ditu.amap.com/", icon: "map.png", options:       { width: "800", height: "600", simple: 0, resize: 1 } } },
  { name: "Fruits Shooter", group: "game", desc: "Fruits Shooter", content: { type: "url", value: "https://g.vsane.com/game/842/", icon: "fruits.png", options:       { width: "400", height: "700", simple: 0, resize: 1 } } },
  { name: "小游戏集合", group: "game", desc: "vsane", content: { type: "url", value: "https://m.vsane.com/", icon: "games.jpg", options:       { width: "400", height: "700", simple: 0, resize: 1 } } },
  { name: "有道词典", group: "tools", desc: "", content: { type: "url", value: "http://dict.youdao.com/app/baidu", icon: "youdao.jpg", options:       { width: "548", height: "490", simple: 0, resize: 1 } } },
  { name: "迅捷文档转换", group: "tools", desc: "各类文件格式转换", content: { type: "url", value: "https://app.xunjiepdf.com/", icon: "xunjie.png", options:       { width: "90%", height: "80%", simple: 0, resize: 1 } } },
  { name: "OfficeConverter", group: "tools", desc: "免费在线文件转换器", content: { type: "url", value: "https://cn.office-converter.com/", icon: "officeconvert.png", options:       { width: "90%", height: "80%", simple: 0, resize: 1 } } },
  { name: "百度脑图", group: "tools", desc: "在线思维导图", content: { type: "url", value: "https://naotu.baidu.com/", icon: "naotu.png", options:       { width: "80%", height: "80%", simple: 0, resize: 1, openType: "window" } } },
  { name: "QQ音乐", group: "music", desc: "", content: { type: "url", value: "https://y.qq.com/", icon: "qqmusic.svg", options:       { width: "800", height: "600", simple: 0, resize: 1, openType: "window" } } },
  { name: "网易云音乐", group: "music", desc: "", content: { type: "url", value: "https://music.163.com/#/my/", icon: "wangyi.jpg", options:       { width: "800", height: "600", simple: 0, resize: 1, openType: "window" } } },
  { name: "创可贴", group: "tools", desc: "免费的在线设计工具", content: { type: "url", value: "https://www.chuangkit.com/startdesign", icon: "chuangketie.png", options:       { width: "90%", height: "80%", simple: 0, resize: 1, openType: "window" } } },
  { name: "trello", group: "tools", desc: "项目管理云平台", content: { type: "url", value: "https://trello.com/", icon: "trello.png", options:       { width: "800", height: "600", simple: 0, resize: 1, openType: "window" } } },
  { name: "即时工具", group: "tools", desc: "常用在线工具库", content: { type: "url", value: "https://www.67tool.com/rank/hot", icon: "https://www.67tool.com/favicon.ico", options:       { width: "90%", height: "80%", simple: 0, resize: 1, openType: "window" } } },
  { name: "石墨文档", group: "tools", desc: "shimo", content: { type: "url", value: "https://shimo.im/desktop", icon: "shimo.png", options:       { width: "90%", height: "80%", simple: 0, resize: 1, openType: "window" } } },
];
