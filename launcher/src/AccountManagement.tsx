import { useState } from "react";
import type { AccountSnapshot, Language, LauncherApi } from "./types";
import "./accounts.css";

export function accountCopy(language: Language) {
  return language.startsWith("zh") ? {
    title: "账号管理", current: "当前账号", empty: "尚未启用账号", add: "添加账号", name: "本地名称",
    proxy: "账号代理", system: "系统默认", custom: "自定义 HTTP(S) 代理", proxyUrl: "代理地址", cancel: "取消",
    create: "添加并切换", rename: "重命名", save: "保存名称", switch: "切换", remove: "移除", retry: "重试清理",
    settings: "账号设置", checked: "上次检查", signedIn: "已登录", signedOut: "未登录", unknown: "待检查", failed: "检查失败",
    mismatch: "登录身份发生变化。请退出并恢复原身份，或在新账号记录中登录。", removing: "移除未完成，此账号已禁用。",
    switchFirst: "先切换到其它账号，才能移除当前账号。", wait: "正在处理…",
    intro: "每次只启用一个账号。切换将重启启动器；有任务、登录或诊断时会拒绝切换。",
    newAccount: "新账号使用空白登录环境及默认账号设置，不复制其它账号的凭据。添加后会确认切换并重启。",
    history: "在其它账号继续 Codex 任务时，必要的任务正文、工具结果和摘要会用于新网页会话。这些内容可能包含你写入的敏感信息。登录、密钥和工具授权不会交接。普通切换不复制任务历史。",
    restart: "切换后请重启 Codex，以刷新可用模型。API Key 模式需要按现有流程重新导出静态模型目录。",
    emptyBody: "添加新账号，或选择现有账号并重试。API 将返回未就绪。",
    retryLoad: "重试上次账号", recovery: "账号加载失败", accountScope: "账号设置所属",
    shared: "通用设置对所有账号生效；API 服务地址、访问策略和服务访问密钥由应用共享。",
  } : {
    title: "Accounts", current: "Current account", empty: "No active account", add: "Add account", name: "Local name",
    proxy: "Account proxy", system: "System default", custom: "Custom HTTP(S) proxy", proxyUrl: "Proxy URL", cancel: "Cancel",
    create: "Add and switch", rename: "Rename", save: "Save name", switch: "Switch", remove: "Remove", retry: "Retry cleanup",
    settings: "Account settings", checked: "Last check", signedIn: "Signed in", signedOut: "Signed out", unknown: "Not checked", failed: "Check failed",
    mismatch: "The login identity changed. Sign out and restore the original identity, or use a new account record.", removing: "Removal is incomplete. This account is disabled.",
    switchFirst: "Switch to another account before removing the current account.", wait: "Working…",
    intro: "One account runs at a time. Switching restarts Launcher. Tasks, login, or diagnostics block a switch.",
    newAccount: "A new account starts with an empty login and default account settings. It does not copy credentials. Confirm the switch and restart after adding it.",
    history: "Continuing a Codex task in another account sends the necessary task text, tool results, and summaries to a new web chat. This content can include sensitive information you entered. Login, keys, and tool permissions stay separate. Switching alone copies no task history.",
    restart: "Restart Codex after switching to refresh models. In API key mode, use the existing export flow to refresh the static model catalog.",
    emptyBody: "Add an account, or select an existing account and retry. The API returns not ready.",
    retryLoad: "Retry last account", recovery: "Account could not load", accountScope: "Settings belong to",
    shared: "General preferences apply to all accounts. The service address, API access policy, and service access key are shared by the application.",
  };
}

export function AccountManagement({ api, accounts, language, onSettings }: {
  api: LauncherApi;
  accounts: AccountSnapshot;
  language: Language;
  onSettings?: () => void;
}) {
  const copy = accountCopy(language);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [proxyMode, setProxyMode] = useState("system");
  const [proxyUrl, setProxyUrl] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perform = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const current = accounts.accounts.find(account => account.id === accounts.currentId);
  return (
    <section className="content-surface account-management" aria-labelledby="accounts-title">
      <div className="content-scroll is-narrow">
        <header className="surface-header">
          <span>{current ? `${copy.current} · ${current.name}` : copy.empty}</span>
          <h1 id="accounts-title">{copy.title}</h1>
          <p>{copy.intro}</p>
        </header>
        {accounts.recoveryError ? <div className="account-notice is-error" role="alert">
          <strong>{copy.recovery}</strong><p>{accounts.recoveryError}</p>
          {!accounts.currentId && accounts.accounts.some(account => account.id === accounts.lastLoadedId && account.status === "active")
            ? <button disabled={busy} onClick={() => void perform(() => api.switchAccount(accounts.lastLoadedId!))}>{copy.retryLoad}</button> : null}
        </div> : null}
        {!accounts.currentId ? <p className="account-notice">{copy.emptyBody}</p> : null}
        <div className="account-toolbar">
          <h2>{copy.title}</h2>
          <button disabled={busy} onClick={() => setAdding(true)}>{copy.add}</button>
        </div>
        {adding ? <form className="account-form" onSubmit={event => {
          event.preventDefault();
          void perform(async () => {
            const account = await api.addAccount({ name: name.trim(), networkProxyUrl: proxyMode === "custom" ? proxyUrl.trim() : null });
            setAdding(false); setName(""); setProxyUrl(""); setProxyMode("system");
            await api.switchAccount(account.id);
          });
        }}>
          <p>{copy.newAccount}</p>
          <label>{copy.name}<input autoFocus autoComplete="off" maxLength={80} required value={name} onChange={event => setName(event.target.value)} disabled={busy} /></label>
          <label>{copy.proxy}<select value={proxyMode} disabled={busy} onChange={event => setProxyMode(event.target.value)}>
            <option value="system">{copy.system}</option><option value="custom">{copy.custom}</option>
          </select></label>
          {proxyMode === "custom" ? <label>{copy.proxyUrl}<input type="password" autoComplete="off" spellCheck={false} required placeholder="http://user:password@host:port" value={proxyUrl} onChange={event => setProxyUrl(event.target.value)} disabled={busy} /></label> : null}
          <div className="account-actions"><button type="button" disabled={busy} onClick={() => setAdding(false)}>{copy.cancel}</button><button type="submit" disabled={busy || !name.trim()}>{copy.create}</button></div>
        </form> : null}
        <ul className="account-list">
          {accounts.accounts.map(account => {
            const active = account.id === accounts.currentId;
            const removable = !active || !accounts.accounts.some(item => item.id !== account.id && item.status === "active");
            const login = account.lastLogin?.status;
            const status = login === "signed-in" ? copy.signedIn : login === "signed-out" ? copy.signedOut : login === "error" ? copy.failed : copy.unknown;
            return <li className="account-row" key={account.id}>
              <div className="account-row-heading"><strong>{account.name}</strong>{active ? <span className="account-current-marker">{copy.current}</span> : null}</div>
              <p>{copy.checked}：{status}{account.lastLogin ? ` · ${new Date(account.lastLogin.checkedAt).toLocaleString(language)}` : ""}</p>
              <p>{copy.proxy}：{account.proxyMode === "custom" ? copy.custom : account.proxyMode === "system" ? copy.system : copy.unknown}</p>
              {account.identityStatus === "mismatch" ? <p className="account-error">{copy.mismatch}</p> : null}
              {account.status !== "active" ? <p className="account-error">{copy.removing} {account.removalError}</p> : null}
              {editing === account.id ? <form className="account-form" onSubmit={event => {
                event.preventDefault();
                void perform(async () => { await api.renameAccount(account.id, editName.trim()); setEditing(null); });
              }}>
                <label>{copy.name}<input autoFocus maxLength={80} required value={editName} disabled={busy} onChange={event => setEditName(event.target.value)} /></label>
                <div className="account-actions"><button type="button" disabled={busy} onClick={() => setEditing(null)}>{copy.cancel}</button><button disabled={busy || !editName.trim()}>{copy.save}</button></div>
              </form> : <div className="account-actions">
                {account.status === "active" ? <>
                  {active && onSettings ? <button disabled={busy} onClick={onSettings}>{copy.settings}</button> : <button disabled={busy || active} onClick={() => void perform(() => api.switchAccount(account.id))}>{copy.switch}</button>}
                  <button disabled={busy} onClick={() => { setEditing(account.id); setEditName(account.name); }}>{copy.rename}</button>
                </> : null}
                <button className="account-remove" disabled={busy || !removable} onClick={() => void perform(() => api.removeAccount(account.id))}>{account.status === "active" ? copy.remove : copy.retry}</button>
              </div>}
              {!removable ? <small>{copy.switchFirst}</small> : null}
            </li>;
          })}
        </ul>
        {busy ? <p role="status">{copy.wait}</p> : null}
        {error ? <p className="account-notice is-error" role="alert">{error}</p> : null}
        <div className="account-help"><p>{copy.restart}</p><p>{copy.shared}</p><p>{copy.history}</p></div>
      </div>
    </section>
  );
}
