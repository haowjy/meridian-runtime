/** Thrown into the body stream of a reply that went over the limit. */
export class ReplyTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`reply is larger than the limit (at least ${bytes} bytes)`);
  }
}

type Fetch = typeof fetch;

/** The JSON-RPC id of a POSTed request, when the body shows one. */
function requestId(init: RequestInit | undefined): number | string | undefined {
  if (typeof init?.body !== "string") return undefined;
  try {
    const id = (JSON.parse(init.body) as { id?: unknown }).id;
    return typeof id === "number" || typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wraps the host's `fetch` so a reply to a JSON-RPC request is stopped at `limit` bytes, before
 * it is read into memory. Only POST replies are metered: the long-lived GET event stream is not
 * one reply. `onOver` names the request (when its body shows an id), because the SDK swallows a stream error on an SSE reply
 * and leaves the call waiting until its timeout.
 */
export function limitReplies(
  inner: Fetch,
  limit: number,
  onOver: (id: number | string, bytes: number) => void,
): Fetch {
  return async (input, init) => {
    const response = await inner(input, init);
    if (init?.method !== "POST" || response.body === null) return response;
    const id = requestId(init);

    const declared = Number(response.headers.get("content-length"));
    if (declared > limit) {
      void response.body.cancel().catch(() => {});
      if (id !== undefined) onOver(id, declared);
      throw new ReplyTooLarge(declared);
    }
    let seen = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > limit) {
            if (id !== undefined) onOver(id, seen);
            controller.error(new ReplyTooLarge(seen));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
