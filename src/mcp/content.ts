import type { ContentPart, JsonObject, JsonValue } from "./types.js";

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const text = (value: string): ContentPart => ({ type: "text", text: value });

function block(item: JsonValue): ContentPart {
  if (!isObject(item)) return text("[a content block that is not an object was left out]");
  const type = str(item.type);
  switch (type) {
    case "text": {
      const value = str(item.text);
      return value === undefined ? text('[a "text" block with no text was left out]') : text(value);
    }
    case "image": {
      const data = str(item.data);
      const mediaType = str(item.mimeType);
      if (data === undefined || mediaType === undefined)
        return text('[an "image" block with no data or type was left out]');
      return { type: "media", mediaType, source: { data } };
    }
    case "audio":
      return text(`[audio${typeNote(item.mimeType)} was left out]`);
    case "resource_link": {
      const name = str(item.name) ?? "(unnamed)";
      return text(`${name}: ${str(item.uri) ?? "(no uri)"}`);
    }
    case "resource": {
      const resource = item.resource;
      if (isObject(resource)) {
        const embedded = str(resource.text);
        if (embedded !== undefined) return text(embedded);
        return text(
          `[binary resource ${str(resource.uri) ?? "(no uri)"}${typeNote(resource.mimeType)} was left out]`,
        );
      }
      return text('[a "resource" block with no resource was left out]');
    }
    default:
      return text(`[a content block of type ${JSON.stringify(type ?? null)} was left out]`);
  }
}

function typeNote(mimeType: JsonValue | undefined): string {
  const value = str(mimeType);
  return value === undefined ? "" : ` (${value})`;
}

/**
 * What a model can read from a tool's raw reply. Blocks it cannot carry become a line saying what
 * was left out. A reply with only structured content becomes that JSON as text. Cutting a long
 * reply to size and storing media are the host's.
 */
export function toContent(reply: JsonObject): ContentPart[] {
  const parts = Array.isArray(reply.content) ? reply.content.map(block) : [];
  if (parts.length === 0 && reply.structuredContent !== undefined)
    return [text(JSON.stringify(reply.structuredContent))];
  return parts;
}
