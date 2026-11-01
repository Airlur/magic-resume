import { createFileRoute } from "@tanstack/react-router";

// 浏览器直连大多数 WebDAV 服务（坚果云、Nextcloud 等）会被 CORS 拦截，
// 因此由服务端代为转发 WebDAV 请求。账号密码仅随请求转发，不在服务端存储。
const ALLOWED_METHODS = new Set(["GET", "PUT", "PROPFIND", "MKCOL", "OPTIONS"]);

const FORWARD_HEADERS = new Set([
  "authorization",
  "content-type",
  "depth",
  "if-match",
  "if-none-match",
  "overwrite",
  "destination",
]);

export const Route = createFileRoute("/api/webdav/proxy")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let payload: {
          url?: unknown;
          method?: unknown;
          headers?: unknown;
          body?: unknown;
        };

        try {
          payload = await request.json();
        } catch (_error) {
          return Response.json({ error: "请求体不是有效的 JSON" }, { status: 400 });
        }

        const { url, method, headers, body } = payload;

        if (typeof url !== "string" || !url) {
          return Response.json({ error: "缺少 url 参数" }, { status: 400 });
        }
        if (typeof method !== "string" || !ALLOWED_METHODS.has(method.toUpperCase())) {
          return Response.json({ error: `不支持的请求方法: ${method}` }, { status: 400 });
        }

        let parsedUrl: URL;
        try {
          parsedUrl = new URL(url);
        } catch (_error) {
          return Response.json({ error: "WebDAV 地址格式不正确" }, { status: 400 });
        }
        if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
          return Response.json({ error: "WebDAV 地址只支持 HTTP 和 HTTPS 协议" }, { status: 400 });
        }

        const forwardHeaders: Record<string, string> = {};
        if (headers && typeof headers === "object") {
          for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
            if (typeof value !== "string") continue;
            if (!FORWARD_HEADERS.has(key.toLowerCase())) continue;
            forwardHeaders[key] = value;
          }
        }

        const fetchInit: RequestInit = {
          method: method.toUpperCase(),
          headers: forwardHeaders,
          signal: AbortSignal.timeout(30000),
        };
        if (typeof body === "string" && method.toUpperCase() !== "GET") {
          fetchInit.body = body;
        }

        let upstream: Response;
        try {
          upstream = await fetch(parsedUrl.toString(), fetchInit);
        } catch (error: any) {
          const message = error?.message || "未知错误";
          return Response.json({ error: `无法连接到 WebDAV 服务器: ${message}` }, { status: 502 });
        }

        const text = await upstream.text();
        const responseHeaders: Record<string, string> = {
          "Cache-Control": "no-store",
        };
        const contentType = upstream.headers.get("content-type");
        if (contentType) responseHeaders["Content-Type"] = contentType;

        return new Response(text, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        });
      },
    },
  },
});
