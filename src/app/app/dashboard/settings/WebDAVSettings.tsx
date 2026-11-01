import { useEffect, useRef, useState } from "react";
import {
  CloudCog,
  CloudUpload,
  CloudDownload,
  PlugZap,
  Eye,
  EyeOff,
  History,
  RotateCcw,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/compat/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import {
  WEBDAV_CONFIG_KEY,
  isWebDAVConfigComplete,
  testWebDAVConnection,
  type WebDAVBackupEntry,
  type WebDAVConfig,
  type WebDAVLastSync,
} from "@/lib/webdav";
import {
  WEBDAV_HISTORY_LIMIT_DEFAULT,
  clampWebDAVHistoryLimit,
  pushResumesToWebDAV,
  pullResumesFromWebDAV,
  listWebDAVBackupsForConfig,
  restoreWebDAVBackup,
  deleteWebDAVBackup,
} from "@/utils/webdavSync";
import { getConfig, storeConfig } from "@/utils/fileSystem";

const EMPTY_CONFIG: WebDAVConfig = {
  serverUrl: "",
  username: "",
  password: "",
  folder: "magic-resume",
};

const formatTime = (value?: string | number) => {
  if (value === undefined) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
};

const formatBackupSize = (size?: number) => {
  if (!size || size <= 0) return null;
  return `${(size / 1024).toFixed(1)} KB`;
};

type BusyAction = "test" | "push" | "pull" | "backups" | null;

const WebDAVSettings = () => {
  const t = useTranslations();
  const [hydrated, setHydrated] = useState(false);
  const [config, setConfig] = useState<WebDAVConfig>(EMPTY_CONFIG);
  const [lastSync, setLastSync] = useState<WebDAVLastSync>({});
  const [busy, setBusy] = useState<BusyAction>(null);
  const [testState, setTestState] = useState<"ok" | "error" | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [conflictTime, setConflictTime] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState("config");
  // 备份历史懒加载：只有切到该标签时才请求一次，避免每次打开设置页都发请求
  const historyLoadedRef = useRef(false);
  const [historyLimitInput, setHistoryLimitInput] = useState(String(WEBDAV_HISTORY_LIMIT_DEFAULT));
  const [backups, setBackups] = useState<WebDAVBackupEntry[] | null>(null);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<WebDAVBackupEntry | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WebDAVBackupEntry | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [savedConfig, savedLastSync] = await Promise.all([
          getConfig(WEBDAV_CONFIG_KEY) as Promise<WebDAVConfig | null>,
          getConfig("webdavLastSync") as Promise<WebDAVLastSync | null>,
        ]);
        if (savedConfig) {
          setConfig({ ...EMPTY_CONFIG, ...savedConfig });
          setHistoryLimitInput(String(clampWebDAVHistoryLimit(savedConfig.historyLimit)));
        }
        if (savedLastSync) setLastSync(savedLastSync);
      } catch (error) {
        console.error("Error loading WebDAV config:", error);
      } finally {
        setHydrated(true);
      }
    };

    load();
  }, []);

  const configured = isWebDAVConfigComplete(config);

  const updateField = (field: keyof WebDAVConfig, value: string | number) => {
    setConfig((prev) => {
      const next = { ...prev, [field]: value };
      storeConfig(WEBDAV_CONFIG_KEY, next).catch((error) =>
        console.error("Error saving WebDAV config:", error)
      );
      return next;
    });
  };

  const requireConfig = (): WebDAVConfig | null => {
    if (!configured) {
      toast.error(t("dashboard.settings.webdav.needConfig"));
      return null;
    }
    return config;
  };

  const refreshBackups = async () => {
    const activeConfig = requireConfig();
    if (!activeConfig) return;
    setBusy("backups");
    setBackupsLoading(true);
    try {
      const result = await listWebDAVBackupsForConfig(activeConfig);
      if (result.status === "success") {
        setBackups(result.entries);
      } else {
        setBackups([]);
        toast.error(result.message || t("dashboard.settings.webdav.listError"));
      }
    } finally {
      setBackupsLoading(false);
      setBusy(null);
    }
  };

  const handleTabChange = (value: string) => {
    setActiveTab(value);
    if (value === "history" && !historyLoadedRef.current) {
      historyLoadedRef.current = true;
      void refreshBackups();
    }
  };

  const handleTest = async () => {
    if (!requireConfig()) return;
    setBusy("test");
    setTestState(null);
    setTestMessage(null);
    try {
      const result = await testWebDAVConnection(config);
      setTestState(result.ok ? "ok" : "error");
      if (result.ok) {
        setTestMessage(
          result.folderExists
            ? t("dashboard.settings.webdav.testSuccess")
            : t("dashboard.settings.webdav.testSuccessNoFolder")
        );
      } else {
        setTestMessage(result.message || t("dashboard.settings.webdav.testFailed"));
      }
    } finally {
      setBusy(null);
    }
  };

  const handlePush = async (force = false) => {
    if (!requireConfig()) return;
    setBusy("push");
    try {
      const result = await pushResumesToWebDAV(config, { force });
      switch (result.status) {
        case "success":
          setLastSync((prev) => ({
            ...prev,
            pushedAt: result.exportedAt,
            remoteExportedAt: result.exportedAt,
          }));
          toast.success(t("dashboard.settings.webdav.pushSuccess"));
          historyLoadedRef.current = true;
          void refreshBackups();
          break;
        case "conflict": {
          const remoteTime = formatTime(result.remoteExportedAt);
          setConflictTime(remoteTime || result.remoteExportedAt);
          break;
        }
        case "empty":
          toast.info(t("dashboard.settings.webdav.pushEmpty"));
          break;
        case "error":
          toast.error(result.message);
          break;
      }
    } finally {
      setBusy(null);
    }
  };

  const handlePull = async () => {
    if (!requireConfig()) return;
    setBusy("pull");
    try {
      const result = await pullResumesFromWebDAV(config);
      switch (result.status) {
        case "success":
          setLastSync((prev) => ({ ...prev, pulledAt: new Date().toISOString() }));
          toast.success(
            t("dashboard.settings.webdav.pullSuccess", { synced: result.synced, skipped: result.skipped })
          );
          break;
        case "empty":
          toast.info(t("dashboard.settings.webdav.pullEmpty"));
          break;
        case "error":
          toast.error(result.message);
          break;
      }
    } finally {
      setBusy(null);
    }
  };

  const commitHistoryLimit = () => {
    const clamped = clampWebDAVHistoryLimit(historyLimitInput);
    setHistoryLimitInput(String(clamped));
    if (clamped !== config.historyLimit) {
      updateField("historyLimit", clamped);
    }
  };

  const confirmRestore = async () => {
    if (!pendingRestore) return;
    const entry = pendingRestore;
    setPendingRestore(null);
    if (!requireConfig()) return;
    setBusy("backups");
    try {
      const result = await restoreWebDAVBackup(config, entry.fileName);
      if (result.status === "success") {
        toast.success(t("dashboard.settings.webdav.restoreSuccess", { count: result.count }));
      } else {
        toast.error(result.message);
      }
    } finally {
      setBusy(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const entry = pendingDelete;
    setPendingDelete(null);
    if (!requireConfig()) return;
    setBusy("backups");
    try {
      const result = await deleteWebDAVBackup(config, entry.fileName);
      if (result.status === "success") {
        toast.success(t("dashboard.settings.webdav.deleteSuccess"));
      } else {
        toast.error(result.message);
      }
      await refreshBackups();
    } finally {
      setBusy(null);
    }
  };

  const lastPushedAt = formatTime(lastSync.pushedAt);
  const lastPulledAt = formatTime(lastSync.pulledAt);

  const restoreConfirmTime = formatTime(pendingRestore?.timestamp) ?? pendingRestore?.fileName ?? "";
  const deleteConfirmTime = formatTime(pendingDelete?.timestamp) ?? pendingDelete?.fileName ?? "";

  return (
    <section className="rounded-2xl border border-border/80 bg-white/90 p-6 shadow-[0_1px_2px_rgba(28,28,24,0.03),0_6px_20px_rgba(28,28,24,0.02)] dark:bg-card">
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-3.5">
            <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary/70 text-foreground">
              <CloudCog className="h-4 w-4" />
              {configured && (
                <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-card" />
              )}
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-sans text-base font-semibold tracking-tight text-foreground">
                  {t("dashboard.settings.webdav.title")}
                </h2>
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
                    configured
                      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                      : "border-border/70 bg-secondary/60 text-muted-foreground"
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      configured ? "bg-emerald-500" : "bg-muted-foreground/45"
                    )}
                  />
                  {configured
                    ? t("dashboard.settings.webdav.statusConfigured")
                    : t("dashboard.settings.webdav.statusNotConfigured")}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
                {t("dashboard.settings.webdav.description")}
              </p>
              <p className="text-[11px] leading-relaxed text-muted-foreground/80">
                {lastPushedAt || lastPulledAt
                  ? [
                      lastPushedAt
                        ? `${t("dashboard.settings.webdav.lastPush")}: ${lastPushedAt}`
                        : null,
                      lastPulledAt
                        ? `${t("dashboard.settings.webdav.lastPull")}: ${lastPulledAt}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : t("dashboard.settings.webdav.never")}
              </p>
            </div>
          </div>

          <TabsList className="h-10 shrink-0 self-start rounded-xl bg-secondary/60 p-1 dark:bg-secondary/40">
            <TabsTrigger
              value="config"
              className="h-8 cursor-pointer rounded-lg px-4 text-xs font-medium sm:text-sm"
            >
              {t("dashboard.settings.webdav.configTab")}
            </TabsTrigger>
            <TabsTrigger
              value="history"
              className="h-8 cursor-pointer rounded-lg px-4 text-xs font-medium sm:text-sm"
            >
              <History className="mr-1.5 size-3.5" />
              {t("dashboard.settings.webdav.historyTab")}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="config" className="mt-5 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="webdav-server" className="text-xs text-muted-foreground">
                {t("dashboard.settings.webdav.serverUrl")}
              </Label>
              <Input
                id="webdav-server"
                value={config.serverUrl}
                onChange={(event) => updateField("serverUrl", event.target.value)}
                placeholder={t("dashboard.settings.webdav.serverUrlPlaceholder")}
                disabled={!hydrated || busy !== null}
                autoComplete="off"
                spellCheck={false}
                className="h-10 rounded-xl bg-background/80"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="webdav-username" className="text-xs text-muted-foreground">
                {t("dashboard.settings.webdav.username")}
              </Label>
              <Input
                id="webdav-username"
                value={config.username}
                onChange={(event) => updateField("username", event.target.value)}
                placeholder={t("dashboard.settings.webdav.usernamePlaceholder")}
                disabled={!hydrated || busy !== null}
                autoComplete="off"
                className="h-10 rounded-xl bg-background/80"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="webdav-password" className="text-xs text-muted-foreground">
                {t("dashboard.settings.webdav.password")}
              </Label>
              <div className="relative">
                <Input
                  id="webdav-password"
                  type={showPassword ? "text" : "password"}
                  value={config.password}
                  onChange={(event) => updateField("password", event.target.value)}
                  placeholder={t("dashboard.settings.webdav.passwordPlaceholder")}
                  disabled={!hydrated || busy !== null}
                  autoComplete="new-password"
                  className="h-10 rounded-xl bg-background/80 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground/70 transition-colors hover:text-foreground"
                  tabIndex={-1}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="webdav-folder" className="text-xs text-muted-foreground">
                {t("dashboard.settings.webdav.folder")}
              </Label>
              <Input
                id="webdav-folder"
                value={config.folder}
                onChange={(event) => updateField("folder", event.target.value)}
                placeholder={t("dashboard.settings.webdav.folderPlaceholder")}
                disabled={!hydrated || busy !== null}
                autoComplete="off"
                spellCheck={false}
                className="h-10 rounded-xl bg-background/80"
              />
            </div>
          </div>

          {testMessage && (
            <p
              className={cn(
                "text-xs leading-relaxed",
                testState === "ok"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-destructive"
              )}
            >
              {testMessage}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={handleTest}
              variant="outline"
              disabled={!hydrated || busy !== null}
              className="h-10 cursor-pointer rounded-xl px-4 text-xs font-medium sm:text-sm"
            >
              <PlugZap className="mr-2 size-3.5" />
              {t("dashboard.settings.webdav.test")}
            </Button>
            <Button
              type="button"
              onClick={() => handlePush()}
              disabled={!hydrated || busy !== null}
              className="h-10 cursor-pointer rounded-xl px-4 text-xs font-medium shadow-xs hover:opacity-90 sm:text-sm"
            >
              <CloudUpload className="mr-2 size-3.5" />
              {t("dashboard.settings.webdav.push")}
            </Button>
            <Button
              type="button"
              onClick={handlePull}
              variant="outline"
              disabled={!hydrated || busy !== null}
              className="h-10 cursor-pointer rounded-xl px-4 text-xs font-medium sm:text-sm"
            >
              <CloudDownload className="mr-2 size-3.5" />
              {t("dashboard.settings.webdav.pull")}
            </Button>
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            {t("dashboard.settings.webdav.localOnlyHint")}
          </p>
        </TabsContent>

        <TabsContent value="history" className="mt-5 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground sm:text-sm">
              {t("dashboard.settings.webdav.historyHint")}
            </p>
            <button
              type="button"
              onClick={refreshBackups}
              disabled={busy !== null}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-xs font-medium text-primary transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={cn("size-3", backupsLoading && "animate-spin")} />
              {t("dashboard.settings.webdav.refresh")}
            </button>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-background/50 p-3.5 dark:bg-secondary/20">
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground sm:text-sm">
                {t("dashboard.settings.webdav.limitLabel")}
              </p>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t("dashboard.settings.webdav.limitHint")}
              </p>
            </div>
            <Input
              type="number"
              min={5}
              max={50}
              value={historyLimitInput}
              onChange={(event) => setHistoryLimitInput(event.target.value)}
              onBlur={commitHistoryLimit}
              disabled={!hydrated || busy !== null}
              className="h-9 w-20 shrink-0 rounded-lg bg-background/80 text-center"
            />
          </div>

          <div className="space-y-2">
            {backups === null ? (
              <div className="rounded-xl border border-dashed border-border/80 px-4 py-10 text-center">
                <p className="text-xs text-muted-foreground">
                  {t("dashboard.settings.webdav.emptyHint")}
                </p>
              </div>
            ) : backups.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/80 px-4 py-10 text-center">
                <p className="text-xs font-medium text-muted-foreground">
                  {t("dashboard.settings.webdav.emptyTitle")}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground/80">
                  {t("dashboard.settings.webdav.emptyHint")}
                </p>
              </div>
            ) : (
              backups.map((entry) => {
                const time = formatTime(entry.timestamp);
                const size = formatBackupSize(entry.size);
                return (
                  <div
                    key={entry.fileName}
                    className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-background/60 px-3.5 py-2.5 dark:bg-secondary/20"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-foreground">{time}</p>
                      <p className="truncate text-[11px] text-muted-foreground/80">
                        {size ?? entry.fileName}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => setPendingRestore(entry)}
                        className="h-8 cursor-pointer rounded-lg px-2.5 text-[11px]"
                      >
                        <RotateCcw className="mr-1 size-3" />
                        {t("dashboard.settings.webdav.restore")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={busy !== null}
                        onClick={() => setPendingDelete(entry)}
                        aria-label={t("dashboard.settings.webdav.delete")}
                        className="h-8 w-8 shrink-0 cursor-pointer rounded-lg text-muted-foreground hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </TabsContent>
      </Tabs>

      <AlertDialog open={conflictTime !== null} onOpenChange={(open) => !open && setConflictTime(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dashboard.settings.webdav.pushConflictTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dashboard.settings.webdav.pushConflict", { time: conflictTime ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">
              {t("dashboard.settings.webdav.pushConflictCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="cursor-pointer"
              onClick={() => {
                setConflictTime(null);
                handlePush(true);
              }}
            >
              {t("dashboard.settings.webdav.pushConflictConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={pendingRestore !== null} onOpenChange={(open) => !open && setPendingRestore(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dashboard.settings.webdav.restoreConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dashboard.settings.webdav.restoreConfirm", { time: restoreConfirmTime })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">
              {t("dashboard.settings.webdav.pushConflictCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="cursor-pointer"
              onClick={() => {
                void confirmRestore();
              }}
            >
              {t("dashboard.settings.webdav.restore")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dashboard.settings.webdav.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dashboard.settings.webdav.deleteConfirm", { time: deleteConfirmTime })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">
              {t("dashboard.settings.webdav.pushConflictCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="cursor-pointer bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                void confirmDelete();
              }}
            >
              {t("dashboard.settings.webdav.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
};

export default WebDAVSettings;
