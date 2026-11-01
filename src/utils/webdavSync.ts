import type { ResumeData } from "@/types/resume";
import { useResumeStore } from "@/store/useResumeStore";
import { getConfig, storeConfig } from "@/utils/fileSystem";
import {
  WEBDAV_LAST_SYNC_KEY,
  type WebDAVConfig,
  type WebDAVLastSync,
  getWebDAVFile,
  putWebDAVFile,
} from "@/lib/webdav";

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
  return { status: "success", exportedAt: snapshot.exportedAt };
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

  let snapshot: WebDAVSnapshot;
  try {
    const parsed = JSON.parse(remote.content) as unknown;
    if (!isWebDAVSnapshot(parsed)) {
      return { status: "error", message: "云端数据不是有效的备份文件" };
    }
    snapshot = parsed;
  } catch (_error) {
    return { status: "error", message: "云端数据不是有效的备份文件" };
  }

  const remoteExportedAtMs = parseTimestamp(snapshot.exportedAt) ?? Date.now();
  const updateResumeFromFile = useResumeStore.getState().updateResumeFromFile;

  let synced = 0;
  let skipped = 0;
  for (const resume of Object.values(snapshot.resumes)) {
    if (!isResumeData(resume)) {
      skipped += 1;
      continue;
    }
    // 云端文件可能来自旧版本或被手动编辑过，补全必需的时间字段，
    // 避免列表页格式化 undefined 日期时报错。
    const fallbackTime = new Date(remoteExportedAtMs).toISOString();
    if (typeof resume.updatedAt !== "string" || Number.isNaN(Date.parse(resume.updatedAt))) {
      resume.updatedAt = fallbackTime;
    }
    if (typeof resume.createdAt !== "string" || Number.isNaN(Date.parse(resume.createdAt))) {
      resume.createdAt = resume.updatedAt;
    }
    // 传入简历自身的 updatedAt 作为源时间，保证"较新者胜"的合并语义
    const resumeUpdatedAt = parseTimestamp(resume.updatedAt) ?? remoteExportedAtMs;
    if (updateResumeFromFile(resume, resumeUpdatedAt)) {
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
