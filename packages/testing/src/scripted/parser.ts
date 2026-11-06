import type { HarnessEvent, HarnessFailure, HarnessParser } from "@selfbuilding/core";

// A small parser for the two native formats the player prints. Real adapters ship their own parsers; this one exists
// so the scripted harness is a complete Harness on its own and so the player's output can be checked offline.

const READ_ONLY = new Set(["Read", "Glob", "Grep", "LS", "WebSearch", "WebFetch", "TodoWrite"]);

type Json = Record<string, unknown>;

function parseLine(line: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}

function failure(message: string): HarnessFailure {
  if (/rate.?limit|429/i.test(message)) return { code: "rate_limit", retryable: true, message };
  if (/auth|401|403|credential/i.test(message)) return { code: "auth", retryable: false, message };
  if (/quota|billing|credit/i.test(message)) return { code: "quota", retryable: false, message };
  if (/context|too long/i.test(message)) return { code: "context_overflow", retryable: false, message };
  if (/overloaded|5\d\d|provider/i.test(message)) return { code: "provider", retryable: true, message };
  return { code: "unknown", retryable: false, message };
}

export { failure as classifyMessage };

function endFromExit(exit: { code: number | null; signal: string | null }, sawEnd: boolean): HarnessEvent[] {
  if (sawEnd) return [];
  if (exit.code === 0) return [{ type: "turn.ended", reason: "end_turn" }];
  if (exit.signal === "SIGINT" || exit.code === 130) return [{ type: "turn.ended", reason: "interrupted" }];
  return [
    {
      type: "error",
      failure: {
        code: "harness_crash",
        retryable: false,
        message: `harness exited with ${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}`,
      },
    },
    { type: "turn.ended", reason: "error" },
  ];
}

export function claudeStreamParser(): HarnessParser {
  let session: string | undefined;
  let ended = false;
  const tools = new Map<string, string>();
  return {
    line(line) {
      const obj = parseLine(line);
      if (!obj) return [];
      const events: HarnessEvent[] = [];
      if (obj.type === "system" && obj.subtype === "init") {
        session = String(obj.session_id);
        const mcp = Array.isArray(obj.mcp_servers) ? (obj.mcp_servers as { name: string; status: string }[]) : [];
        events.push({
          type: "session.started",
          sessionId: session,
          ...(typeof obj.model === "string" ? { model: obj.model } : {}),
          ...(Array.isArray(obj.tools) ? { tools: obj.tools as string[] } : {}),
          mcp: mcp.map((s) => ({
            name: s.name,
            status: s.status === "connected" ? "connected" : s.status === "pending" ? "pending" : "failed",
          })),
        });
      } else if (obj.type === "assistant" || obj.type === "user") {
        const content = ((obj.message as Json | undefined)?.content ?? []) as Json[];
        for (const block of content) {
          if (block.type === "text") events.push({ type: "message", role: "assistant", text: String(block.text) });
          if (block.type === "tool_use") {
            const name = String(block.name);
            const id = String(block.id);
            tools.set(id, name);
            const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
            events.push({
              type: "tool.started",
              callId: id,
              name,
              source: mcp ? "mcp" : "builtin",
              ...(mcp ? { server: mcp[1] } : {}),
              effect: READ_ONLY.has(name) || mcp?.[2] === "submit_result" ? "read" : "effect",
              input: block.input,
              summary: name === "Bash" ? String((block.input as Json | undefined)?.command ?? name) : name,
            });
          }
          if (block.type === "tool_result") {
            const id = String(block.tool_use_id);
            events.push({
              type: "tool.completed",
              callId: id,
              name: tools.get(id) ?? "unknown",
              ok: block.is_error !== true,
              output: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
            });
          }
        }
      } else if (obj.type === "result") {
        ended = true;
        const usage = (obj.usage ?? {}) as Json;
        events.push({
          type: "usage",
          inputTokens: Number(usage.input_tokens ?? 0),
          outputTokens: Number(usage.output_tokens ?? 0),
          cachedInputTokens: Number(usage.cache_read_input_tokens ?? 0),
          ...(typeof obj.total_cost_usd === "number" ? { costUsd: obj.total_cost_usd } : {}),
          cumulative: true,
        });
        if (obj.is_error === true) events.push({ type: "error", failure: failure(String(obj.result ?? "")) });
        events.push({ type: "turn.ended", reason: obj.is_error === true ? "error" : "end_turn" });
      }
      return events;
    },
    end(exit) {
      return endFromExit(exit, ended);
    },
    sessionId: () => session,
  };
}

export function codexStreamParser(): HarnessParser {
  let session: string | undefined;
  let ended = false;
  return {
    line(line) {
      const obj = parseLine(line);
      if (!obj) return [];
      const item = (obj.item ?? {}) as Json;
      switch (obj.type) {
        case "thread.started":
          session = String(obj.thread_id);
          return [{ type: "session.started", sessionId: session }];
        case "item.started":
          if (item.type === "command_execution") {
            return [
              {
                type: "tool.started",
                callId: String(item.id),
                name: "command_execution",
                source: "builtin",
                effect: "effect",
                input: { command: item.command },
                summary: String(item.command),
              },
            ];
          }
          if (item.type === "mcp_tool_call") {
            return [
              {
                type: "tool.started",
                callId: String(item.id),
                name: String(item.tool),
                source: "mcp",
                server: String(item.server),
                effect: item.tool === "submit_result" ? "read" : "effect",
                input: item.arguments,
                summary: String(item.tool),
              },
            ];
          }
          return [];
        case "item.completed":
          if (item.type === "agent_message") return [{ type: "message", role: "assistant", text: String(item.text) }];
          if (item.type === "command_execution" || item.type === "mcp_tool_call") {
            const result = item.result as { content?: { text?: string }[] } | null | undefined;
            const error = item.error as { message?: string } | null | undefined;
            return [
              {
                type: "tool.completed",
                callId: String(item.id),
                name: item.type === "mcp_tool_call" ? String(item.tool) : "command_execution",
                ok: item.status === "completed",
                output:
                  item.type === "command_execution"
                    ? String(item.aggregated_output ?? "")
                    : (error?.message ?? (result?.content ?? []).map((c) => c.text ?? "").join("\n")),
              },
            ];
          }
          return [];
        case "turn.completed": {
          ended = true;
          const usage = (obj.usage ?? {}) as Json;
          return [
            {
              type: "usage",
              inputTokens: Number(usage.input_tokens ?? 0),
              outputTokens: Number(usage.output_tokens ?? 0),
              cachedInputTokens: Number(usage.cached_input_tokens ?? 0),
              cumulative: false,
            },
            { type: "turn.ended", reason: "end_turn" },
          ];
        }
        case "turn.failed":
          ended = true;
          return [
            { type: "error", failure: failure(String((obj.error as Json | undefined)?.message ?? "turn failed")) },
            { type: "turn.ended", reason: "error" },
          ];
        case "error":
          return [{ type: "warning", message: String(obj.message ?? "") }];
        default:
          return [];
      }
    },
    end(exit) {
      return endFromExit(exit, ended);
    },
    sessionId: () => session,
  };
}
