import { createHash } from "node:crypto";
import type {
  JsonObject,
  JsonValue,
  Listing,
  Pin,
  PinnedTool,
  PinProblem,
  ToolDefinition,
} from "./types.js";

/** Providers (Anthropic, OpenAI) take this pattern; 64 characters is the safe length. */
const MODEL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function toolProblem(tool: JsonObject): string | undefined {
  if (typeof tool.name !== "string" || tool.name === "") return "it has no name";
  const schema = tool.inputSchema;
  if (!isObject(schema) || schema.type !== "object")
    return "its inputSchema is not an object schema";
  if (tool.description !== undefined && typeof tool.description !== "string")
    return "its description is not a string";
  const execution = tool.execution;
  if (isObject(execution) && execution.taskSupport === "required")
    return "it needs MCP's task protocol, which this client does not speak";
  return undefined;
}

/** Keeps the named tools, exactly as the server listed them, or says what cannot be offered. */
export function pin(
  listing: Listing,
  choose: { tools: string[]; pinnedAt: string },
): { pin: Pin } | { problems: PinProblem[] } {
  const problems: PinProblem[] = [];
  const tools: PinnedTool[] = [];
  const chosen = new Set<string>();
  for (const name of choose.tools) {
    if (chosen.has(name)) {
      problems.push({
        tool: name,
        problem: "duplicate_choice",
        message: `"${name}" is chosen twice`,
      });
      continue;
    }
    chosen.add(name);
    const listed = listing.tools.find((tool) => isObject(tool) && tool.name === name);
    if (!listed) {
      problems.push({
        tool: name,
        problem: "not_listed",
        message: `the server does not list "${name}"`,
      });
      continue;
    }
    const problem = toolProblem(listed);
    if (problem) {
      const kind = problem.startsWith("it needs MCP's task") ? "task_required" : "invalid_tool";
      problems.push({
        tool: name,
        problem: kind,
        message: `"${name}" cannot be offered: ${problem}`,
      });
      continue;
    }
    tools.push({ name, listed });
  }
  if (problems.length > 0) return { problems };
  const { server, protocolVersion, instructions } = listing;
  return {
    pin: {
      format: 1,
      server: { name: server.name, version: server.version, protocolVersion },
      pinnedAt: choose.pinnedAt,
      ...(instructions === undefined ? {} : { instructions }),
      tools,
    },
  };
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key] as JsonValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 (hex) of the pin's canonical JSON: key order does not change it. */
export function pinHash(pinned: Pin): string {
  return createHash("sha256")
    .update(canonical(pinned as unknown as JsonValue))
    .digest("hex");
}

function description(tool: PinnedTool): string {
  const { description, title } = tool.listed;
  if (typeof description === "string") return description;
  return typeof title === "string" ? title : "";
}

/**
 * The model's tool definitions for a pin. The schema is carried as listed, never parsed into
 * another schema library and back. `modelName` decides the name the model sees; the default is
 * the server's.
 */
export function toTools(
  pinned: Pin,
  opts?: { modelName?: (tool: string) => string },
): { tools: ToolDefinition[] } | { problems: PinProblem[] } {
  const problems: PinProblem[] = [];
  const names = new Set<string>();
  const tools: ToolDefinition[] = [];
  for (const tool of pinned.tools) {
    const name = opts?.modelName ? opts.modelName(tool.name) : tool.name;
    if (!MODEL_NAME.test(name)) {
      problems.push({
        tool: tool.name,
        problem: "bad_model_name",
        message: `"${name}" is not a name providers accept (letters, digits, "_" and "-", up to 64)`,
      });
    } else if (names.has(name)) {
      problems.push({
        tool: tool.name,
        problem: "duplicate_model_name",
        message: `two tools would be called "${name}"`,
      });
    }
    names.add(name);
    tools.push({
      type: "function",
      name,
      description: description(tool),
      inputSchema: tool.listed.inputSchema as JsonObject,
    });
  }
  return problems.length > 0 ? { problems } : { tools };
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? flat : flat.slice(0, end + 1);
  return sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence;
}

/** One line per tool: the host's id and the first sentence of the pinned description. */
export function toCatalogue(entries: { id: string; tool: PinnedTool }[]): string {
  return entries
    .map(({ id, tool }) => {
      const sentence = firstSentence(description(tool));
      return sentence === "" ? id : `${id}: ${sentence}`;
    })
    .join("\n");
}

/** A tool's description and input schema as text, for a model that asks to read it. */
export function describeTool(id: string, tool: PinnedTool): string {
  const text = description(tool);
  return [
    id,
    ...(text === "" ? [] : ["", text]),
    "",
    "Input schema:",
    JSON.stringify(tool.listed.inputSchema, null, 2),
  ].join("\n");
}
