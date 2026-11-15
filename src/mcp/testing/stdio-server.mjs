// The same server over stdio (newline-delimited JSON-RPC). Test support: not part of the build.
import { createInterface } from "node:readline";

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const text = (value) => ({ content: [{ type: "text", text: value }] });

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize")
    return send({
      id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "purpose-built-stdio", version: "1.0.0" },
      },
    });
  if (method === "ping") return send({ id, result: {} });
  if (method !== "tools/call")
    return send({ id, error: { code: -32601, message: "Method not found" } });
  const args = params.arguments ?? {};
  switch (params.name) {
    case "echo":
      return void setTimeout(
        () => send({ id, result: text(`echo ${args.text}`) }),
        args.delayMs ?? 0,
      );
    case "big":
      return send({ id, result: text("x".repeat(args.bytes)) });
    case "die":
      return process.exit(1);
    case "env":
      return send({ id, result: text(JSON.stringify(Object.keys(process.env).sort())) });
    default:
      return send({ id, error: { code: -32602, message: `Tool ${params.name} not found` } });
  }
});
