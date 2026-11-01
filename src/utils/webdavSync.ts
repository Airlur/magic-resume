import type { ResumeData } from "@/types/resume";
import { useResumeStore } from "@/store/useResumeStore";
import { getConfig, storeConfig } from "@/utils/fileSystem";
import {
  WEBDAV_LAST_SYNC_KEY,
  buildWebDAVHistoryFileName,
  type WebDAVBackupEntry,
  type WebDAVConfig,
  type WebDAVLastSync,
  deleteWebDAVFileByName,
  getWebDAVFile,
  getWebDAVFileByName,
  listWebDAVBackups,
  putWebDAVFile,
  putWebDAVFileByName,
} from "@/lib/webdav";

export const WEBDAV_HISTORY_LIMIT_DEFAULT = 10;
const WEBDAV_HISTORY_LIMIT_MIN = 5;
const WEBDAV_HISTORY_LIMIT_MAX = 50;

export const clampWebDAVHistoryLimit = (value: unknown): number => {
  const parsed =
    typeof value === "number"
      ? Math.round(value)
      : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return WEBDAV_HISTORY_LIMIT_DEFAULT;
  return Math.min(WEBDAV_HISTORY_LIMIT_MAX, Math.max(WEBDAV_HISTORY_LIMIT_MIN, parsed));
};

interface WebDAVSnapshot {
  app: "magic-resume";
  schema: 1;
  exportedAt: string;
  activeResumeId: string | null;
  resumes: Record<string, ResumeData>;
}

const parseTimestamp = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
};

const isResumeData = (value: unknown): value is ResumeData => {
  if (!value || typeof value !== "object") return false;
  const resume = value as Partial<ResumeData>;
  // 结构不完整的简历（如手动编辑过的备份）宁可跳过，也不能导入后让页面崩溃
  return (
    typeof resume.id === "string" &&
    resume.id.length > 0 &&
    !!resume.basic &&
    Array.isArray(resume.menuSections)
  );
};

const isWebDAVSnapshot = (value: unknown): value is WebDAVSnapshot => {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<WebDAVSnapshot>;
  if (snapshot.app !== "magic-resume" || snapshot.schema !== 1) return false;
  if (typeof snapshot.exportedAt !== "string") return false;
  if (!snapshot.resumes || typeof snapshot.resumes !== "object") return false;
  return true;
};

const parseSnapshotFile = (content: string): WebDAVSnapshot | null => {
  try {
    const parsed = JSON.parse(content) as unknown;
    return isWebDAVSnapshot(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
};

const normalizeSnapshotResume = (resume: ResumeData, fallbackIso: string): ResumeData => {
  const next = { ...resume };
  // 云端文件可能来自旧版本或被手动编辑过，补全必需的时间字段，
  // 避免列表页格式化 undefined 日期时报错。
  if (typeof next.updatedAt !== "string" || Number.isNaN(Date.parse(next.updatedAt))) {
    next.updatedAt = fallbackIso;
  }
  if (typeof next.createdAt !== "string" || Number.isNaN(Date.parse(next.createdAt))) {
    next.createdAt = next.updatedAt;
  }
  return next;
};

export const buildWebDAVSnapshot = (): WebDAVSnapshot => {
  const { resumes, activeResumeId } = useResumeStore.getState();
  return {
    app: "magic-resume",
    schema: 1,
    exportedAt: new Date().toISOString(),
    activeResumeId,
    resumes,
  };
};

const loadLastSync = async (): Promise<WebDAVLastSync> => {
  try {
    return (await getConfig(WEBDAV_LAST_SYNC_KEY)) || {};
  } catch (_error) {
    return {};
  }
};

const saveLastSync = async (lastSync: WebDAVLastSync) => {
  try {
    await storeConfig(WEBDAV_LAST_SYNC_KEY, lastSync);
  } catch (error) {
    console.error("Error saving WebDAV last sync info:", error);
  }
};

export type PushWebDAVResult =
  | { status: "success"; exportedAt: string }
  | { status: "conflict"; remoteExportedAt: string }
  | { status: "empty" }
  | { status: "error"; message: string };

export const pushResumesToWebDAV = async (
  config: WebDAVConfig,
  options: { force?: boolean } = {}
): Promise<PushWebDAVResult> => {
  const snapshot = buildWebDAVSnapshot();
  if (!snapshot.activeResumeId && Object.keys(snapshot.resumes).length === 0) {
    return { status: "empty" };
  }

  const lastSync = await loadLastSync();

  // 云端存在数据、且不是本设备最后一次推送的内容时，视为可能覆盖其他设备的更新
  const remote = await getWebDAVFile(config);
  if (remote.ok && !remote.notFound && remote.content) {
    try {
      const remoteSnapshot = JSON.parse(remote.content) as unknown;
      if (
        isWebDAVSnapshot(remoteSnapshot) &&
        !options.force &&
        lastSync.remoteExportedAt !== remoteSnapshot.exportedAt
      ) {
        return { status: "conflict", remoteExportedAt: remoteSnapshot.exportedAt };
      }
    } catch (error) {
      console.error("Error parsing remote WebDAV snapshot:", error);
      return { status: "error", message: "云端数据不是有效的备份文件" };
    }
  } else if (!remote.ok) {
    return { status: "error", message: remote.message || "读取云端数据失败" };
  }

  const content = JSON.stringify(snapshot, null, 2);
  const pushed = await putWebDAVFile(config, content);
  if (!pushed.ok) {
    return { status: "error", message: pushed.message || "上传失败" };
  }

  await saveLastSync({
    ...lastSync,
    pushedAt: snapshot.exportedAt,
    remoteExportedAt: snapshot.exportedAt,
  });

  // 历史备份的写入和清理失败不影响推送结果
  try {
    await maintainWebDAVHistory(config, content);
  } catch (error) {
    console.warn("WebDAV history maintenance failed:", error);
  }

  return { status: "success", exportedAt: snapshot.exportedAt };
};

// 每次推送生成一份带时间戳的历史快照，并把数量裁剪到配置的上限内
const maintainWebDAVHistory = async (config: WebDAVConfig, content: string) => {
  const limit = clampWebDAVHistoryLimit(config.historyLimit);

  await putWebDAVFileByName(config, buildWebDAVHistoryFileName(), content);

  const list = await listWebDAVBackups(config);
  if (!list.ok || !list.entries) return;

  for (const entry of list.entries.slice(limit)) {
    const deleted = await deleteWebDAVFileByName(config, entry.fileName);
    if (!deleted.ok) {
      console.warn(`Failed to prune old WebDAV backup "${entry.fileName}":`, deleted.message);
    }
  }
};

export type PullWebDAVResult =
  | { status: "success"; synced: number; skipped: number }
  | { status: "empty" }
  | { status: "error"; message: string };

export const pullResumesFromWebDAV = async (
  config: WebDAVConfig
): Promise<PullWebDAVResult> => {
  const remote = await getWebDAVFile(config);
  if (!remote.ok) {
    return { status: "error", message: remote.message || "读取云端数据失败" };
  }
  if (remote.notFound || !remote.content) {
    return { status: "empty" };
  }

  let snapshot: WebDAVSnapshot | null = parseSnapshotFile(remote.content);
  if (!snapshot) {
    return { status: "error", message: "云端数据不是有效的备份文件" };
  }

  const remoteExportedAtMs = parseTimestamp(snapshot.exportedAt) ?? Date.now();
  const fallbackIso = new Date(remoteExportedAtMs).toISOString();
  const updateResumeFromFile = useResumeStore.getState().updateResumeFromFile;

  let synced = 0;
  let skipped = 0;
  for (const resume of Object.values(snapshot.resumes)) {
    if (!isResumeData(resume)) {
      skipped += 1;
      continue;
    }
    const normalized = normalizeSnapshotResume(resume, fallbackIso);
    // 传入简历自身的 updatedAt 作为源时间，保证"较新者胜"的合并语义
    const resumeUpdatedAt = parseTimestamp(normalized.updatedAt) ?? remoteExportedAtMs;
    if (updateResumeFromFile(normalized, resumeUpdatedAt)) {
      synced += 1;
    } else {
      skipped += 1;
    }
  }

  const lastSync = await loadLastSync();
  await saveLastSync({
    ...lastSync,
    pulledAt: new Date().toISOString(),
    remoteExportedAt: snapshot.exportedAt,
  });

  // 本地还没有任何简历时，跟随云端记录的当前简历
  const state = useResumeStore.getState();
  if (!state.activeResumeId && snapshot.activeResumeId && state.resumes[snapshot.activeResumeId]) {
    state.setActiveResume(snapshot.activeResumeId);
  }

  return { status: "success", synced, skipped };
};

export type ListWebDAVBackupsResult =
  | { status: "success"; entries: WebDAVBackupEntry[] }
  | { status: "error"; message: string };

export const listWebDAVBackupsForConfig = async (
  config: WebDAVConfig
): Promise<ListWebDAVBackupsResult> => {
  const list = await listWebDAVBackups(config);
  if (!list.ok || !list.entries) {
    return { status: "error", message: list.message || "获取备份列表失败" };
  }
  return { status: "success", entries: list.entries };
};

export type RestoreWebDAVBackupResult =
  | { status: "success"; count: number }
  | { status: "error"; message: string };

// 恢复 = 用该备份整体替换本地数据（与拉取的"合并"不同，恢复要能真正回滚）
export const restoreWebDAVBackup = async (
  config: WebDAVConfig,
  fileName: string
): Promise<RestoreWebDAVBackupResult> => {
  const remote = await getWebDAVFileByName(config, fileName);
  if (!remote.ok) {
    return { status: "error", message: remote.message || "读取备份失败" };
  }
  if (remote.notFound || !remote.content) {
    return { status: "error", message: "备份不存在或已被自动清理" };
  }

  const snapshot = parseSnapshotFile(remote.content);
  if (!snapshot) {
    return { status: "error", message: "备份数据不是有效的快照文件" };
  }

  const fallbackIso = new Date(parseTimestamp(snapshot.exportedAt) ?? Date.now()).toISOString();
  const resumes: Record<string, ResumeData> = {};
  for (const resume of Object.values(snapshot.resumes)) {
    if (!isResumeData(resume)) continue;
    const normalized = normalizeSnapshotResume(resume, fallbackIso);
    resumes[normalized.id] = normalized;
  }

  const activeResumeId =
    snapshot.activeResumeId && resumes[snapshot.activeResumeId]
      ? snapshot.activeResumeId
      : (Object.keys(resumes)[0] ?? null);

  useResumeStore.setState({
    resumes,
    activeResumeId,
    activeResume: activeResumeId ? resumes[activeResumeId] : null,
  });

  return { status: "success", count: Object.keys(resumes).length };
};

export type DeleteWebDAVBackupResult =
  | { status: "success" }
  | { status: "error"; message: string };

export const deleteWebDAVBackup = async (
  config: WebDAVConfig,
  fileName: string
): Promise<DeleteWebDAVBackupResult> => {
  const deleted = await deleteWebDAVFileByName(config, fileName);
  if (!deleted.ok) {
    return { status: "error", message: deleted.message || "删除失败" };
  }
  return { status: "success" };
};
