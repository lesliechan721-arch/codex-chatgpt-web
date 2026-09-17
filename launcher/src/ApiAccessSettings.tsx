import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { Language } from "./types";
import type { ApiAccessMode, ApiAccessResult, ApiAccessStatus } from "./api-access-types";
import "./api-access.css";

const text = {
  en: {
    title: "API access", toggle: "Standalone API Key mode",
    description: "Only ChatGPT Web models; native OpenAI requests are not forwarded. ChatGPT browser sign-in and MCP tunnel credentials remain separate.",
    saved: "Saved mode", running: "Running mode", openai: "OpenAI passthrough", api: "Local API Key",
    unknown: "Not verified", fresh: "Initialize the Launcher runtime before connecting a client.",
    stopped: "The runtime is stopped or unreachable. Apply to start and verify it.",
    pending: "Saved settings differ from the running daemon (or the daemon is too old to verify). Apply to restart; the old policy remains active until then.",
    synced: "The running daemon has loaded the saved policy.",
    invalid: "API access configuration is invalid. No fallback was enabled. Repair api-access.json explicitly before continuing.",
    external: "This runtime is externally managed. Use its CLI configuration and restart flow.",
    key: "New client API key", placeholder: "Leave blank to keep the configured key",
    keyHint: "32–256 letters, digits, hyphens or underscores. Existing keys cannot be recovered; only their SHA-256 digest is stored.",
    generate: "Generate random key", show: "Show", hide: "Hide", copy: "Copy key",
    savedKey: "I have saved the new key outside this application.",
    once: "The new key is cleared from this form after a successful save or when leaving Settings.",
    clipboard: "Copied. The clipboard is cleared after 60 seconds only if it still contains this key; clipboard history may retain copies.",
    apply: "Apply and restart", save: "Save for first startup", working: "Applying…", refresh: "Reload saved settings",
    applied: "Saved and verified.", staged: "Saved. The policy will be loaded when the runtime is initialized.",
    cancelled: "No changes were made.", url: "Service base URL", copyUrl: "Copy URL",
    export: "Export and copy Codex config", exported: "Codex config copied; no API key is included.",
    client: "Set CODEX_CHATGPT_WEB_API_KEY in the Codex process environment. Exported TOML uses requires_openai_auth = false and a local model catalog. Existing Codex config/auth files are not overwritten.",
    restore: "Turning this off restores native forwarding. Restore the client's previous provider/auth configuration yourself.",
    unavailable: "The operation could not be verified. Reload settings and inspect the runtime before retrying.",
    errors: {
      "invalid-key": "The key must contain 32–256 ASCII letters, digits, underscores or hyphens.",
      "key-required": "Set or generate a key before enabling this mode.",
      "control-key-reuse": "The client key must differ from the daemon management token.",
      "stale-settings": "Settings changed elsewhere. Reload saved settings before retrying.",
      "runtime-busy": "Finish active tasks and other Launcher operations before changing access settings.",
      "external-runtime": "This runtime is managed outside the Launcher; use its CLI configuration.",
      "stop-failed": "The runtime could not be safely drained/stopped. The access file was not changed.",
      "apply-failed-restored": "The new settings failed verification. The previous policy was restored and verified.",
      "saved-runtime-unverified": "The new policy is saved, but the runtime state could not be verified. Do not assume the old key is revoked.",
      "recovery-failed": "Automatic recovery could not be verified. Inspect saved/running status before retrying; neither policy is claimed active.",
      "export-failed": "Configuration export failed. Confirm the runtime bundle includes API Key support.",
      "not-configured": "Initialize the Launcher runtime first.",
      "api-mode-required": "Enable API Key mode before exporting its client configuration.",
      "invalid-policy": "The access file is invalid; automatic fallback is disabled.",
    } as Record<string, string>,
  },
  zh: {
    title: "API 接入", toggle: "独立 API Key 模式",
    description: "只提供 ChatGPT Web 模型，不转发原生 OpenAI 请求。浏览器的 ChatGPT 登录和 MCP Tunnel 凭证仍然独立。",
    saved: "已保存模式", running: "后台生效模式", openai: "OpenAI 转发", api: "本地 API Key",
    unknown: "尚未验证", fresh: "需要先初始化 Launcher 运行时，客户端才能连接。",
    stopped: "运行时已停止或不可达。点击应用以启动并验证。",
    pending: "保存的配置与后台不一致，或旧版本后台不支持验证。点击应用后受控重启；重启前旧策略仍然有效。",
    synced: "后台已加载当前保存的配置。",
    invalid: "API 接入配置无效，未自动降级。请显式修复 api-access.json 后继续。",
    external: "该运行时由 Launcher 以外的方式管理，请使用对应 CLI 配置和重启流程。",
    key: "新的客户端 API Key", placeholder: "留空保留已配置密钥",
    keyHint: "32–256 个英文字母、数字、短横线或下划线。只保存 SHA-256 摘要，无法读取旧密钥。",
    generate: "随机生成密钥", show: "显示", hide: "隐藏", copy: "复制密钥",
    savedKey: "我已在应用之外保存这把新密钥。",
    once: "成功保存或离开设置页后，表单会清除新密钥。",
    clipboard: "已复制。60 秒后仅在剪贴板仍为此密钥时清除；剪贴板历史可能保留副本。",
    apply: "应用并重启", save: "保存，首次启动生效", working: "正在应用…", refresh: "重新载入已保存配置",
    applied: "已保存并验证生效。", staged: "已保存；初始化运行时后加载。", cancelled: "未修改配置。",
    url: "服务 Base URL", copyUrl: "复制地址", export: "导出并复制 Codex 配置", exported: "已复制 Codex 配置，不包含密钥。",
    client: "请在 Codex 进程环境中设置 CODEX_CHATGPT_WEB_API_KEY。导出的 TOML 使用 requires_openai_auth = false 和本地模型目录，不覆盖现有 Codex 配置或 auth 文件。",
    restore: "关闭此模式会恢复原生转发；请自行恢复客户端原有的 provider 和认证配置。",
    unavailable: "无法验证该操作。请重新载入配置并检查运行时，再重试。",
    errors: {
      "invalid-key": "密钥必须为 32–256 个英文字母、数字、短横线或下划线。",
      "key-required": "开启前需要设置或生成密钥。",
      "control-key-reuse": "客户端密钥不能与后台管理令牌相同。",
      "stale-settings": "配置已被其他操作修改，请重新载入后重试。",
      "runtime-busy": "请先完成活动任务或其他 Launcher 操作，再修改接入设置。",
      "external-runtime": "该运行时不由 Launcher 管理，请通过 CLI 配置。",
      "stop-failed": "未能确认运行时已安全排空并停止，未修改接入配置文件。",
      "apply-failed-restored": "新配置未通过验证，已恢复并验证原配置。",
      "saved-runtime-unverified": "新策略已保存，但无法确认后台状态，请勿认为旧密钥已经撤销。",
      "recovery-failed": "未能确认自动恢复成功。请检查保存配置和后台状态，当前不声称任一策略已生效。",
      "export-failed": "配置导出失败，请确认运行时包包含 API Key 功能。",
      "not-configured": "请先初始化 Launcher 运行时。",
      "api-mode-required": "请先启用 API Key 模式，再导出客户端配置。",
      "invalid-policy": "接入配置文件无效，未自动降级。",
    } as Record<string, string>,
  },
};

export function ApiAccessSettings({ language }: { language: Language }) {
  const copy = text[language.startsWith("zh") ? "zh" : "en"];
  const api = window.codexWebLauncher!;
  const [status, setStatus] = useState<ApiAccessStatus | null>(null);
  const [mode, setMode] = useState<ApiAccessMode>("openai");
  const [draftRevision, setDraftRevision] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<"clipboard" | "applied" | "staged" | "cancelled" | "exported" | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const locked = useRef(false);
  const mounted = useRef(false);

  function value<T>(result: ApiAccessResult<T>): T {
    if (!result.ok) throw new Error(result.code);
    return result.value;
  }
  function adopt(next: ApiAccessStatus, reset: boolean) {
    if (!mounted.current) return;
    setStatus(next);
    if (reset) {
      setDraftRevision(next.revision);
      setMode(next.configuredMode === "api-key" ? "api-key" : "openai");
      setKey(""); setKeySaved(false); setShowKey(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    let generation = 0;
    const load = (reset: boolean) => {
      const request = ++generation;
      void api.apiAccessStatus().then(result => {
        if (mounted.current && request === generation && !locked.current) adopt(value(result), reset);
      }).catch(() => { if (mounted.current) setErrorCode("unavailable"); });
    };
    load(true);
    const focus = () => load(false);
    window.addEventListener("focus", focus);
    return () => { mounted.current = false; generation++; window.removeEventListener("focus", focus); };
  }, [api]);

  async function perform(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setErrorCode(null); setNotice(null);
    try { await action(); }
    catch (error) {
      if (mounted.current) setErrorCode(error instanceof Error ? error.message : "unavailable");
      try { adopt(value(await api.apiAccessStatus()), false); } catch {}
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const keyValid = /^[A-Za-z0-9_-]{32,256}$/.test(key);
  const needsKey = mode === "api-key" && !status?.keyConfigured;
  const hasNewKey = mode === "api-key" && key.length > 0;
  const canSave = status?.canApply && draftRevision && !busy
    && (!needsKey || keyValid) && (!hasNewKey || (keyValid && keySaved));
  const label = (selected: ApiAccessMode | "invalid" | null) => selected === "api-key" ? copy.api
    : selected === "openai" ? copy.openai : copy.unknown;
  const stateMessage = !status ? copy.unknown : status.configuredMode === "invalid" ? copy.invalid
    : !status.canApply ? copy.external : status.runtimeState === "unconfigured" ? copy.fresh
      : status.runtimeState === "in-sync" ? copy.synced
        : status.runtimeState === "stopped" ? copy.stopped : copy.pending;

  return <section className="api-access-settings" aria-labelledby="api-access-title">
    <h2 id="api-access-title">{copy.title}</h2>
    <p>{copy.description}</p>
    <div className="api-access-toggle">
      <label id="api-access-mode-label">{copy.toggle}</label>
      <button type="button" role="switch" aria-checked={mode === "api-key"}
        aria-labelledby="api-access-mode-label" disabled={busy || !status?.canApply}
        onClick={() => { setMode(mode === "api-key" ? "openai" : "api-key"); setKey(""); setKeySaved(false); setNotice(null); }}>
        {mode === "api-key" ? copy.api : copy.openai}
      </button>
    </div>
    <dl className="api-access-status">
      <div><dt>{copy.saved}</dt><dd>{label(status?.configuredMode ?? null)}</dd></div>
      <div><dt>{copy.running}</dt><dd>{label(status?.effectiveMode ?? null)}</dd></div>
    </dl>
    <p role="status">{stateMessage}</p>
    {mode === "api-key" ? <fieldset disabled={busy || !status?.canApply}>
      <label htmlFor="api-access-key">{copy.key}</label>
      <input id="api-access-key" name="local-api-key" type={showKey ? "text" : "password"}
        value={key} autoComplete="new-password" spellCheck={false} autoCapitalize="none"
        maxLength={256} placeholder={status?.keyConfigured ? copy.placeholder : "cgw_…"}
        aria-describedby="api-access-key-hint"
        onChange={(event: ChangeEvent<HTMLInputElement>) => { setKey(event.target.value); setKeySaved(false); setNotice(null); }} />
      <small id="api-access-key-hint">{copy.keyHint}</small>
      <div className="api-access-actions">
        <button type="button" onClick={() => void perform(async () => {
          const next = value(await api.apiAccessGenerate());
          if (mounted.current) { setKey(next); setKeySaved(false); setShowKey(false); }
        })}>{copy.generate}</button>
        <button type="button" disabled={!key} onClick={() => setShowKey(!showKey)}>{showKey ? copy.hide : copy.show}</button>
        <button type="button" disabled={!keyValid} onClick={() => void perform(async () => {
          value(await api.apiAccessCopyKey(key));
          if (mounted.current) setNotice("clipboard");
        })}>{copy.copy}</button>
      </div>
      {hasNewKey ? <label className="api-access-ack">
        <input type="checkbox" checked={keySaved} onChange={(event: ChangeEvent<HTMLInputElement>) => setKeySaved(event.target.checked)} />
        {copy.savedKey}
      </label> : null}
      <small>{copy.once}</small>
    </fieldset> : <p>{copy.restore}</p>}
    <div className="api-access-actions">
      <button type="button" disabled={!canSave} onClick={() => void perform(async () => {
        const result = value(await api.apiAccessApply({ mode, expectedRevision: draftRevision!, ...(hasNewKey ? { key } : {}) }));
        adopt(result.status, !result.cancelled);
        if (mounted.current) setNotice(result.cancelled ? "cancelled"
          : result.status.runtimeState === "unconfigured" ? "staged"
            : result.status.runtimeState === "in-sync" ? "applied" : null);
      })}>{busy ? copy.working : status?.runtimeState === "unconfigured" ? copy.save : copy.apply}</button>
      <button type="button" disabled={busy} onClick={() => void perform(async () => {
        adopt(value(await api.apiAccessStatus()), true);
      })}>{copy.refresh}</button>
    </div>
    {status?.baseUrl ? <div className="api-access-client">
      <label>{copy.url}</label><code>{status.baseUrl}</code>
      <div className="api-access-actions">
        <button type="button" disabled={busy} onClick={() => void perform(async () => { value(await api.apiAccessCopyUrl()); })}>{copy.copyUrl}</button>
        <button type="button" disabled={busy || status.configuredMode !== "api-key"} onClick={() => void perform(async () => {
          const result = value(await api.apiAccessExport());
          if (mounted.current) { setExported(result.config); setNotice("exported"); }
        })}>{copy.export}</button>
      </div>
      <p>{copy.client}</p>
      {exported ? <pre tabIndex={0}>{exported}</pre> : null}
    </div> : null}
    {notice ? <p role="status">{copy[notice]}</p> : null}
    {errorCode ? <p className="api-access-error" role="alert">{copy.errors[errorCode] ?? copy.unavailable}</p> : null}
  </section>;
}
