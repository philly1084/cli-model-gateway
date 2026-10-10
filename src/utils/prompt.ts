import type { ChatMessage } from "../types";

export function buildPrompt(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const headerParts = [message.role.toUpperCase()];
      if (message.name) {
        headerParts.push(`name=${message.name}`);
      }
      if (message.tool_call_id) {
        headerParts.push(`tool_call_id=${message.tool_call_id}`);
      }
      return `${headerParts.join(" ")}:\n${message.content}${message.toolCalls?.length ? "\n\nTOOL_CALLS:\n"+JSON.stringify(message.toolCalls) : ""}`.trim();
    })
    .join("\n\n");
}

export function extractTextContent(content: unknown): string {
  return collectTextSegments(content, 0, new WeakSet<object>()).join("\n");
}

export function extractTextContentOrJson(content: unknown): string {
  const text = extractTextContent(content);
  if (text.trim()) {
    return text;
  }

  if (content === null || content === undefined) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function collectTextSegments(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): string[] {
  if (depth > 8 || value === null || value === undefined) {
    return [];
  }

  if (typeof value === "string") {
    return value ? [value] : [];
  }

  if (Array.isArray(value)) {
    return dedupeTextSegments(
      value.flatMap((item) => collectTextSegments(item, depth + 1, seen)),
    );
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  return dedupeTextSegments(
    [
      record.text,
      record.input_text,
      record.output_text,
      record.content,
      record.value,
    ].flatMap((item) => collectTextSegments(item, depth + 1, seen)),
  );
}

function dedupeTextSegments(parts: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }

  return out;
}
