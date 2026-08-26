/**
 * kodDiff (diffApply) - TS port of 001 kodDiff.class.php.
 *
 * 用于部门标签等数据的前端 diff 同步:
 *   - objDiff: { type:'edit'|'remove'|'diff'|'diffArr', val?, _clearAll? }
 *   - arrayDiff: { add:[{beforeID,val}], remove:[], edit:{id:objDiff}, sort:{isChange,idArr} }
 *   - dataLike: { key: [{ _idKey_:'id', _autoID_:'number'|'string' }] }
 */

type ObjDiff = {
  type: "edit" | "remove" | "diff" | "diffArr";
  val?: any;
  _clearAll?: boolean;
};
type ArrayDiff = {
  add: { beforeID: string; val: any }[];
  remove: string[];
  edit: Record<string, ObjDiff>;
  sort: { isChange: boolean; idArr: string[] };
};
type AnyDiff = Record<string, any>;

function isObject(v: any): v is Record<string, any> {
  return Array.isArray(v) ? false : v !== null && typeof v === "object";
}
function isArray(v: any): v is any[] {
  return Array.isArray(v);
}
function isEqual(a: any, b: any): boolean {
  if (typeof a !== typeof b) return false;
  if (isArray(a)) {
    if (!isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!isEqual(a[i], b[i])) return false;
    return true;
  }
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k) || !isEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return a === b;
}

/** 构造不重复 id: number 类型取 max+1; string 类型生成随机 6 位字符串。 */
function makeID(idArr: string[], type: string): string {
  if (type !== "string") {
    let max = 1;
    for (const id of idArr) max = Math.max(max, parseInt(id, 10) || 0);
    return String(max + 1);
  }
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let loop = 0; loop < 500; loop++) {
    let uid = "";
    for (let i = 0; i < 6; i++) uid += chars[Math.floor(Math.random() * chars.length)];
    if (!idArr.includes(uid)) return uid;
  }
  return "kodtag";
}

/** 为缺少 id 的数组项自动分配 id。 */
export function arrayAutoID(arr: any[], idKey: string, type: string): any[] {
  const idArr: string[] = [];
  for (const v of arr) {
    if (isObject(v) && v[idKey]) idArr.push(String(v[idKey]));
  }
  for (const v of arr) {
    if (!isObject(v) || v[idKey]) continue;
    const id = makeID(idArr, type);
    idArr.push(id);
    v[idKey] = id;
  }
  return arr;
}

function getStruct(struct: any, key: string): any {
  const parts = String(key).split(".");
  let cur = struct;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return false;
    if (Object.prototype.hasOwnProperty.call(cur, p)) {
      cur = cur[p];
    } else {
      return false;
    }
  }
  return cur;
}

function applyObject(obj: Record<string, any>, diff: AnyDiff, objStruct: any): Record<string, any> {
  const newObj = { ...obj };
  for (const key of Object.keys(diff)) {
    const change = diff[key] as ObjDiff;
    switch (change.type) {
      case "edit":
        newObj[key] = change.val;
        break;
      case "remove":
        delete newObj[key];
        break;
      case "diff": {
        newObj[key] = applyObject(isObject(newObj[key]) ? newObj[key] : {}, change.val || {}, getStruct(objStruct, key));
        if (change._clearAll && isEmpty(newObj[key])) delete newObj[key];
        break;
      }
      case "diffArr": {
        newObj[key] = applyArray(isArray(newObj[key]) ? newObj[key] : [], change.val, getStruct(objStruct, `${key}.0`));
        if (change._clearAll && isEmpty(newObj[key])) delete newObj[key];
        break;
      }
      default:
        break;
    }
  }
  return newObj;
}

function isEmpty(v: any): boolean {
  if (isArray(v)) return v.length === 0;
  if (isObject(v)) return Object.keys(v).length === 0;
  return v === "" || v === null || v === undefined;
}

function applyArray(arr: any[], diff: AnyDiff, objStruct: any): any[] {
  const idKey = isObject(objStruct) ? getStruct(objStruct, "_idKey_") || "id" : "";
  if (!diff) return arr;

  const newArr = arr.slice();
  const arrMap: Record<string, any> = {};
  const arrSort: string[] = [];

  for (let i = 0; i < newArr.length; i++) {
    const item = newArr[i];
    if (!isObject(item)) continue;
    const id = item[idKey] !== undefined ? String(item[idKey]) : "";
    if (!id) continue;
    if (diff.remove.includes(id)) {
      newArr[i] = false;
      continue;
    }
    if (diff.edit && diff.edit[id]) {
      newArr[i] = applyObject(item, diff.edit[id], objStruct);
    }
    arrMap[id] = newArr[i];
    arrSort.push(id);
  }

  // 新增项 (仅无 id 冲突时加入映射)
  for (const addItem of diff.add) {
    if (!isObject(addItem.val)) continue;
    const id = addItem.val[idKey] !== undefined ? String(addItem.val[idKey]) : "";
    if (id && arrMap[id] === undefined) arrMap[id] = addItem.val;
  }

  // 排序: 采用 diff.sort.idArr (变更) 或原有顺序
  const hasPushed: Record<string, boolean> = {};
  const arrResultID: string[] = [];
  const sortID = diff.sort && diff.sort.isChange ? diff.sort.idArr : arrSort;
  for (const id of sortID) {
    if (arrMap[id] !== undefined && !hasPushed[id]) {
      arrResultID.push(id);
      hasPushed[id] = true;
    }
  }
  for (const id of Object.keys(arrMap)) {
    if (!hasPushed[id]) arrResultID.push(id);
  }

  // 插入新增项 (beforeID 定位)
  const result: any[] = [];
  const hasAdd: Record<string, boolean> = {};
  const pushAdd = (beforeID: string) => {
    for (const addItem of diff.add) {
      if (!addItem || !isObject(addItem.val)) continue;
      if (String(addItem.beforeID) !== beforeID) continue;
      const id = addItem.val[idKey] !== undefined ? String(addItem.val[idKey]) : "";
      if (id && hasAdd[id]) continue;
      result.push(addItem.val);
      if (id) hasAdd[id] = true;
    }
  };
  pushAdd("");
  for (const id of arrResultID) {
    if (arrMap[id] !== undefined && !hasAdd[id]) result.push(arrMap[id]);
    pushAdd(id);
  }

  const autoIDType = getStruct(objStruct, "_autoID_");
  if (idKey && autoIDType) arrayAutoID(result, idKey, autoIDType);
  return result.filter((v) => v !== false && v !== null && v !== undefined);
}

/** 将前端 diff 应用到现有数据 (对齐 001 kodDiff::diffApply)。 */
export function diffApply(data: any, diff: any, dataLike: any): any {
  if (!diff) return data;
  if (Array.isArray(dataLike)) {
    return applyArray(isArray(data) ? data : [], diff, dataLike[0]);
  }
  if (isObject(dataLike)) {
    return applyObject(isObject(data) ? data : {}, diff, dataLike);
  }
  return data;
}
