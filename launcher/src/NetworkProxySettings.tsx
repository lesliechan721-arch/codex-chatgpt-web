import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Language, LauncherState } from "./types";
import "./network-proxy.css";

const api = window.codexWebLauncher;

type ProxyCopy = {
  button: string;
  title: string;
  body: string;
  label: string;
  placeholder: string;
  system: string;
  custom: string;
  cancel: string;
  apply: string;
  applying: string;
  clear: string;
  note: string;
};

const COPY: Record<Language, ProxyCopy> = {
  en: {
    button: "Proxy",
    title: "Global network proxy",
    body: "Use one HTTP/HTTPS proxy for the embedded ChatGPT browser, Responses runtime, and MCP tunnel. Leave the field empty to use the system and inherited process defaults.",
    label: "Proxy URL",
    placeholder: "http://127.0.0.1:7890",
    system: "System / process defaults",
    custom: "Custom proxy enabled",
    cancel: "Cancel",
    apply: "Apply",
    applying: "Applying…",
    clear: "Use system default",
    note: "Localhost, 127.0.0.1, and ::1 always bypass the proxy so launcher control traffic stays local.",
  },
  "zh-CN": {
    button: "代理",
    title: "全局网络代理",
    body: "让内置 ChatGPT 浏览器、Responses 运行时和 MCP Tunnel 统一使用一个 HTTP/HTTPS 代理。留空则使用系统和进程继承的默认设置。",
    label: "代理 URL",
    placeholder: "http://127.0.0.1:7890",
    system: "系统 / 进程默认",
    custom: "已启用自定义代理",
    cancel: "取消",
    apply: "应用",
    applying: "正在应用…",
    clear: "使用系统默认",
    note: "localhost、127.0.0.1 和 ::1 始终直连，Launcher 的本地控制流量不会进入代理。",
  },
  "zh-TW": {
    button: "代理",
    title: "全域網路代理",
    body: "讓內建 ChatGPT 瀏覽器、Responses 執行環境與 MCP Tunnel 統一使用同一個 HTTP/HTTPS 代理。留空則使用系統與程序繼承的預設設定。",
    label: "代理 URL",
    placeholder: "http://127.0.0.1:7890",
    system: "系統 / 程序預設",
    custom: "已啟用自訂代理",
    cancel: "取消",
    apply: "套用",
    applying: "正在套用…",
    clear: "使用系統預設",
    note: "localhost、127.0.0.1 與 ::1 永遠直連，Launcher 的本機控制流量不會進入代理。",
  },
  ja: {
    button: "Proxy",
    title: "グローバルネットワークプロキシ",
    body: "組み込み ChatGPT ブラウザ、Responses ランタイム、MCP Tunnel で同じ HTTP/HTTPS プロキシを使用します。空欄にするとシステムおよび継承されたプロセス設定を使用します。",
    label: "プロキシ URL",
    placeholder: "http://127.0.0.1:7890",
    system: "システム / プロセス既定値",
    custom: "カスタムプロキシ有効",
    cancel: "キャンセル",
    apply: "適用",
    applying: "適用中…",
    clear: "システム既定値を使用",
    note: "localhost、127.0.0.1、::1 は常にプロキシを迂回し、Launcher のローカル制御通信をローカルに保ちます。",
  },
  ko: {
    button: "Proxy",
    title: "전역 네트워크 프록시",
    body: "내장 ChatGPT 브라우저, Responses 런타임, MCP Tunnel에 하나의 HTTP/HTTPS 프록시를 사용합니다. 비워 두면 시스템 및 상속된 프로세스 기본값을 사용합니다.",
    label: "프록시 URL",
    placeholder: "http://127.0.0.1:7890",
    system: "시스템 / 프로세스 기본값",
    custom: "사용자 지정 프록시 사용 중",
    cancel: "취소",
    apply: "적용",
    applying: "적용 중…",
    clear: "시스템 기본값 사용",
    note: "localhost, 127.0.0.1, ::1은 항상 프록시를 우회하여 Launcher의 로컬 제어 트래픽을 로컬에 유지합니다.",
  },
};

export function NetworkProxySettings({
  disabled = false,
  onOpenChange,
  state,
  updateState,
}: {
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  state: LauncherState;
  updateState: (state: LauncherState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(state.networkProxyUrl ?? "");
    setError(null);
  }, [open, state.networkProxyUrl]);

  const setDialogOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange(next);
  };

  const language = state.language ?? "en";
  const copy = COPY[language] ?? COPY.en;
  const normalizedDraft = draft.trim();
  const saved = state.networkProxyUrl ?? "";
  const dirty = normalizedDraft !== saved;
  const status = state.networkProxyUrl ? copy.custom : copy.system;
  const buttonTitle = useMemo(
    () => `${copy.title} · ${status}`,
    [copy.title, status],
  );

  if (!api) return null;

  const apply = async (proxyUrl: string | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.setNetworkProxy(proxyUrl);
      updateState(next);
      setDraft(next.networkProxyUrl ?? "");
      setDialogOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        aria-label={buttonTitle}
        className={`network-proxy-launcher${state.networkProxyUrl ? " is-active" : ""}`}
        disabled={disabled}
        onClick={() => setDialogOpen(true)}
        title={buttonTitle}
        type="button"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M4 12h4m8 0h4M8 7.5 11.5 12 8 16.5M16 7.5 12.5 12l3.5 4.5" />
        </svg>
        <span>{copy.button}</span>
        <i aria-hidden="true" />
      </button>

      {open ? createPortal((
        <div className="network-proxy-backdrop" role="presentation" onMouseDown={() => !busy && setDialogOpen(false)}>
          <section
            aria-labelledby="network-proxy-title"
            aria-modal="true"
            className="network-proxy-dialog"
            onMouseDown={event => event.stopPropagation()}
            role="dialog"
          >
            <header>
              <div>
                <small>{status}</small>
                <h2 id="network-proxy-title">{copy.title}</h2>
              </div>
              <button
                aria-label={copy.cancel}
                className="network-proxy-close"
                disabled={busy}
                onClick={() => setDialogOpen(false)}
                type="button"
              >
                ×
              </button>
            </header>

            <p className="network-proxy-description">{copy.body}</p>
            <label className="network-proxy-field">
              <span>{copy.label}</span>
              <input
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                disabled={busy}
                onChange={event => setDraft(event.target.value)}
                placeholder={copy.placeholder}
                spellCheck={false}
                value={draft}
              />
            </label>
            <p className="network-proxy-note">{copy.note}</p>
            {error ? <p className="network-proxy-error" role="alert">{error}</p> : null}

            <footer>
              {state.networkProxyUrl ? (
                <button
                  className="network-proxy-secondary"
                  disabled={busy}
                  onClick={() => void apply(null)}
                  type="button"
                >
                  {copy.clear}
                </button>
              ) : <span />}
              <div>
                <button
                  className="network-proxy-secondary"
                  disabled={busy}
                  onClick={() => setDialogOpen(false)}
                  type="button"
                >
                  {copy.cancel}
                </button>
                <button
                  className="network-proxy-primary"
                  disabled={busy || !dirty}
                  onClick={() => void apply(normalizedDraft || null)}
                  type="button"
                >
                  {busy ? copy.applying : copy.apply}
                </button>
              </div>
            </footer>
          </section>
        </div>
      ), document.body) : null}
    </>
  );
}
