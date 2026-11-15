# MCP client

`createMcpClient` reaches an MCP server (a child process over stdio, or a remote server over
Streamable HTTP), lists its tools, calls one and checks that the server answers. `pin`, `pinHash`,
`toTools`, `toCatalogue`, `describeTool` and `toContent` are pure functions over the tool list and
replies. It has no tool registry, loop, storage, retry or idea of a thread or user: the host
supplies the command or URL, the child's environment, headers and a token function, and keeps the
pin wherever it keeps such things. Design: `meridian-flow-docs/work/shared-mcp-design`.

## The reply comes from the wire

The SDK's `callTool` parses the reply, drops unknown keys from a content block, throws on an
unknown block type and checks the reply against `outputSchema`, all after the tool ran. So the
client reads the wire itself (`session.ts`):

- **Matching.** Each call hands the SDK a fresh copy of its `arguments` (a list page hands its
  `params`). The transport's `send` is wrapped and maps that object's identity to the request id the
  SDK chose; the incoming-message hook, set before `connect`, keeps the raw response per id. Run on
  HTTP (JSON and SSE replies) and stdio with three concurrent calls. This rests on the SDK passing
  the object through unchanged. The other route, a progress token, adds a key to what is sent.
- **The outcome** is `answered` or `rejected` when a raw response exists, whatever the SDK did
  with it. Without one it is `too_large`, `aborted`, or `unreachable` by cause.
- **The pinned tool goes to the SDK without `outputSchema`**, because passing `toolDefinition` is
  also what makes the SDK validate the reply.

## The size limit

A reply over `maxReplyBytes` is stopped before it is read into memory.

- **stdio:** the SDK's read buffer (`maxBufferSize`) closes the transport and says why only in the
  transport's error text ("ReadBuffer exceeded"). The session ends. The call is `too_large` when it
  was the only one in flight, and `disconnected` for the others.
- **HTTP:** `reply-limit.ts` wraps the host's `fetch` and stops a POST reply at the limit
  (`Content-Length` first, then a counting stream). A JSON reply makes the SDK's `send` reject. An
  SSE reply does not: the SDK logs the stream error and the call waits until its timeout, so the
  wrapper names the request (its id, read from the POST body) and the call is aborted at once. The
  session stays. The GET event stream is not metered.

## Sessions

One per host key, started on the first `list` or `call`, shared by calls that arrive during the
start. `call_timeout`, `aborted`, `too_large` on HTTP and the HTTP status faults end only the call
(an abort or timeout sends MCP's cancel notice). A failed start fails calls at once for
`failFastMs`, with the same fault. A dead stdio child starts again on the next call. A call is
sent again only when it provably did not run: the HTTP server forgot the session (404, or a 400
mentioning the session), or the session was already gone before the request left.

`bad_reply` on stdio does not end the session: the SDK reads newline-delimited lines, so one
unparseable line loses that reply (its call times out) and framing is intact.

`check` runs no tool. On a live session it sends `ping`, and any JSON-RPC reply, an error such as
"method not found" included, counts. A `ping` with no reply leaves the session alone and the
answer comes from a handshake of its own.

## Public shapes that differ from the first design

- `TooLarge` carries `limit`, and `bytes` is a lower bound: the `Content-Length` when the server
  sent one, else what had been read when reading stopped.
- A failed start keeps its reason during fail-fast (a `401` stays `unauthorized`), where the
  design said `start_failed`.
