/**
 * 角色权限点配置 - 镜像 001 config/setting.php 的 authRoleAction/authAllowAction/authRoleActionKeepTrue。
 */

/** 角色权限点 -> { 控制器: "action1,action2" } 映射。 */
export const AUTH_ROLE_ACTION: Record<string, Record<string, string>> = {
  "explorer.add": { "explorer.index": "mkdir,mkfile" },
  "explorer.upload": {
    "explorer.upload": "fileUpload",
    "explorer.attachment": "upload",
  },
  "explorer.view": {
    "explorer.index": "fileOut,unzipList,fileOutBy,pathLog",
    "explorer.editor": "fileGet",
    "explorer.fileView": "index,open",
  },
  "explorer.download": { "explorer.index": "fileDownload,zipDownload,fileDownloadRemove" },
  "explorer.share": { "explorer.userShare": "add,edit,del" },
  "explorer.shareLink": { "explorer.userShare": "add,edit,del" },
  "explorer.remove": { "explorer.index": "pathDelete,recycleDelete,recycleRestore" },
  "explorer.edit": {
    "explorer.userShareTarget": "save",
    "explorer.index": "setDesc,setMeta,setAuth,fileSave,pathRename,zip,unzip",
    "explorer.editor": "fileSave",
    "explorer.listSafe": "action",
    "explorer.history": "get,remove,clear,rollback,setDetail,fileOut",
    "comment.index": "listData,add,remove,prasise,listByUser,listChildren",
  },
  "explorer.move": { "explorer.index": "pathCopy,pathCute,pathCopyTo,pathCuteTo,pathPast,clipboard" },
  "explorer.serverDownload": { "explorer.upload": "serverDownload" },
  "explorer.search": { "": "" },
  "explorer.unzip": { "explorer.index": "unzip,unzipList" },
  "explorer.zip": { "explorer.index": "zip,zipDownload" },

  "user.edit": {
    "user.setting": "setConfig,setUserInfo,setHeadImage,uploadHeadImage,userLogoutSet",
  },
  "user.fav": {
    "explorer.fav": "add,rename,moveTop,moveBottom,del",
    "explorer.tag": "add,edit,remove,moveTop,moveBottom,resetSort,filesAddToTag,filesRemoveFromTag",
  },

  "admin.index.dashboard": { "admin.analysis": "option,table,chart,trend" },
  "admin.index.setting": {
    "admin.setting": "get,set,clearCache,phpInfo",
    "admin.notice": "get,add,edit,remove,sort,enable",
  },
  "admin.index.loginLog": { "admin.log": "loginLogList" },
  "admin.index.log": { "admin.log": "get,typelist" },
  "admin.index.server": { "admin.setting": "server" },

  "admin.role.list": { "admin.role": "get" },
  "admin.role.edit": { "admin.role": "add,edit,remove,sort" },
  "admin.job.list": { "admin.job": "get" },
  "admin.job.edit": { "admin.job": "add,edit,remove,sort" },

  "admin.member.list": {
    "admin.member": "get,getByID,search",
    "admin.group": "get,getByID,search",
  },
  "admin.member.userEdit": { "admin.member": "add,edit,remove,status,addGroup,removeGroup,switchGroup" },
  "admin.member.userAuth": { "admin.member": "add,edit,remove,status,addGroup,removeGroup,switchGroup" },
  "admin.member.groupEdit": { "admin.group": "add,edit,status,sort,remove,switchGroup" },

  "admin.auth.list": { "admin.auth": "get" },
  "admin.auth.edit": { "admin.auth": "add,edit,remove,sort" },

  "admin.plugin.list": { "admin.plugin": "appList" },
  "admin.plugin.edit": {
    "admin.plugin": "getConfig,setConfig,changeStatus,install,unInstall",
    "explorer.lightApp": "add,edit,del",
  },

  "admin.storage.list": { "admin.storage": "get" },
  "admin.storage.edit": {
    "admin.storage": "getConfig,add,edit,remove",
    "admin.backup": "config,get,remove",
  },

  "admin.autoTask.list": { "admin.autoTask": "get" },
  "admin.autoTask.edit": { "admin.autoTask": "add,edit,enable,remove,run,taskStart,taskRun,taskRunEvent" },
};

/** 无需角色身份检测的动作白名单。 */
export const AUTH_ALLOW_ACTION = [
  "explorer.tag.get",
  "explorer.fav.get",
  "explorer.index.pathInfo",
  "explorer.lightApp.get",
  "explorer.list.path",
  "explorer.list.listAll",
  "explorer.index.desktopApp",
  "explorer.userShare.get",
  "explorer.userShare.myShare",
  "explorer.userShare.shareDisplay",
  "explorer.userShare.shareExit",

  "explorer.tagGroup.get",
  "explorer.tagGroup.set",
  "explorer.tagGroup.filesRemoveFromTag",
  "explorer.tagGroup.filesAddToTag",

  "user.setting.notice",
  "user.setting.userLoginList",
  "user.setting.taskList",
  "user.setting.taskKillAll",
  "user.setting.taskAction",
  "user.setting.userChart",
  "user.setting.userLog",
  "user.setting.userDevice",

  "admin.role.get",
  "admin.job.get",
  "admin.auth.get",
  "admin.member.get",
  "admin.member.getByID",
  "admin.member.search",
  "admin.group.get",
  "admin.group.getByID",
  "admin.group.search",
];

/** 重复 action 允许 true 覆盖的权限点。 */
export const AUTH_ROLE_ACTION_KEEP_TRUE = ["explorer.share", "explorer.shareLink", "admin.member.userEdit", "admin.member.userAuth"];

/** 权限前置依赖 (authCheckAlias)。 */
export const AUTH_ALIAS: Record<string, string[]> = {
  "explorer.add": ["explorer.view"],
  "explorer.download": ["explorer.view"],
  "explorer.share": ["explorer.view", "explorer.upload", "explorer.add", "explorer.download"],
  "explorer.shareLink": ["explorer.view", "explorer.download"],
  "explorer.edit": ["explorer.add", "explorer.view", "explorer.upload"],
  "explorer.remove": ["explorer.edit"],
  "explorer.move": ["explorer.edit"],
  "explorer.unzip": ["explorer.edit"],
  "explorer.zip": ["explorer.edit"],
  "explorer.serverDownload": ["explorer.edit"],

  "admin.role.edit": ["admin.role.list"],
  "admin.job.edit": ["admin.job.list"],
  "admin.member.userEdit": ["admin.member.list"],
  "admin.member.groupEdit": ["admin.member.list"],
  "admin.auth.edit": ["admin.auth.list"],
  "admin.plugin.edit": ["admin.plugin.list"],
  "admin.storage.edit": ["admin.storage.list"],
  "admin.autoTask.edit": ["admin.autoTask.list"],
};

/** canCheckRole: 操作 -> 需满足的权限点 (任一满足即可)。 */
export const AUTH_ACTION_MAP: Record<string, string[]> = {
  view: ["explorer.view"],
  download: ["explorer.download"],
  upload: ["explorer.upload"],
  edit: ["explorer.edit"],
  remove: ["explorer.remove"],
  comment: ["explorer.edit"],
  event: ["explorer.edit"],
  root: ["explorer.edit"],
};
