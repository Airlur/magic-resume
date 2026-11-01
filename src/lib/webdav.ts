export interface WebDAVConfig {
  serverUrl: string;
  username: string;
  password: string;
  folder: string;
  /** 每次推送生成的历史备份保留数量，5-50 */
  historyLimit?: number;
}

export interface WebDAVLastSync {
  pushedAt?: string;
  pulledAt?: string;
  remoteExportedAt?: string;
}

export const WEBDAV_CONFIG_KEY = "webdavConfig";
export const WEBDAV_LAST_SYNC_KEY = "webdavLastSync";

export const isWebDAVConfigComplete = (config?: WebDAVConfig | null): boolean =>
  Boolean(
    config?.serverUrl?.trim() &&
      config?.username?.trim() &&
      config?.password &&
      config?.folder?.trim()
  );

export const normalizeWebDAVConfig = (config: WebDAVConfig): WebDAVConfig => ({
  serverUrl: config.serverUrl.trim().replace(/\/+$/, ""),
  username: config.username.trim(),
  password: config.password,
  folder: config.folder.trim().replace(/^\/+|\/+$/g, ""),
});

const encodeBase64Utf8 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

const basicAuthHeader = (config: WebDAVConfig): string =>
  `Basic ${encodeBase64Utf8(`${config.username}:${config.password}`)}`;

export const getWebDAVFolderUrl = (config: WebDAVConfig): string => {
  const normalized = normalizeWebDAVConfig(config);
  if (!normalized.folder) return normalized.serverUrl;
  return `${normalized.serverUrl}/${normalized.folder}`;
};

export const getWebDAVFileUrl = (config: WebDAVConfig): string =>
  `${getWebDAVFolderUrl(config)}/magic-resume-backup.json`;

export const buildWebDAVHistoryFileName = (date = new Date()): string =>
  `magic-resume-backup-${date.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "")}.json`;

const WEBDAV_HISTORY_RE =
  /^magic-resume-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?\.json$/;

export interface WebDAVBackupEntry {
  fileName: string;
  timestamp: number;
  size?: number;
}

export interface WebDAVResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
  error?: string;
}

interface ProxyRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

const webdavRequest = async (request: ProxyRequest): Promise<WebDAVResponse> => {
  try {
    const response = await fetch("/api/webdav/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    const text = await response.text();

    if (!response.ok && response.headers.get("content-type")?.includes("application/json")) {
      try {
        const data = JSON.parse(text) as { error?: string };
        if (data.error) {
          return { ok: false, status: response.status, statusText: response.statusText, text, error: data.error };
        }
      } catch (_error) {
        // 保留原始响应文本
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text,
    };
  } catch (error: any) {
    return {
      ok: false,
      status: 0,
      statusText: "",
      text: "",
      error: error?.message || "网络请求失败",
    };
  }
};

export interface WebDAVTestResult {
  ok: boolean;
  folderExists: boolean;
  message?: string;
}

export const testWebDAVConnection = async (config: WebDAVConfig): Promise<WebDAVTestResult> => {
  const response = await webdavRequest({
    url: getWebDAVFolderUrl(config),
    method: "PROPFIND",
    headers: {
      Authorization: basicAuthHeader(config),
      Depth: "0",
    },
  });

  if (response.status === 207 || response.status === 200) {
    return { ok: true, folderExists: true };
  }
  if (response.status === 404) {
    // 服务器可达（否则不会返回 404），只是文件夹还没创建
    return { ok: true, folderExists: false };
  }
  if (response.status === 401) {
    return { ok: false, folderExists: false, message: "账号或应用密码不正确（401）" };
  }
  return {
    ok: false,
    folderExists: false,
    message: response.error || `连接失败（${response.status} ${response.statusText}）`,
  };
};

const createFolderIfMissing = async (config: WebDAVConfig): Promise<boolean> => {
  const normalized = normalizeWebDAVConfig(config);
  if (!normalized.folder) return true;

  const response = await webdavRequest({
    url: getWebDAVFolderUrl(config),
    method: "MKCOL",
    headers: { Authorization: basicAuthHeader(config) },
  });

  // 201 创建成功；405 已存在；301/207 部分服务器的已存在表现
  return [201, 405, 301, 207].includes(response.status);
};

const putWebDAVUrl = async (
  config: WebDAVConfig,
  url: string,
  content: string
): Promise<{ ok: boolean; message?: string }> => {
  const headers = {
    Authorization: basicAuthHeader(config),
    "Content-Type": "application/json;charset=utf-8",
  };

  let response = await webdavRequest({ url, method: "PUT", headers, body: content });

  // 文件夹不存在时先创建再重试（坚果云等会返回 409）
  if (!response.ok && (response.status === 404 || response.status === 409)) {
    const created = await createFolderIfMissing(config);
    if (!created) {
      return { ok: false, message: response.error || `无法创建远程文件夹（${response.status}）` };
    }
    response = await webdavRequest({ url, method: "PUT", headers, body: content });
  }

  if (!response.ok) {
    return { ok: false, message: response.error || `上传失败（${response.status} ${response.statusText}）` };
  }
  return { ok: true };
};

export const putWebDAVFile = async (
  config: WebDAVConfig,
  content: string
): Promise<{ ok: boolean; message?: string }> =>
  putWebDAVUrl(config, getWebDAVFileUrl(config), content);

export const putWebDAVFileByName = async (
  config: WebDAVConfig,
  fileName: string,
  content: string
): Promise<{ ok: boolean; message?: string }> =>
  putWebDAVUrl(config, `${getWebDAVFolderUrl(config)}/${fileName}`, content);

export const getWebDAVFile = async (
  config: WebDAVConfig
): Promise<{ ok: boolean; notFound?: boolean; content?: string; message?: string }> =>
  getWebDAVFileByName(config, "magic-resume-backup.json");

export const getWebDAVFileByName = async (
  config: WebDAVConfig,
  fileName: string
): Promise<{ ok: boolean; notFound?: boolean; content?: string; message?: string }> => {
  const response = await webdavRequest({
    url: `${getWebDAVFolderUrl(config)}/${fileName}`,
    method: "GET",
    headers: { Authorization: basicAuthHeader(config) },
  });

  if (response.status === 404) {
    return { ok: true, notFound: true };
  }
  if (!response.ok) {
    return { ok: false, message: response.error || `下载失败（${response.status} ${response.statusText}）` };
  }
  return { ok: true, content: response.text };
};

// 宽容地解析各家 WebDAV 服务器返回的 multistatus XML（命名空间前缀不统一）
const parseMultistatusEntries = (xml: string): { href: string; size?: number }[] => {
  const entries: { href: string; size?: number }[] = [];
  const responseRe = /<(?:[\w.-]+:)?response\b[\s\S]*?<\/(?:[\w.-]+:)?response>/gi;
  const hrefRe = /<(?:[\w.-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href>/i;
  const sizeRe = /<(?:[\w.-]+:)?getcontentlength\b[^>]*>(\d+)\s*</i;

  let match: RegExpExecArray | null;
  while ((match = responseRe.exec(xml))) {
    const block = match[0];
    const hrefMatch = block.match(hrefRe);
    if (!hrefMatch) continue;
    const sizeMatch = block.match(sizeRe);
    entries.push({
      href: decodeURIComponent(hrefMatch[1].trim()),
      size: sizeMatch ? Number(sizeMatch[1]) : undefined,
    });
  }
  return entries;
};

export const listWebDAVBackups = async (
  config: WebDAVConfig
): Promise<{ ok: boolean; entries?: WebDAVBackupEntry[]; message?: string }> => {
  const response = await webdavRequest({
    url: getWebDAVFolderUrl(config),
    method: "PROPFIND",
    headers: {
      Authorization: basicAuthHeader(config),
      Depth: "1",
    },
  });

  if (response.status === 404) {
    // 远程文件夹还没创建，视为没有历史备份
    return { ok: true, entries: [] };
  }
  if (!response.ok) {
    return { ok: false, message: response.error || `获取备份列表失败（${response.status}）` };
  }

  const folderPath = new URL(getWebDAVFolderUrl(config)).pathname.replace(/\/+$/, "");
  const entries: WebDAVBackupEntry[] = [];
  for (const { href, size } of parseMultistatusEntries(response.text)) {
    const path = href.replace(/\/+$/, "");
    if (path === folderPath) continue;
    const fileName = path.split("/").pop() ?? "";
    const match = fileName.match(WEBDAV_HISTORY_RE);
    if (!match) continue;
    entries.push({
      fileName,
      timestamp: Date.UTC(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6])
      ),
      size,
    });
  }

  entries.sort((a, b) => b.timestamp - a.timestamp);
  return { ok: true, entries };
};

export const deleteWebDAVFileByName = async (
  config: WebDAVConfig,
  fileName: string
): Promise<{ ok: boolean; message?: string }> => {
  const response = await webdavRequest({
    url: `${getWebDAVFolderUrl(config)}/${fileName}`,
    method: "DELETE",
    headers: { Authorization: basicAuthHeader(config) },
  });

  // 404 视为已删除；部分服务器对空集合返回 409，也按已处理
  if (response.ok || response.status === 404) {
    return { ok: true };
  }
  return { ok: false, message: response.error || `删除失败（${response.status} ${response.statusText}）` };
};
