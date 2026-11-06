import type { HarnessEvent, HarnessParser, ParseContext } from "@selfbuilding/core";
import { classifyCodexMessage, isSelfbuildingMcpFailure } from "./classify.js";
import { SELFBUILDING_SERVER } from "./constants.js";

// Normalises `codex exec --json` (one JSON object per line) into HarnessEvents (spec §4.3). The runtime bundles this
// file, so it imports nothing but types and its two siblings.

type Json = Record<string, unknown>;

/** Lines above this size are dropped with a warning. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** Tool output kept per event; the tail is kept, because errors come last. */
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;

/** Codex tools that only read (spec §4.3). Everything else is an effect. */
const READ_ONLY_ITEMS = new Set(["web_search"]);
const READ_ONLY_MCP = new Set([`${SELFBUILDING_SERVER}/submit_result`]);

const encoder = new TextEncoder();
const byteLength = (text: string) => (text.length * 3 <= MAX_LINE_BYTES ? 0 : encoder.encode(text).length);

function parseObject(line: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function bounded(output: string): { output: string; truncatedBytes?: number } {
  const bytes = encoder.encode(output);
  if (bytes.length <= MAX_TOOL_OUTPUT_BYTES) return { output };
  const kept = new TextDecoder().decode(bytes.subarray(bytes.length - MAX_TOOL_OUTPUT_BYTES));
  return { output: kept, truncatedBytes: bytes.length - MAX_TOOL_OUTPUT_BYTES };
}

function mcpResultText(item: Json): string {
  const error = item.error as Json | null | undefined;
  if (error && typeof error.message === "string") return error.message;
  const result = item.result as Json | null | undefined;
  const content = Array.isArray(result?.content) ? (result.content as Json[]) : [];
  const text = content.map((c) => str(c.text)).join("\n");
  if (text || !result || result.structured_content == null) return text;
  return JSON.stringify(result.structured_content);
}

const FILE_CHANGE: Record<string, "add" | "modify" | "delete"> = { add: "add", delete: "delete", update: "modify" };

interface ToolInfo {
  name: string;
  started: boolean;
}

/** Signals and exit codes that mean the process was stopped from outside: SIGINT after a submit, a cancel. */
const STOPPED_SIGNALS = new Set(["SIGINT", "SIGTERM", "SIGKILL"]);
const STOPPED_CODES = new Set([130, 137, 143]);

/** One parser per codex process (spec §4.2). */
export function createCodexParser(_ctx?: ParseContext): HarnessParser {
  let session: string | undefined;
  let ended = false;
  let errored = false;
  const reported = new Set<string>();
  const tools = new Map<string, ToolInfo>();

  const errorEvent = (message: string): HarnessEvent[] => {
    errored = true;
    if (reported.has(message)) return [];
    reported.add(message);
    return [{ type: "error", failure: classifyCodexMessage(message) }];
  };

  const toolStarted = (item: Json): HarnessEvent[] => {
    const id = str(item.id);
    switch (item.type) {
      case "command_execution": {
        tools.set(id, { name: "command_execution", started: true });
        const command = str(item.command);
        return [
          {
            type: "tool.started",
            callId: id,
            name: "command_execution",
            source: "builtin",
            effect: "effect",
            input: { command },
            summary: command,
          },
        ];
      }
      case "mcp_tool_call": {
        const server = str(item.server);
        const tool = str(item.tool);
        tools.set(id, { name: tool, started: true });
        return [
          {
            type: "tool.started",
            callId: id,
            name: tool,
            source: "mcp",
            server,
            effect: READ_ONLY_MCP.has(`${server}/${tool}`) ? "read" : "effect",
            input: item.arguments,
            summary: tool,
          },
        ];
      }
      case "file_change": {
        tools.set(id, { name: "file_change", started: true });
        const changes = Array.isArray(item.changes) ? (item.changes as Json[]) : [];
        return [
          {
            type: "tool.started",
            callId: id,
            name: "file_change",
            source: "builtin",
            effect: "effect",
            input: { changes },
            summary: changes.map((c) => str(c.path)).join(", ") || "file_change",
          },
        ];
      }
      case "web_search": {
        tools.set(id, { name: "web_search", started: true });
        const query = str(item.query);
        return [
          {
            type: "tool.started",
            callId: id,
            name: "web_search",
            source: "builtin",
            effect: READ_ONLY_ITEMS.has("web_search") ? "read" : "effect",
            input: { query },
            summary: query || "web_search",
          },
        ];
      }
      case "collab_tool_call": {
        const tool = str(item.tool, "collab_tool_call");
        tools.set(id, { name: tool, started: true });
        return [
          {
            type: "tool.started",
            callId: id,
            name: tool,
            source: "subagent",
            effect: "effect",
            input: item.prompt === undefined ? undefined : { prompt: item.prompt },
            summary: tool,
          },
        ];
      }
      default:
        return [];
    }
  };

  const toolCompleted = (item: Json): HarnessEvent[] => {
    const id = str(item.id);
    const events: HarnessEvent[] = [];
    if (!tools.get(id)?.started) events.push(...toolStarted(item));
    const name = tools.get(id)?.name;
    if (name === undefined) return events;
    tools.delete(id);
    const status = str(item.status, "completed");
    switch (item.type) {
      case "command_execution": {
        const exit = item.exit_code;
        const ok = status === "completed" && (exit === null || exit === undefined || exit === 0);
        events.push({ type: "tool.completed", callId: id, name, ok, ...bounded(str(item.aggregated_output)) });
        break;
      }
      case "mcp_tool_call":
        events.push({
          type: "tool.completed",
          callId: id,
          name,
          ok: status === "completed",
          ...bounded(mcpResultText(item)),
        });
        break;
      case "file_change": {
        const ok = status === "completed";
        events.push({ type: "tool.completed", callId: id, name, ok });
        if (ok) {
          for (const change of Array.isArray(item.changes) ? (item.changes as Json[]) : []) {
            events.push({
              type: "file.changed",
              path: str(change.path),
              change: FILE_CHANGE[str(change.kind)] ?? "modify",
            });
          }
        }
        break;
      }
      default:
        events.push({ type: "tool.completed", callId: id, name, ok: status !== "failed" && status !== "declined" });
    }
    return events;
  };

  const errorItem = (message: string): HarnessEvent[] =>
    isSelfbuildingMcpFailure(message) ? errorEvent(message) : [{ type: "warning", message }];

  return {
    line(line) {
      if (line.length > MAX_LINE_BYTES || byteLength(line) > MAX_LINE_BYTES) {
        return [{ type: "warning", message: `dropped a codex output line over ${MAX_LINE_BYTES} bytes` }];
      }
      const obj = parseObject(line);
      if (!obj) return [];
      const item = (typeof obj.item === "object" && obj.item !== null ? obj.item : {}) as Json;
      switch (obj.type) {
        case "thread.started":
          session = str(obj.thread_id) || session;
          return session ? [{ type: "session.started", sessionId: session }] : [];
        case "item.started":
          return toolStarted(item);
        case "item.completed":
          if (item.type === "agent_message") return [{ type: "message", role: "assistant", text: str(item.text) }];
          // Item-level errors do not end the turn; Codex emits them on runs that still succeed (spec §4.3).
          if (item.type === "error") return errorItem(str(item.message));
          return toolCompleted(item);
        case "turn.completed": {
          ended = true;
          const usage = (obj.usage ?? {}) as Json;
          const reasoning = usage.reasoning_output_tokens;
          return [
            {
              type: "usage",
              inputTokens: num(usage.input_tokens),
              outputTokens: num(usage.output_tokens),
              cachedInputTokens: num(usage.cached_input_tokens),
              ...(typeof reasoning === "number" ? { reasoningTokens: reasoning } : {}),
              cumulative: false,
            },
            { type: "turn.ended", reason: "end_turn" },
          ];
        }
        case "turn.failed": {
          ended = true;
          const message = str((obj.error as Json | undefined)?.message, "turn failed");
          return [...errorEvent(message), { type: "turn.ended", reason: "error" }];
        }
        case "error": {
          const message = str(obj.message);
          const retry = /^Reconnecting\.{3}\s*(\d+)\s*\/\s*(\d+)\s*(?:\((.*)\))?/s.exec(message);
          if (retry) return [{ type: "retry", attempt: Number(retry[1]), cause: retry[3]?.trim() || message }];
          return errorEvent(message);
        }
        default:
          return [];
      }
    },

    end(exit) {
      if (ended) return [];
      ended = true;
      if ((exit.signal && STOPPED_SIGNALS.has(exit.signal)) || (exit.code !== null && STOPPED_CODES.has(exit.code))) {
        return [{ type: "turn.ended", reason: "interrupted" }];
      }
      if (exit.code === 0 && !errored) {
        return [
          { type: "warning", message: "codex exited 0 without turn.completed" },
          { type: "turn.ended", reason: "end_turn" },
        ];
      }
      if (errored) return [{ type: "turn.ended", reason: "error" }];
      const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
      return [
        { type: "error", failure: { code: "harness_crash", retryable: false, message: `codex exited with ${how}` } },
        { type: "turn.ended", reason: "error" },
      ];
    },

    sessionId: () => session,
  };
}
