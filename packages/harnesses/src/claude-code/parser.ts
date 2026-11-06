import type { HarnessEvent, HarnessFailure, HarnessParser, ParseContext } from "@selfbuilding/core";
import { classifyEvent } from "./classify.js";

// Claude Code `--output-format stream-json --verbose` → normalised events (spec §4.3). The runtime bundles this file,
// so it imports nothing beyond core types and the sibling classifier.

type Json = Record<string, unknown>;

/** Lines longer than this are dropped with a warning (spec §4.3). */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** Tool output kept on `tool.completed`; the rest is reported as `truncatedBytes`. */
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;

/** Built-in tools that only read or search (spec §4.3). Everything else is an effect. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "ToolSearch",
]);

const SELFBUILDING_SERVER = "selfbuilding";
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Task", "Agent"]);
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "NotebookEdit"]);

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseObject(line: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Splits `mcp__<server>__<tool>`. Server names may contain single underscores. */
export function splitMcpName(name: string): { server: string; tool: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? { server: match[1] as string, tool: match[2] as string } : undefined;
}

function toolSource(name: string, mcp: { server: string } | undefined): "builtin" | "mcp" | "skill" | "subagent" {
  if (mcp) return "mcp";
  if (SUBAGENT_TOOLS.has(name)) return "subagent";
  if (name === "Skill") return "skill";
  return "builtin";
}

function toolEffect(name: string, mcp: { server: string; tool: string } | undefined): "read" | "effect" {
  if (mcp) return mcp.server === SELFBUILDING_SERVER && mcp.tool === "submit_result" ? "read" : "effect";
  return READ_ONLY_TOOLS.has(name) ? "read" : "effect";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function summarise(name: string, input: unknown): string {
  const fields = isObject(input) ? input : {};
  const pick =
    name === "Bash"
      ? str(fields.command)
      : (str(fields.file_path) ??
        str(fields.notebook_path) ??
        str(fields.pattern) ??
        str(fields.url) ??
        str(fields.query) ??
        str(fields.description) ??
        str(fields.skill));
  const text = pick ? `${name}: ${pick}` : name;
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function toolOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (isObject(block) && typeof block.text === "string") return block.text;
        if (isObject(block) && typeof block.type === "string") return `[${block.type}]`;
        return "";
      })
      .join("\n");
  }
  return content === undefined || content === null ? "" : JSON.stringify(content);
}

function bound(text: string): { output: string; truncatedBytes?: number } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_TOOL_OUTPUT_BYTES) return { output: text };
  const kept = Buffer.from(text, "utf8").subarray(0, MAX_TOOL_OUTPUT_BYTES).toString("utf8").replace(/�$/, "");
  return { output: kept, truncatedBytes: bytes - Buffer.byteLength(kept, "utf8") };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function turnEndReason(obj: Json): "end_turn" | "max_turns" | "budget" | "error" {
  switch (obj.subtype) {
    case "error_max_turns":
      return "max_turns";
    case "error_max_budget_usd":
      return "budget";
    case "success":
      return obj.is_error === true ? "error" : "end_turn";
    default:
      return "error";
  }
}

interface PendingTool {
  name: string;
  input: unknown;
}

/** One parser per harness process (spec §4.2). */
export function createClaudeCodeParser(ctx?: ParseContext): HarnessParser {
  let session: string | undefined;
  let ended = false;
  let lastFailure: HarnessFailure | undefined;
  const tools = new Map<string, PendingTool>();

  const onInit = (obj: Json): HarnessEvent[] => {
    session = str(obj.session_id) ?? session;
    const servers = Array.isArray(obj.mcp_servers) ? obj.mcp_servers.filter(isObject) : [];
    const mcp = servers.map((s) => {
      const status = s.status === "connected" ? "connected" : s.status === "pending" ? "pending" : "failed";
      const error = str(s.error) ?? (status === "failed" && typeof s.status === "string" ? s.status : undefined);
      return { name: String(s.name), status, ...(error === undefined ? {} : { error }) } as const;
    });
    const events: HarnessEvent[] = [
      {
        type: "session.started",
        sessionId: session ?? "",
        ...(typeof obj.model === "string" ? { model: obj.model } : {}),
        ...(Array.isArray(obj.tools) ? { tools: obj.tools.map(String) } : {}),
        mcp,
      },
    ];
    // Claude skips broken MCP entries silently; a missing result tool must fail loudly (spec §4.8).
    const own = mcp.find((s) => s.name === SELFBUILDING_SERVER);
    if (own && own.status === "failed") {
      events.push({
        type: "error",
        failure: {
          code: "harness_crash",
          retryable: false,
          message: `The selfbuilding MCP server failed to connect${own.error ? `: ${own.error}` : ""}.`,
        },
      });
    } else if (own && own.status === "pending") {
      events.push({ type: "warning", message: "The selfbuilding MCP server was still connecting at session start." });
    }
    return events;
  };

  const onAssistant = (obj: Json): HarnessEvent[] => {
    const message = isObject(obj.message) ? obj.message : {};
    const content = Array.isArray(message.content) ? message.content.filter(isObject) : [];
    // API failures arrive as a synthetic assistant message; the terminal `result` reports them as the error.
    if (obj.is_api_error_message === true || typeof obj.error === "string") {
      lastFailure = classifyEvent(obj);
      return [];
    }
    const events: HarnessEvent[] = [];
    const text = content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    if (text) events.push({ type: "message", role: "assistant", text });
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      const name = String(block.name ?? "unknown");
      const callId = String(block.id ?? "");
      const mcp = splitMcpName(name);
      tools.set(callId, { name, input: block.input });
      events.push({
        type: "tool.started",
        callId,
        name,
        source: toolSource(name, mcp),
        ...(mcp ? { server: mcp.server } : {}),
        effect: toolEffect(name, mcp),
        input: block.input,
        summary: summarise(name, block.input),
      });
    }
    return events;
  };

  const onUser = (obj: Json): HarnessEvent[] => {
    const message = isObject(obj.message) ? obj.message : {};
    const content = Array.isArray(message.content) ? message.content.filter(isObject) : [];
    const meta = isObject(obj.tool_use_result) ? obj.tool_use_result : undefined;
    const events: HarnessEvent[] = [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const callId = String(block.tool_use_id ?? "");
      const pending = tools.get(callId);
      tools.delete(callId);
      const name = pending?.name ?? "unknown";
      const ok = block.is_error !== true;
      const durationMs = meta && typeof meta.durationMs === "number" ? meta.durationMs : undefined;
      events.push({
        type: "tool.completed",
        callId,
        name,
        ok,
        ...bound(toolOutput(block.content)),
        ...(durationMs === undefined ? {} : { durationMs }),
      });
      if (ok && pending) events.push(...fileChanges(name, pending.input, meta));
    }
    return events;
  };

  const onResult = (obj: Json): HarnessEvent[] => {
    ended = true;
    session = str(obj.session_id) ?? session;
    const usage = isObject(obj.usage) ? obj.usage : {};
    const events: HarnessEvent[] = [
      {
        type: "usage",
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
        cachedInputTokens: num(usage.cache_read_input_tokens),
        ...(typeof obj.total_cost_usd === "number" ? { costUsd: obj.total_cost_usd } : {}),
        // `result.usage` totals the whole process, so re-reading it must not double-count (spec §9.6).
        cumulative: true,
      },
    ];
    const reason = turnEndReason(obj);
    if (reason === "error") {
      const failure = classifyEvent(obj);
      // The synthetic error message usually names the cause more precisely than the result text.
      events.push({ type: "error", failure: failure.code === "unknown" && lastFailure ? lastFailure : failure });
    }
    events.push({ type: "turn.ended", reason });
    return events;
  };

  const onSystem = (obj: Json): HarnessEvent[] => {
    switch (obj.subtype) {
      case "init":
        return onInit(obj);
      case "api_retry": {
        const failure = classifyEvent(obj);
        lastFailure = failure;
        return [
          {
            type: "retry",
            attempt: num(obj.attempt),
            ...(typeof obj.retry_delay_ms === "number" ? { delayMs: obj.retry_delay_ms } : {}),
            cause: failure.code,
          },
        ];
      }
      default:
        return [];
    }
  };

  const onStreamEvent = (obj: Json): HarnessEvent[] => {
    const event = isObject(obj.event) ? obj.event : {};
    const delta = isObject(event.delta) ? event.delta : {};
    if (event.type !== "content_block_delta") return [];
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      return [{ type: "message.delta", kind: "text", text: delta.text }];
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      return [{ type: "message.delta", kind: "thinking", text: delta.thinking }];
    }
    return [];
  };

  const onRateLimit = (obj: Json): HarnessEvent[] => {
    const info = isObject(obj.rate_limit_info) ? obj.rate_limit_info : {};
    if (info.status === "rejected") {
      lastFailure = classifyEvent(obj);
      return [{ type: "warning", message: lastFailure.message }];
    }
    if (info.status === "allowed_warning") {
      const kind = typeof info.rateLimitType === "string" ? ` (${info.rateLimitType})` : "";
      return [{ type: "warning", message: `Subscription usage is close to its limit${kind}.` }];
    }
    return [];
  };

  return {
    line(line) {
      if (line.length > MAX_LINE_BYTES / 4 && Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        return [{ type: "warning", message: `Dropped a Claude Code stream line over ${MAX_LINE_BYTES} bytes.` }];
      }
      const obj = parseObject(line);
      if (!obj) return [];
      switch (obj.type) {
        case "system":
          return onSystem(obj);
        case "assistant":
          return onAssistant(obj);
        case "user":
          return onUser(obj);
        case "result":
          return onResult(obj);
        case "stream_event":
          return onStreamEvent(obj);
        case "rate_limit_event":
          return onRateLimit(obj);
        default:
          return [];
      }
    },
    end(exit) {
      if (ended) return [];
      ended = true;
      if (exit.code === 0) return [{ type: "turn.ended", reason: "end_turn" }];
      if (exit.signal === "SIGINT" || exit.code === 130) return [{ type: "turn.ended", reason: "interrupted" }];
      const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
      const crash: HarnessFailure = {
        code: "harness_crash",
        retryable: false,
        message:
          exit.code === 143 || exit.signal === "SIGTERM"
            ? `Claude Code exited with ${how}; SIGTERM records no result for the turn.`
            : `Claude Code exited with ${how} before reporting a result.`,
      };
      return [
        { type: "error", failure: lastFailure ?? crash },
        { type: "turn.ended", reason: "error" },
      ];
    },
    sessionId: () => session,
  };
}

function fileChanges(name: string, input: unknown, meta: Json | undefined): HarnessEvent[] {
  const fields = isObject(input) ? input : {};
  const path = str(fields.file_path) ?? str(fields.notebook_path);
  if (!path) return [];
  if (name === "Write") {
    return [{ type: "file.changed", path, change: meta?.type === "create" ? "add" : "modify" }];
  }
  if (EDIT_TOOLS.has(name)) return [{ type: "file.changed", path, change: "modify" }];
  return [];
}
