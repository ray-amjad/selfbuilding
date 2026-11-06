import { parse as parseYaml } from "yaml";

export interface SplitSkillFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Splits SKILL.md into its YAML frontmatter and its body. */
export function splitFrontmatter(text: string): ({ ok: true } & SplitSkillFile) | { ok: false; issue: string } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const match = FENCE.exec(source);
  if (!match) return { ok: false, issue: "SKILL.md must start with a YAML frontmatter block between --- lines" };
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch (e) {
    return { ok: false, issue: `frontmatter is not valid YAML: ${(e as Error).message.split("\n")[0]}` };
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, issue: "frontmatter must be a YAML mapping" };
  }
  return { ok: true, frontmatter: parsed as Record<string, unknown>, body: source.slice(match[0].length) };
}

/**
 * `allowed-tools` comes as a YAML list, a comma-separated string or a space-separated string. Separators inside
 * parentheses belong to the tool pattern ("Bash(git diff:*)"), so splitting tracks bracket depth.
 */
export function normaliseAllowedTools(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0);
  const text = String(value);
  const useComma = splitTopLevel(text, (ch) => ch === ",").length > 1;
  const parts = splitTopLevel(text, useComma ? (ch) => ch === "," : (ch) => /\s/.test(ch));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function splitTopLevel(text: string, isSeparator: (ch: string) => boolean): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth++;
    else if ((ch === ")" || ch === "]") && depth > 0) depth--;
    if (depth === 0 && isSeparator(ch)) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

/** Frontmatter `arguments`: a YAML list of names or a whitespace/comma-separated string. */
export function declaredArguments(frontmatter: Record<string, unknown>): string[] {
  const value = frontmatter.arguments;
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) =>
        typeof v === "object" && v !== null && "name" in v ? String((v as { name: unknown }).name) : String(v),
      )
      .filter((v) => v.length > 0);
  }
  return String(value)
    .split(/[\s,]+/)
    .filter((v) => v.length > 0);
}
