import assert from "node:assert/strict";
import { createHash } from "node:crypto";

type Row = Record<string, any>;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const MAX_FINAL_EVIDENCE_BYTES = 64 * 1024;
const recoveryNotice = "A new ChatGPT conversation was created with the current context.";
const limitedNotice = "This task continues in a new ChatGPT conversation. The previous conversation can no longer perform project operations. ChatGPT's own activities may still be running.";

/** Isolated synthetic cases only; never copies reasoning, prompts or tool arguments. */
export function summarizeContinuityFinalResponse(envelope: Row, redact: (text: string) => string) {
  return { status: typeof envelope.status === "string" ? redact(envelope.status) : null, endTurn: envelope.end_turn === true,
    messages: (Array.isArray(envelope.output) ? envelope.output : []).filter((item: Row) => item?.type === "message").map((item: Row) => {
      const text = (Array.isArray(item.content) ? item.content : []).filter((block: Row) => block?.type === "output_text" && typeof block.text === "string").map((block: Row) => block.text).join("");
      const bytes = Buffer.byteLength(text);
      return { role: typeof item.role === "string" ? redact(item.role) : null, status: typeof item.status === "string" ? redact(item.status) : null,
        phase: typeof item.phase === "string" ? redact(item.phase) : null, bodyBytes: bytes, bodyDigest: digest(text),
        ...(item.phase === "commentary" ? { projectNotice: text === recoveryNotice ? "new-conversation" : text === limitedNotice ? "limited-guarantee" : null } : {}),
        ...(item.phase === "final_answer" ? { syntheticFinalText: bytes <= MAX_FINAL_EVIDENCE_BYTES ? redact(text) : null,
          bodyCaptured: bytes <= MAX_FINAL_EVIDENCE_BYTES, evidenceByteLimit: MAX_FINAL_EVIDENCE_BYTES } : {}) };
    }) };
}

export function extractContinuityFinalResponseText(envelope: Row): string {
  assert.equal(envelope.status, "completed", "真实响应未完成");
  assert.equal(envelope.end_turn, true, "真实响应不是最终回复");
  assert.ok(Array.isArray(envelope.output), "真实响应缺少 output");
  assert.ok(envelope.output.every((item: Row) => item && ["message", "reasoning"].includes(item.type)), "最终回复含业务调用、checkpoint 或未知输出");
  const messages = envelope.output.filter((item: Row) => item.type === "message");
  for (const item of messages) {
    assert.equal(item.role, "assistant", "最终回复存在非 assistant 消息");
    assert.equal(item.status, "completed", "最终回复存在未完成消息");
    assert.ok(item.phase === "commentary" || item.phase === "final_answer", "正文消息缺少明确 phase 或 phase 未知");
    assert.ok(Array.isArray(item.content) && item.content.length && item.content.every((block: Row) => block?.type === "output_text" && typeof block.text === "string"), "正文格式无效");
  }
  const finals = messages.filter((item: Row) => item.phase === "final_answer");
  assert.equal(finals.length, 1, "缺少唯一真实 final_answer");
  const text = finals[0].content.map((block: Row) => block.text).join("");
  assert.ok(text.trim(), "真实 final_answer 为空");
  return text;
}
