/**
 * R2 file storage helpers
 * Files are stored with key format: {username}/{relativePath}
 */

/** 由存储根(baseKey, 含尾斜杠, 如 `username/` 或 `__group__/5/`)与相对路径拼接 R2 key。 */
export function keyFromBase(baseKey: string, relPath: string): string {
  let normalized = (relPath || "").replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized.startsWith("/")) normalized = normalized.slice(1);
  let base = baseKey.replace(/\\/g, "/");
  if (!base.endsWith("/")) base += "/";
  if (!base || base === "/") return normalized;
  return base + normalized;
}

/** 个人空间 key: {username}/{relativePath} */
export function getUserFileKey(username: string, path: string): string {
  return keyFromBase(`${username}/`, path);
}

export function parseR2Key(key: string): { username: string; path: string } | null {
  const idx = key.indexOf("/");
  if (idx === -1) return null;
  return {
    username: key.slice(0, idx),
    path: key.slice(idx + 1),
  };
}

export async function listDirectory(
  bucket: R2Bucket,
  baseKey: string,
  dirPath: string
): Promise<{ folders: R2Object[]; files: R2Object[] }> {
  const prefix = keyFromBase(baseKey, dirPath);
  // 空 baseKey(存储根) 时 prefix 为空串, 不能补成 "/" (会与无前导斜杠的 key 不匹配)
  const normalizedPrefix = prefix && !prefix.endsWith("/") ? prefix + "/" : prefix;

  const listed = await bucket.list({ prefix: normalizedPrefix, delimiter: "/" });

  // Directories (from delimitedPrefixes) - use a simpler type
  const folders = (listed.delimitedPrefixes || []).map((p) => ({
    key: p,
    size: 0,
    uploaded: new Date(),
    httpMetadata: {} as R2HTTPMetadata,
    customMetadata: {} as Record<string, string>,
    version: "",
    checksums: {} as R2Checksums,
    httpEtag: "",
    etag: "",
    storageClass: "" as const,
    writeHttpMetadata(_headers: Headers) {},
  })) as unknown as R2Object[];

  // Files (from objects)
  const files: R2Object[] = listed.objects.filter(
    (o) => o.key !== normalizedPrefix // exclude the directory placeholder itself
  );

  return { folders, files };
}

export async function fileExists(bucket: R2Bucket, key: string): Promise<boolean> {
  const obj = await bucket.head(key);
  return obj !== null;
}

/** Recursively list every file under the given storage root (used by file-type category browsing). */
export async function listAllFiles(
  bucket: R2Bucket,
  baseKey: string,
  maxRounds = 500
): Promise<R2Object[]> {
  const prefix = keyFromBase(baseKey, "/");
  const all: R2Object[] = [];
  let cursor: string | undefined;
  let rounds = 0;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of listed.objects) {
      const name = o.key.split("/").pop() || "";
      if (name === ".keep" || name.startsWith(".")) continue;
      const rel = o.key.slice(prefix.length);
      if (rel.split("/").some((seg) => seg.startsWith("."))) continue;
      all.push(o);
    }
    rounds++;
    cursor = listed.truncated ? listed.cursor : undefined;
    if (rounds >= maxRounds) cursor = undefined;
  } while (cursor);
  return all;
}

export async function deleteDirectory(bucket: R2Bucket, prefix: string, maxObjects = 100000, maxRounds = 1000): Promise<void> {
  let cursor: string | undefined;
  let deleted = 0;
  let rounds = 0;
  do {
    const listed = await bucket.list({ prefix, cursor });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length > 0) {
      await Promise.all(keys.map((k) => bucket.delete(k)));
      deleted += keys.length;
    }
    rounds++;
    cursor = listed.truncated ? listed.cursor : undefined;
    if (deleted >= maxObjects || rounds >= maxRounds) cursor = undefined;
  } while (cursor);
}

/**
 * 清理分片上传残留: 删除 {baseKey}/.upload_tmp/ 下超过 maxAgeMs 未更新的临时分片
 * (上传取消/中断后不产生 merged 标记, 原清理逻辑只覆盖成功会话, 这里做兜底自愈)。
 * 返回清理的对象数。
 */
export async function cleanupStaleUploadTmp(
  bucket: R2Bucket,
  baseKey: string,
  maxAgeMs = 24 * 3600 * 1000
): Promise<number> {
  const prefix = keyFromBase(baseKey, "/.upload_tmp/");
  const listed = await bucket.list({ prefix, limit: 1000 });
  const cutoff = Date.now() - maxAgeMs;
  const stale = listed.objects
    .filter((o) => new Date(o.uploaded).getTime() < cutoff)
    .map((o) => o.key);
  if (stale.length > 0) await bucket.delete(stale);
  return stale.length;
}

/**
 * Get file type icon category based on extension
 */
export function getFileTypeCategory(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";

  const imageExts = ["jpg", "jpeg", "png", "gif", "bmp", "svg", "webp", "ico", "tiff", "tif", "psd", "ai", "raw"];
  const videoExts = ["mp4", "avi", "mkv", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "3gp"];
  const audioExts = ["mp3", "wav", "flac", "aac", "ogg", "wma", "m4a", "ape"];
  const docExts = ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "pdf", "txt", "csv", "rtf", "odt", "ods", "odp"];
  const codeExts = ["js", "ts", "jsx", "tsx", "html", "css", "scss", "less", "php", "py", "java", "cpp", "c", "h", "go", "rs", "rb", "swift", "kt", "sh", "bash", "sql", "json", "xml", "yaml", "yml", "toml", "md"];
  const archiveExts = ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"];

  if (imageExts.includes(ext)) return "image";
  if (videoExts.includes(ext)) return "video";
  if (audioExts.includes(ext)) return "audio";
  if (docExts.includes(ext)) return "document";
  if (codeExts.includes(ext)) return "code";
  if (archiveExts.includes(ext)) return "archive";

  return "file";
}

export function getFileMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const mimeTypes: Record<string, string> = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "gif": "image/gif", "bmp": "image/bmp", "svg": "image/svg+xml",
    "webp": "image/webp", "ico": "image/x-icon",
    "mp4": "video/mp4", "webm": "video/webm", "avi": "video/x-msvideo",
    "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg",
    "pdf": "application/pdf", "json": "application/json",
    "zip": "application/zip", "tar": "application/x-tar",
    "gz": "application/gzip", "7z": "application/x-7z-compressed",
    "html": "text/html", "css": "text/css", "js": "text/javascript",
    "txt": "text/plain", "csv": "text/csv", "xml": "application/xml",
    "md": "text/markdown",
  };
  return mimeTypes[ext] || "application/octet-stream";
}
