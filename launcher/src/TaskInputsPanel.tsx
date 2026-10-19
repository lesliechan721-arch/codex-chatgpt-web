import { useCallback, useEffect, useRef, useState } from "react";
import type { Language } from "./types";
import type { SavedTask, SavedTaskInput, TaskInputIdentity, TaskInputRequest, TaskInputsSnapshot } from "./task-input-types";

const words = {
  zh: {
    title: "已保存的追加输入", refresh: "刷新", loading: "正在读取…", empty: "没有已保存的追加输入。",
    description: "按接收顺序保存。已接收不表示模型已处理。关闭页面后仍可在此查看和恢复。",
    task: "任务", input: "输入", view: "查看原文", hide: "收起原文", copy: "复制原文", copied: "已复制原文。",
    waiting: "已接收，等待处理", processing: "正在处理", stopped: "需要恢复或重试", completed: "已完成",
    discarded: "已丢弃", missing: "正文缺失，需要补交", reserved: "接收状态待确认", released: "原文已清理",
    manual: "等待手动发送", observer: "等待客户端重新连接", compaction: "等待压缩完成",
    repairLabel: "补交相同消息的完整原文", repair: "补交原文", repairHint: "使用原消息 ID 校验。内容不同会被拒绝。成功保存前请保留你的副本。",
    retry: "重试已停止的输入", retryHint: "建立新的执行意图；等待原客户端重新连接后恢复。不会在此自动发送。",
    discard: "丢弃输入", discardHint: "仅可丢弃尚未获得交付许可的输入。",
    cleanup: "清理已结束输入的原文", delete: "清除任务收件", confirmDelete: "停止后续交付并删除本任务的全部原文？已开始的工具操作仍可能完成。",
    confirm: "确认清除", cancel: "取消", unavailable: "暂时无法读取或操作。请保留原文，然后刷新核对。",
    stale: "状态已变化。请刷新后重试。", conflict: "原消息 ID 对应的内容不同。请补交原始正文。",
    unknown: "操作回执未确认。请保留原文，刷新后沿同一消息 ID 核对。", budget: "本地恢复存储", bodies: "收件原文",
    used: "已用", pending: "待处理", changed: "操作已保存。", cannotWithdraw: "该输入已获得交付许可，无法撤回。",
  },
  en: {
    title: "Saved task inputs", refresh: "Refresh", loading: "Reading…", empty: "No saved task inputs.",
    description: "Inputs are saved in receive order. Receipt does not mean the model processed them. You can recover them here after a page closes.",
    task: "Task", input: "Input", view: "View original", hide: "Hide original", copy: "Copy original", copied: "Original copied.",
    waiting: "Received, waiting", processing: "Processing", stopped: "Recovery or retry required", completed: "Completed",
    discarded: "Discarded", missing: "Original missing; resubmit required", reserved: "Receipt needs confirmation", released: "Original cleared",
    manual: "Waiting for manual Send", observer: "Waiting for the client to reconnect", compaction: "Waiting for compaction",
    repairLabel: "Resubmit the full original text", repair: "Resubmit original", repairHint: "The original message ID is checked. Different content is rejected. Keep your copy until saving succeeds.",
    retry: "Retry stopped inputs", retryHint: "Creates a new execution intent. Resume from the original client. This action does not send a prompt.",
    discard: "Discard input", discardHint: "Only inputs without delivery permission can be discarded.",
    cleanup: "Clear originals for finished inputs", delete: "Clear task inbox", confirmDelete: "Stop further delivery and delete all originals for this task? Tools that already started can still complete.",
    confirm: "Confirm clearing", cancel: "Cancel", unavailable: "This action is unavailable. Keep the original, then refresh to check its state.",
    stale: "State changed. Refresh before retrying.", conflict: "This message ID has different content. Resubmit the original text.",
    unknown: "The action receipt is uncertain. Keep the original and refresh to check the same message ID.", budget: "Local recovery storage", bodies: "Inbox originals",
    used: "used", pending: "pending", changed: "Action saved.", cannotWithdraw: "This input has delivery permission and cannot be withdrawn.",
  },
};
function identity(task: SavedTask): TaskInputIdentity { return { thread: task.thread, scope: task.scope, taskId: task.taskId }; }
function taskKey(task: SavedTask): string { return JSON.stringify(identity(task)); }
function bytes(value: number): string { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / (1024 * 1024)).toFixed(1)} MiB`; }

export function TaskInputsPanel({ language }: { language: Language }) {
  const copy = words[language.startsWith("zh") ? "zh" : "en"];
  const [snapshot, setSnapshot] = useState<TaskInputsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [original, setOriginal] = useState<{ key: string; text: string } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<string | null>(null);
  const mounted = useRef(true);
  const snapshotRead = useRef<Promise<TaskInputsSnapshot> | null>(null);
  const load = useCallback(async () => {
    const pending = snapshotRead.current ?? (snapshotRead.current = (async () => {
      const result = await window.codexWebLauncher!.taskInputs({ action: "snapshot" });
      if (!result.ok) throw new Error(result.code);
      return result.value as TaskInputsSnapshot;
    })());
    try {
      const value = await pending;
      if (mounted.current) setSnapshot(value);
    } finally {
      if (snapshotRead.current === pending) snapshotRead.current = null;
    }
  }, []);
  const refresh = useCallback(async () => {
    setBusy(true); setError("");
    try { await load(); }
    catch { if (mounted.current) setError(copy.unavailable); }
    finally { if (mounted.current) setBusy(false); }
  }, [copy.unavailable, load]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);
  const act = async (request: TaskInputRequest, key?: string) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await window.codexWebLauncher!.taskInputs(request);
      if (!mounted.current) return;
      if (!result.ok) {
        setError(result.receiveStatus === "unknown" ? copy.unknown : result.code === "task_update_stale" ? copy.stale
          : result.code === "task_update_message_conflict" ? copy.conflict : result.code === "task_update_not_executed" ? copy.cannotWithdraw : copy.unavailable);
        // An uncertain action retains the draft. It is safe to query the original identity.
        try { await load(); } catch { /* Keep the last confirmed snapshot. */ }
        return;
      }
      if (request.action === "read") setOriginal({ key: key!, text: (result.value as { text: string }).text });
      else if (request.action === "copy") setNotice(copy.copied);
      else {
        setOriginal(null); setDeleting(null);
        if (request.action === "repair" && key) setDrafts(previous => { const next = { ...previous }; delete next[key]; return next; });
        setNotice(copy.changed); await load();
      }
    } catch { if (mounted.current) setError(copy.unknown); }
    finally { if (mounted.current) setBusy(false); }
  };
  const status = (task: SavedTask, message: SavedTaskInput): string => {
    if (message.payload === "released") return copy.released;
    if (message.payload === "missing") return copy.missing;
    if (message.status === "reserved") return copy.reserved;
    if (message.status === "stopped") return copy.stopped;
    if (message.status === "completed") return copy.completed;
    if (message.status === "discarded") return copy.discarded;
    if (task.waitReason === "manual-send") return copy.manual;
    if (task.waitReason === "observer") return copy.observer;
    if (task.waitReason === "compaction") return copy.compaction;
    if (task.waitReason === "recovery") return copy.stopped;
    return task.deliveries.some(delivery => !delivery.cancelled && message.deliveryIds.includes(delivery.deliveryId)) ? copy.processing : copy.waiting;
  };
  const usage = snapshot?.usage;
  return <section className="task-inputs" aria-labelledby="task-inputs-title" aria-busy={busy}>
    <div className="section-heading"><span id="task-inputs-title">{copy.title}</span>
      <button className="button button-secondary" disabled={busy} onClick={() => void refresh()}>{busy ? copy.loading : copy.refresh}</button></div>
    <p className="task-inputs-description">{copy.description}</p>
    {usage && <p className="task-inputs-usage">{usage.pendingMessages} {copy.pending} · {copy.bodies} {bytes(usage.bodyBytes)}
      {usage.globalUsedBytes !== undefined && <> · {copy.budget} {bytes(usage.globalUsedBytes)} / {bytes(usage.globalLimitBytes ?? snapshot!.recoveryLimitBytes)} {copy.used}</>}</p>}
    <div role="status" aria-live="polite">{notice}</div>
    {error && <p className="task-inputs-error" role="alert">{error}</p>}
    {snapshot?.tasks.length === 0 && <p className="task-inputs-description">{copy.empty}</p>}
    {snapshot?.tasks.map((task, index) => {
      const key = taskKey(task), binding = { identity: identity(task), expectedVersion: task.version, expectedIntentGeneration: task.intentGeneration };
      const stopped = task.messages.filter(message => message.status === "stopped");
      const canRetry = task.state === "stopped" && stopped.length > 0 && stopped.every(message => message.payload === "ready");
      return <details className="task-inputs-task" key={key}>
        <summary><strong>{copy.task} {index + 1}</strong><span>{task.taskId}</span><span>{task.messages.length} {copy.input}</span></summary>
        <div className="task-inputs-messages">{task.messages.map(message => {
          const messageKey = `${key}:${message.messageId}`, readable = message.payload === "ready";
          const hasDelivery = task.deliveries.some(delivery => !delivery.cancelled && message.deliveryIds.includes(delivery.deliveryId));
          return <article className="task-inputs-message" key={message.messageId}>
            <div className="task-inputs-message-heading"><strong>{copy.input} {message.receivedSequence}</strong><span>{status(task, message)}</span><span>{bytes(message.bytes)}</span></div>
            <code className="task-inputs-id">{message.messageId}</code>
            <div className="task-inputs-actions">
              <button disabled={busy || !readable} onClick={() => original?.key === messageKey ? setOriginal(null) : void act({ action: "read", identity: identity(task), messageId: message.messageId }, messageKey)}>{original?.key === messageKey ? copy.hide : copy.view}</button>
              <button disabled={busy || !readable} onClick={() => void act({ action: "copy", identity: identity(task), messageId: message.messageId })}>{copy.copy}</button>
              {!hasDelivery && !["completed", "discarded"].includes(message.status) && <button disabled={busy} title={copy.discardHint} onClick={() => void act({ action: "discard", ...binding, messageId: message.messageId })}>{copy.discard}</button>}
            </div>
            {original?.key === messageKey && <pre className="task-inputs-original">{original.text}</pre>}
            {["missing", "reserved"].includes(message.payload) && <div className="task-inputs-repair">
              <label htmlFor={`repair-${index}-${message.receivedSequence}`}>{copy.repairLabel}</label>
              <textarea id={`repair-${index}-${message.receivedSequence}`} value={drafts[messageKey] ?? ""} disabled={busy} onChange={event => setDrafts(previous => ({ ...previous, [messageKey]: event.target.value }))} />
              <p>{copy.repairHint}</p>
              <button disabled={busy || !drafts[messageKey]?.trim()} onClick={() => void act({ action: "repair", ...binding, messageId: message.messageId, text: drafts[messageKey] }, messageKey)}>{copy.repair}</button>
            </div>}
          </article>;
        })}</div>
        <div className="task-inputs-actions task-inputs-task-actions">
          {canRetry && <button disabled={busy} title={copy.retryHint} onClick={() => void act({ action: "retry", ...binding, messageIds: stopped.map(message => message.messageId) })}>{copy.retry}</button>}
          {task.messages.some(message => ["completed", "discarded"].includes(message.status) && message.payload !== "released") && <button disabled={busy} onClick={() => void act({ action: "cleanup", ...binding })}>{copy.cleanup}</button>}
          {task.messages.some(message => message.payload !== "released") && <button disabled={busy} onClick={() => setDeleting(key)}>{copy.delete}</button>}
        </div>
        {canRetry && <p className="task-inputs-description">{copy.retryHint}</p>}
        {deleting === key && <div className="task-inputs-confirm"><p>{copy.confirmDelete}</p><button disabled={busy} onClick={() => void act({ action: "delete-task", ...binding })}>{copy.confirm}</button><button disabled={busy} onClick={() => setDeleting(null)}>{copy.cancel}</button></div>}
      </details>;
    })}
  </section>;
}
