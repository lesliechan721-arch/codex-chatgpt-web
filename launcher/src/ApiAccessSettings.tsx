import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Language } from "./types";
import type {
  ApiAccessMode,
  ApiAccessResult,
  ApiAccessStatus,
  UpstreamModelFilter,
  UpstreamProxy,
} from "./api-access-types";
import {
  filterModelCandidates,
  retainSelectedModelCandidates,
} from "./api-access-model-selection";
import {
  recoverApiAccessActionFailure,
  shouldShowUpstreamMissingKey,
  type ActionFailureRecovery,
} from "./api-access-renderer-state";
import "./api-access.css";

const labels = {
  zh: {
    title: "接入模式", openai: "OpenAI 转发", api: "API Key",
    description: "API Key 模式默认只处理 ChatGPT Web 模型；配置自定义上游后，可混合转发其它 OpenAI 兼容模型。切换后自动保存并尝试重启后台。",
    firstKey: "先设置 API Key，再启用此模式", reset: "重置密钥", key: "API Key",
    hint: "32–256 个英文字母、数字、短横线或下划线。",
    generate: "随机生成", enable: "保存并切换", update: "更新密钥", cancel: "取消",
    show: "查看", hide: "隐藏", copy: "复制密钥", copied: "已复制。密钥剪贴板在 60 秒后按需清除。",
    saved: "已保存并生效。", pending: "配置已保存，后台尚未加载。当前生效模式：",
    unknown: "未确认", retry: "重试重启", refresh: "刷新状态", busy: "正在处理…",
    legacy: "当前密钥无法查看，但仍可用于认证。旧版摘要密钥需重置；已加密的密钥可先尝试解锁系统密钥库。",
    session: "系统加密存储不可用，新密钥仅在本次 Launcher 会话中可查看。请自行备份；认证摘要已保存。",
    routing: "模式已保存，但 OpenAI 路由未能恢复。请检查配置冲突后重试或重新初始化。",
    cleanup: "配置已保存，但旧的 Codex 注入尚未清理，请重试或检查配置冲突。不会覆盖手动修改。",
    url: "服务 Base URL", copyUrl: "复制地址", copyConfig: "复制 Codex 配置", exportConfig: "导出 TOML",
    exported: "敏感配置已生成，包含本地 API Key。", preview: "查看导出的敏感配置",
    client: "Codex 配置通过 experimental_bearer_token 包含本地 API Key；不会自动写入 Codex 配置或认证文件。代理启动环境与 TOML 分开显示。",
    processEnv: "Codex 启动环境",
    upstreamTitle: "OpenAI 兼容上游", upstreamBase: "上游 Base URL", upstreamKey: "上游 API Key",
    upstreamKeyHint: "留空可复用当前可恢复的上游密钥。密钥不会返回到 Renderer。",
    proxyMode: "上游代理", proxyGlobal: "使用全局代理", proxyDirect: "不使用代理", proxyCustom: "单独代理",
    proxyUrl: "单独代理 URL", filterMode: "模型筛选", filterAll: "全部模型", filterRegex: "正则筛选", filterSelected: "手动选择",
    regex: "模型 ID 正则", fetchModels: "获取模型", modelSearch: "搜索模型", saveUpstream: "保存上游", deleteUpstream: "删除上游",
    compaction: "上游支持 OpenAI Responses compaction_trigger（remote compaction v2）",
    compactionHint: "仅当上游真实兼容服务端 compaction_trigger 协议时启用。",
    upstreamMissingKey: "已保存上游配置，但当前会话无法恢复上游密钥。请重新输入并保存。",
    upstreamReady: "上游已加载。", upstreamPending: "上游已保存，等待后台加载。",
    unconfigured: "配置已保存；初始化运行时后生效。", invalid: "接入配置无效，请修复 api-access.json。",
    failed: "操作未完成，请刷新状态后重试。", errors: {
      "invalid-key": "密钥格式不正确。", "key-required": "请先填写或生成密钥。",
      "key-unavailable": "无法解密此密钥，请解锁系统密钥库或重置。",
      "stale-settings": "配置已在其他位置修改，请刷新后重试。",
      "control-key-reuse": "API Key 不能与后台管理令牌相同。",
      "save-failed": "无法保存配置，请检查文件权限。", "runtime-busy": "另一个设置操作正在执行。",
      "not-configured": "请先初始化运行时。", "export-failed": "配置导出失败。",
      "invalid-upstream-config": "上游 Base URL 无效。", "invalid-upstream-filter": "模型筛选配置无效。",
      "invalid-upstream-proxy": "上游代理配置无效。", "invalid-upstream-key": "上游 API Key 无效。",
      "upstream-key-required": "请输入上游 API Key，或先解锁可恢复的已保存密钥。",
      "upstream-fetch-failed": "获取上游模型失败。请检查地址、密钥和代理。",
    } as Record<string, string>,
  },
  en: {
    title: "Access mode", openai: "OpenAI forwarding", api: "API Key",
    description: "API Key mode serves ChatGPT Web models by default. An optional OpenAI-compatible upstream can add non-Web models. Switching saves immediately and attempts a runtime restart.",
    firstKey: "Set an API key to enable this mode", reset: "Reset key", key: "API key",
    hint: "32–256 ASCII letters, digits, hyphens or underscores.",
    generate: "Generate", enable: "Save and switch", update: "Update key", cancel: "Cancel",
    show: "Show", hide: "Hide", copy: "Copy key", copied: "Copied. The key clipboard is conditionally cleared after 60 seconds.",
    saved: "Saved and active.", pending: "Saved; the runtime has not loaded this setting. Currently active: ",
    unknown: "Unverified", retry: "Retry restart", refresh: "Refresh status", busy: "Working…",
    legacy: "This key is not available for viewing but still authenticates. Reset a legacy digest-only key, or unlock the OS key store for an encrypted key.",
    session: "OS encryption is unavailable. This key can be viewed only during this Launcher session. Back it up; its authentication digest is saved.",
    routing: "Mode saved, but the OpenAI route could not be restored. Resolve conflicting settings and retry or run setup.",
    cleanup: "Saved, but previous Codex injection still needs cleanup. Retry or inspect conflicting edits; manual changes are not overwritten.",
    url: "Service Base URL", copyUrl: "Copy URL", copyConfig: "Copy Codex config", exportConfig: "Export TOML",
    exported: "Sensitive configuration generated with the local API key.", preview: "View sensitive exported configuration",
    client: "The Codex provider uses experimental_bearer_token with the local API key. Nothing is written automatically to Codex config or authentication files. Process proxy environment is shown separately from TOML.",
    processEnv: "Codex process environment",
    upstreamTitle: "OpenAI-compatible upstream", upstreamBase: "Upstream Base URL", upstreamKey: "Upstream API key",
    upstreamKeyHint: "Leave blank to reuse the currently recoverable upstream key. The saved key is never returned to the Renderer.",
    proxyMode: "Upstream proxy", proxyGlobal: "Use global proxy", proxyDirect: "Direct", proxyCustom: "Custom proxy",
    proxyUrl: "Custom proxy URL", filterMode: "Model filter", filterAll: "All models", filterRegex: "Regex", filterSelected: "Manual selection",
    regex: "Model ID regex", fetchModels: "Fetch models", modelSearch: "Search models", saveUpstream: "Save upstream", deleteUpstream: "Delete upstream",
    compaction: "Upstream supports OpenAI Responses compaction_trigger (remote compaction v2)",
    compactionHint: "Enable only when the upstream really implements the server-side compaction_trigger protocol.",
    upstreamMissingKey: "The upstream configuration is saved, but its key cannot be recovered in this session. Enter the key and save again.",
    upstreamReady: "Upstream is loaded.", upstreamPending: "Upstream is saved and waiting for the runtime to load it.",
    unconfigured: "Saved for the next runtime initialization.", invalid: "Invalid access configuration. Repair api-access.json.",
    failed: "The operation could not complete. Refresh status and retry.", errors: {
      "invalid-key": "Invalid API key format.", "key-required": "Enter or generate a key first.",
      "key-unavailable": "Cannot decrypt this key. Unlock the OS key store or reset it.",
      "stale-settings": "Settings changed elsewhere. Refresh and retry.",
      "control-key-reuse": "The API key must differ from the daemon management token.",
      "save-failed": "Could not save the configuration. Check file permissions.", "runtime-busy": "Another settings operation is running.",
      "not-configured": "Initialize the runtime first.", "export-failed": "Configuration export failed.",
      "invalid-upstream-config": "Invalid upstream Base URL.", "invalid-upstream-filter": "Invalid model filter.",
      "invalid-upstream-proxy": "Invalid upstream proxy configuration.", "invalid-upstream-key": "Invalid upstream API key.",
      "upstream-key-required": "Enter the upstream API key or unlock the recoverable saved key first.",
      "upstream-fetch-failed": "Could not fetch upstream models. Check the URL, key and proxy.",
    } as Record<string, string>,
  },
};

function value<T>(result: ApiAccessResult<T>): T {
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

export function ApiAccessSettings({ language }: { language: Language }) {
  const copy = labels[language.startsWith("zh") ? "zh" : "en"];
  const api = window.codexWebLauncher!;
  const [status, setStatus] = useState<ApiAccessStatus | null>(null);
  const [editor, setEditor] = useState<{ revision: string; enabling: boolean } | null>(null);
  const [draft, setDraft] = useState("");
  const [visibleKey, setVisibleKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [configText, setConfigText] = useState<string | null>(null);
  const [environmentText, setEnvironmentText] = useState<string | null>(null);
  const [upstreamBaseUrl, setUpstreamBaseUrl] = useState("");
  const [upstreamKey, setUpstreamKey] = useState("");
  const [proxyMode, setProxyMode] = useState<UpstreamProxy["mode"]>("global");
  const [proxyUrl, setProxyUrl] = useState("");
  const [filterMode, setFilterMode] = useState<UpstreamModelFilter["mode"]>("all");
  const [regexPattern, setRegexPattern] = useState("");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [candidateModels, setCandidateModels] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState("");
  const [serverCompaction, setServerCompaction] = useState(false);
  const mounted = useRef(false);
  const locked = useRef(false);
  const generation = useRef(0);
  const visibility = useRef(0);
  const isApi = status?.configuredMode === "api-key";
  const keyValid = /^[A-Za-z0-9_-]{32,256}$/.test(draft);
  const regexValid = (() => {
    if (filterMode !== "regex" || regexPattern.length > 512) return filterMode !== "regex";
    try { new RegExp(regexPattern); return true; } catch { return false; }
  })();

  function adopt(next: ApiAccessStatus) {
    if (!mounted.current) return;
    setStatus(next);
    setVisibleKey(null);
    const upstream = next.upstream;
    setUpstreamBaseUrl(upstream?.baseUrl ?? "");
    setUpstreamKey("");
    setProxyMode(upstream?.proxy?.mode ?? "global");
    setProxyUrl(upstream?.proxy?.mode === "custom" ? upstream.proxy.url : "");
    setFilterMode(upstream?.modelFilter?.mode ?? "all");
    setRegexPattern(upstream?.modelFilter?.mode === "regex" ? upstream.modelFilter.pattern : "");
    setSelectedModels(upstream?.modelFilter?.mode === "selected" ? upstream.modelFilter.models : []);
    setCandidateModels(upstream?.modelFilter?.mode === "selected" ? upstream.modelFilter.models : []);
    setServerCompaction(upstream?.supportsOpenAiServerCompaction === true);
    visibility.current++;
  }
  useEffect(() => {
    mounted.current = true;
    const load = () => {
      if (locked.current) return;
      const request = ++generation.current;
      void api.apiAccessStatus().then(result => {
        if (mounted.current && request === generation.current && !locked.current) adopt(value(result));
      }).catch(() => { if (mounted.current) setError("unavailable"); });
    };
    const hide = () => { visibility.current++; setVisibleKey(null); };
    load();
    window.addEventListener("focus", load);
    window.addEventListener("blur", hide);
    return () => {
      mounted.current = false; generation.current++; visibility.current++;
      window.removeEventListener("focus", load); window.removeEventListener("blur", hide);
    };
  }, [api]);

  async function perform(action: () => Promise<void>, recovery: ActionFailureRecovery = "refresh-status") {
    if (locked.current) return;
    locked.current = true; generation.current++; setBusy(true); setError(null); setNotice(null);
    try { await action(); }
    catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "unavailable");
      await recoverApiAccessActionFailure(recovery, async () => adopt(value(await api.apiAccessStatus())));
    } finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  function edit(enabling: boolean) {
    if (!status?.revision) return;
    setEditor({ revision: status.revision, enabling }); setDraft(""); setVisibleKey(null);
    visibility.current++; setError(null); setNotice(null);
  }
  async function save(mode: ApiAccessMode, key?: string) {
    const revision = key !== undefined ? editor?.revision : status?.revision;
    if (!revision) return;
    const result = value(await api.apiAccessApply({ mode, expectedRevision: revision, ...(key !== undefined ? { key } : {}) }));
    adopt(result.status);
    if (mounted.current) { setEditor(null); setDraft(""); setConfigText(null); setEnvironmentText(null); }
  }
  function switchMode(mode: ApiAccessMode) {
    if (busy || mode === status?.configuredMode) return;
    if (mode === "api-key" && !status?.keyConfigured && !status?.keyAvailable) { edit(true); return; }
    setEditor(null); setDraft("");
    void perform(async () => {
      try { await save(mode); }
      catch (cause) {
        if (mode === "api-key" && cause instanceof Error && cause.message === "key-required") edit(true);
        throw cause;
      }
    });
  }
  function submit(event: FormEvent) { event.preventDefault(); if (keyValid) void perform(() => save("api-key", draft)); }
  async function exportConfig(download: boolean) {
    const result = value(await api.apiAccessExport());
    if (download) {
      const url = URL.createObjectURL(new Blob([result.config], { type: "text/plain;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url; link.download = "codex-api-key.toml"; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    if (mounted.current) {
      setConfigText(result.config);
      setEnvironmentText(Object.entries(result.environment).map(([key, item]) => `${key}=${item}`).join("\n"));
      setNotice(copy.exported);
    }
  }
  const draftProxy = (): UpstreamProxy => proxyMode === "custom"
    ? { mode: "custom", url: proxyUrl }
    : { mode: proxyMode };
  const draftFilter = (): UpstreamModelFilter => filterMode === "regex"
    ? { mode: "regex", pattern: regexPattern }
    : filterMode === "selected" ? { mode: "selected", models: selectedModels } : { mode: "all" };
  async function saveUpstream() {
    if (!status?.revision) return;
    const result = value(await api.apiAccessUpstreamSave({
      expectedRevision: status.revision,
      baseUrl: upstreamBaseUrl,
      ...(upstreamKey ? { apiKey: upstreamKey } : {}),
      proxy: draftProxy(),
      modelFilter: draftFilter(),
      supportsOpenAiServerCompaction: serverCompaction,
    }));
    adopt(result.status);
  }
  const pending = status?.runtimeState === "restart-required" || status?.runtimeState === "stopped";
  return <section className="api-access-settings" aria-labelledby="api-access-title">
    <h2 id="api-access-title">{copy.title}</h2><p>{copy.description}</p>
    <div className="api-access-modes" role="group" aria-label={copy.title}>
      {(["openai", "api-key"] as const).map(mode => <button type="button" key={mode}
        aria-pressed={status?.configuredMode === mode} disabled={busy || !status?.canApply}
        onClick={() => switchMode(mode)}>{mode === "openai" ? copy.openai : copy.api}</button>)}
    </div>
    {editor ? <form onSubmit={submit} className="api-access-editor">
      <label htmlFor="api-access-new-key">{editor.enabling ? copy.firstKey : copy.reset}</label>
      <input id="api-access-new-key" type="password" value={draft} autoComplete="new-password"
        spellCheck={false} autoCapitalize="none" maxLength={256} disabled={busy}
        onChange={event => setDraft(event.target.value)} aria-describedby="api-access-key-hint" />
      <small id="api-access-key-hint">{copy.hint}</small>
      <div className="api-access-actions">
        <button type="button" disabled={busy} onClick={() => void perform(async () => {
          const key = value(await api.apiAccessGenerate()); if (mounted.current) setDraft(key);
        })}>{copy.generate}</button>
        <button type="submit" disabled={busy || !keyValid}>{editor.enabling ? copy.enable : copy.update}</button>
        <button type="button" disabled={busy} onClick={() => { setEditor(null); setDraft(""); }}>{copy.cancel}</button>
      </div>
    </form> : null}
    {isApi ? <div className="api-access-client">
      <label>{copy.key}</label>
      <code className="api-access-secret">{visibleKey ?? "••••••••••••••••••••••••••••••••"}</code>
      <div className="api-access-actions">
        <button type="button" disabled={busy || !status.keyAvailable} onClick={() => {
          if (visibleKey !== null) { setVisibleKey(null); visibility.current++; return; }
          const view = ++visibility.current;
          void perform(async () => {
            const key = value(await api.apiAccessReveal());
            if (mounted.current && view === visibility.current) setVisibleKey(key);
          });
        }}>{visibleKey !== null ? copy.hide : copy.show}</button>
        <button type="button" disabled={busy || !status.keyAvailable} onClick={() => void perform(async () => {
          const key = value(await api.apiAccessReveal()); value(await api.apiAccessCopyKey(key));
          if (mounted.current) setNotice(copy.copied);
        })}>{copy.copy}</button>
        <button type="button" disabled={busy} onClick={() => edit(false)}>{copy.reset}</button>
      </div>
      {!status.keyAvailable ? <small>{copy.legacy}</small> : status.keyStorage === "session" ? <small>{copy.session}</small> : null}
      <label>{copy.url}</label><code>{status.baseUrl ?? copy.unconfigured}</code>
      <div className="api-access-actions">
        <button type="button" disabled={busy || !status.baseUrl} onClick={() => void perform(async () => {
          value(await api.apiAccessCopyUrl());
        })}>{copy.copyUrl}</button>
        <button type="button" disabled={busy || !status.baseUrl} onClick={() => void perform(() => exportConfig(false))}>{copy.copyConfig}</button>
        <button type="button" disabled={busy || !status.baseUrl} onClick={() => void perform(() => exportConfig(true))}>{copy.exportConfig}</button>
      </div>
      <p>{copy.client}</p>
      {configText ? <details><summary>{copy.preview}</summary><pre tabIndex={0}>{configText}</pre>
        <label>{copy.processEnv}</label><pre tabIndex={0}>{environmentText}</pre></details> : null}
      <div className="api-access-upstream">
        <h3>{copy.upstreamTitle}</h3>
        <label htmlFor="api-upstream-base">{copy.upstreamBase}</label>
        <input id="api-upstream-base" value={upstreamBaseUrl} disabled={busy} spellCheck={false}
          placeholder="https://provider.example/v1" onChange={event => setUpstreamBaseUrl(event.target.value)} />
        <label htmlFor="api-upstream-key">{copy.upstreamKey}</label>
        <input id="api-upstream-key" type="password" value={upstreamKey} disabled={busy} autoComplete="new-password"
          maxLength={4096} spellCheck={false} onChange={event => setUpstreamKey(event.target.value)} />
        <small>{copy.upstreamKeyHint}</small>
        {shouldShowUpstreamMissingKey(status) ? <small className="api-access-warning">{copy.upstreamMissingKey}</small> : null}
        <label htmlFor="api-upstream-proxy-mode">{copy.proxyMode}</label>
        <select id="api-upstream-proxy-mode" value={proxyMode} disabled={busy}
          onChange={event => setProxyMode(event.target.value as UpstreamProxy["mode"])}>
          <option value="global">{copy.proxyGlobal}</option><option value="direct">{copy.proxyDirect}</option>
          <option value="custom">{copy.proxyCustom}</option>
        </select>
        {proxyMode === "custom" ? <><label htmlFor="api-upstream-proxy-url">{copy.proxyUrl}</label>
          <input id="api-upstream-proxy-url" value={proxyUrl} disabled={busy} spellCheck={false}
            placeholder="http://user:password@proxy.example:8080" onChange={event => setProxyUrl(event.target.value)} /></> : null}
        <label htmlFor="api-upstream-filter-mode">{copy.filterMode}</label>
        <select id="api-upstream-filter-mode" value={filterMode} disabled={busy}
          onChange={event => setFilterMode(event.target.value as UpstreamModelFilter["mode"])}>
          <option value="all">{copy.filterAll}</option><option value="regex">{copy.filterRegex}</option>
          <option value="selected">{copy.filterSelected}</option>
        </select>
        {filterMode === "regex" ? <><label htmlFor="api-upstream-regex">{copy.regex}</label>
          <input id="api-upstream-regex" value={regexPattern} disabled={busy} maxLength={512} spellCheck={false}
            onChange={event => setRegexPattern(event.target.value)} />
          {!regexValid ? <small className="api-access-error" role="alert">{copy.errors["invalid-upstream-filter"]}</small> : null}</> : null}
        {filterMode === "selected" ? <>
          <button type="button" disabled={busy || !upstreamBaseUrl} onClick={() => void perform(async () => {
            const result = value(await api.apiAccessUpstreamModels({
              baseUrl: upstreamBaseUrl,
              ...(upstreamKey ? { apiKey: upstreamKey } : {}),
              proxy: draftProxy(),
            }));
            if (mounted.current) setCandidateModels(retainSelectedModelCandidates(result.models, selectedModels));
          }, "preserve-draft")}>{copy.fetchModels}</button>
          <label htmlFor="api-upstream-model-search">{copy.modelSearch}</label>
          <input id="api-upstream-model-search" type="search" value={modelSearch} disabled={busy}
            onChange={event => setModelSearch(event.target.value)} />
          <div className="api-access-model-list">
            {filterModelCandidates(candidateModels, modelSearch).map(model => <label key={model}>
              <input type="checkbox" checked={selectedModels.includes(model)}
              disabled={busy} onChange={event => setSelectedModels(current => event.target.checked
                ? current.includes(model) ? current : [...current, model]
                : current.filter(item => item !== model))} />{model}</label>)}
          </div>
        </> : null}
        <label className="api-access-checkbox"><input type="checkbox" checked={serverCompaction} disabled={busy}
          onChange={event => setServerCompaction(event.target.checked)} />{copy.compaction}</label>
        <small>{copy.compactionHint}</small>
        <div className="api-access-actions">
          <button type="button" disabled={busy || !upstreamBaseUrl || !regexValid} onClick={() => void perform(saveUpstream)}>{copy.saveUpstream}</button>
          {status.upstream?.configured ? <button type="button" disabled={busy || !status.revision} onClick={() => void perform(async () => {
            const result = value(await api.apiAccessUpstreamDelete({ expectedRevision: status.revision! })); adopt(result.status);
          })}>{copy.deleteUpstream}</button> : null}
        </div>
        {status.upstream?.configured ? <small>{status.upstream.runtimeAvailable ? copy.upstreamReady : copy.upstreamPending}</small> : null}
      </div>
    </div> : null}
    <div role="status" aria-live="polite">
      {busy ? copy.busy : status?.runtimeState === "in-sync" ? copy.saved
        : status?.runtimeState === "unconfigured" ? copy.unconfigured
          : status?.runtimeState === "invalid" ? copy.invalid
            : pending ? copy.pending + (status?.effectiveMode === "api-key" ? copy.api
              : status?.effectiveMode === "openai" ? copy.openai : copy.unknown) : null}
    </div>
    {status?.routingPending ? <p className="api-access-warning">{copy.routing}</p> : null}
    {status?.cleanupPending ? <p className="api-access-warning">{copy.cleanup}</p> : null}
    <div className="api-access-actions">
      {pending || status?.cleanupPending || status?.routingPending ? <button type="button" disabled={busy || !status?.canApply}
        onClick={() => void perform(() => save(isApi ? "api-key" : "openai"))}>{copy.retry}</button> : null}
      <button type="button" disabled={busy} onClick={() => void perform(async () => {
        adopt(value(await api.apiAccessStatus())); setEditor(null); setDraft("");
      })}>{copy.refresh}</button>
    </div>
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <p role="alert" className="api-access-error">{copy.errors[error] ?? copy.failed}</p> : null}
  </section>;
}
