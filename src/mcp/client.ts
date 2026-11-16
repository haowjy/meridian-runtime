import { type Fault, faultOf, sessionForgotten } from "./fault.js";
import { type Exchange, Session, type SessionConfig } from "./session.js";
import type {
  Aborted,
  Answered,
  JsonObject,
  Listing,
  McpClient,
  McpClientOptions,
  Reachable,
  Rejected,
  Server,
  TooLarge,
  Unreachable,
} from "./types.js";

const MAX_LIST_PAGES = 100;
const CANCELLED = Symbol("cancelled");

/** A start that failed; calls within `failFastMs` get the same answer without trying again. */
class StartFailure extends Error {
  constructor(readonly fault: Fault) {
    super(fault.message);
  }
}

interface Entry {
  session?: Session;
  starting?: Promise<Session>;
  failed?: { at: number; failure: StartFailure };
}

/** The host's signal and one deadline, as one signal, with the cause of whichever fired first. */
function control(host: AbortSignal | undefined, timeoutMs?: number) {
  const own = new AbortController();
  let cause: "host" | "timeout" | undefined;
  const fire = (why: "host" | "timeout") => {
    cause ??= why;
    own.abort();
  };
  const onHost = () => fire("host");
  if (host?.aborted) fire("host");
  else host?.addEventListener("abort", onHost, { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => fire("timeout"), timeoutMs);
  const cancelled = new Promise<never>((_, reject) => {
    if (own.signal.aborted) reject(CANCELLED);
    else own.signal.addEventListener("abort", () => reject(CANCELLED), { once: true });
  });
  cancelled.catch(() => {});
  return {
    signal: own.signal,
    get cause() {
      return cause;
    },
    race: <T>(work: Promise<T>) => Promise.race([work, cancelled]),
    dispose() {
      clearTimeout(timer);
      host?.removeEventListener("abort", onHost);
    },
  };
}
type Control = ReturnType<typeof control>;

export function createMcpClient(options: McpClientOptions): McpClient {
  const connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
  const idleCloseMs = options.idleCloseMs ?? 5 * 60_000;
  const failFastMs = options.failFastMs ?? 10_000;
  const maxReplyBytes = options.maxReplyBytes ?? 10 * 1024 * 1024;
  const cfg: SessionConfig = {
    clientInfo: options.clientInfo,
    maxReplyBytes,
    // Passed explicitly so the SDK never falls back to a global the host did not choose.
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  };
  const entries = new Map<string, Entry>();

  function entryFor(key: string): Entry {
    let entry = entries.get(key);
    if (!entry) {
      entry = {};
      entries.set(key, entry);
    }
    return entry;
  }

  /** The key's live session, started if there is none. Callers that arrive during a start share it. */
  function acquire(server: Server): Promise<Session> {
    const entry = entryFor(server.key);
    if (entry.session && !entry.session.ended) return Promise.resolve(entry.session);
    if (entry.starting) return entry.starting;
    if (entry.failed) {
      if (Date.now() - entry.failed.at < failFastMs) return Promise.reject(entry.failed.failure);
      entry.failed = undefined;
    }
    const starting = Session.open(server, cfg, { timeoutMs: connectTimeoutMs, idleCloseMs }).then(
      (session) => {
        entry.starting = undefined;
        entry.session = session;
        session.onEnded = () => {
          if (entry.session === session) entry.session = undefined;
        };
        return session;
      },
      (error) => {
        entry.starting = undefined;
        entry.failed = { at: Date.now(), failure: new StartFailure(faultOf(error, "start")) };
        throw entry.failed.failure;
      },
    );
    starting.catch(() => {}); // every caller may have given up; the failure is still recorded
    entry.starting = starting;
    return starting;
  }

  const unreachable = (fault: Fault, sent: boolean, ms: number): Unreachable => ({
    kind: "unreachable",
    ...fault,
    sent,
    ms,
  });
  const aborted = (sent: boolean, ms: number): Aborted => ({ kind: "aborted", sent, ms });

  /** The outcome of an acquire that did not give a session. */
  function startOutcome(error: unknown, ctl: Control, ms: number): Unreachable | Aborted {
    if (error === CANCELLED) {
      if (ctl.cause === "host") return aborted(false, ms);
      return unreachable(
        { reason: "call_timeout", message: "timed out before the session was ready" },
        false,
        ms,
      );
    }
    if (error instanceof StartFailure) return unreachable(error.fault, false, ms);
    throw error;
  }

  /** The outcome of one request, decided from the raw message off the wire when there is one. */
  function outcomeOf(
    exchange: Exchange,
    ctl: Control,
    ms: number,
  ): Answered | Rejected | TooLarge | Unreachable | Aborted {
    const { raw } = exchange;
    if (raw && "result" in raw)
      return { kind: "answered", isError: raw.result.isError === true, reply: raw.result, ms };
    if (raw) {
      const { code, message } = raw.error;
      return {
        kind: "rejected",
        code: typeof code === "number" ? code : 0,
        message: typeof message === "string" ? message : "",
        reply: raw.error,
        ms,
      };
    }
    if (exchange.tooLarge !== undefined)
      return { kind: "too_large", bytes: exchange.tooLarge, limit: maxReplyBytes, ms };
    if (ctl.cause === "host") return aborted(exchange.sent, ms);
    if (ctl.cause === "timeout")
      return unreachable(
        { reason: "call_timeout", message: "the call timed out" },
        exchange.sent,
        ms,
      );
    if (exchange.lost)
      return unreachable(
        { reason: "disconnected", message: "the connection ended" },
        exchange.sent,
        ms,
      );
    if (exchange.error === undefined)
      return unreachable(
        {
          reason: "bad_reply",
          message: "the SDK returned a reply the client could not read off the wire",
        },
        exchange.sent,
        ms,
      );
    return unreachable(faultOf(exchange.error, "call"), exchange.sent, ms);
  }

  /** Whether a request can be sent again on a new session without risking a second run. */
  function resendable(exchange: Exchange, session: Session, ctl: Control): boolean {
    if (exchange.raw || exchange.tooLarge !== undefined || ctl.cause) return false;
    if (!exchange.sent && session.ended) return true;
    return session.hasServerSession && sessionForgotten(exchange.error);
  }

  /** Runs `request` on the key's session, once more on a new session when the first one is gone. */
  async function viaSession(
    server: Server,
    ctl: Control,
    t0: number,
    request: (session: Session) => Promise<Exchange>,
  ): Promise<{ exchange: Exchange; session: Session } | { start: Unreachable | Aborted }> {
    for (let attempt = 0; ; attempt++) {
      let session: Session;
      try {
        session = await ctl.race(acquire(server));
      } catch (error) {
        return { start: startOutcome(error, ctl, Math.round(performance.now() - t0)) };
      }
      const exchange = await request(session);
      if (attempt === 0 && resendable(exchange, session, ctl)) {
        void session.close("forgotten");
        continue;
      }
      return { exchange, session };
    }
  }

  return {
    async call(server, { tool, arguments: args }, { signal, timeoutMs }) {
      const t0 = performance.now();
      const ctl = control(signal, timeoutMs);
      try {
        // A fresh copy of the arguments per attempt: its identity is how the reply is matched to this call.
        const done = await viaSession(server, ctl, t0, (session) =>
          session.call(tool.listed, tool.name, { ...args }, ctl.signal),
        );
        if ("start" in done) return done.start;
        return outcomeOf(done.exchange, ctl, Math.round(performance.now() - t0));
      } finally {
        ctl.dispose();
      }
    },

    async list(server, opts): Promise<Listing | Rejected | Unreachable | Aborted> {
      const t0 = performance.now();
      const ctl = control(opts?.signal, opts?.timeoutMs ?? connectTimeoutMs);
      const ms = () => Math.round(performance.now() - t0);
      try {
        const tools: JsonObject[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
          const done = await viaSession(server, ctl, t0, (session) =>
            session.listPage(cursor, ctl.signal),
          );
          if ("start" in done) return done.start;
          const outcome = outcomeOf(done.exchange, ctl, ms());
          if (
            outcome.kind === "rejected" ||
            outcome.kind === "unreachable" ||
            outcome.kind === "aborted"
          )
            return outcome;
          if (outcome.kind === "too_large")
            return unreachable(
              {
                reason: "bad_reply",
                message: `a tool list page is larger than ${maxReplyBytes} bytes`,
              },
              true,
              ms(),
            );
          const { tools: listed, nextCursor } = outcome.reply;
          if (!Array.isArray(listed))
            return unreachable(
              { reason: "bad_reply", message: "the tool list has no tools array" },
              true,
              ms(),
            );
          tools.push(...(listed as JsonObject[]));
          if (typeof nextCursor !== "string" || nextCursor === "") {
            const { session } = done;
            return {
              server: session.server,
              protocolVersion: session.protocolVersion,
              ...(session.instructions === undefined ? {} : { instructions: session.instructions }),
              tools,
            };
          }
          cursor = nextCursor;
        }
        return unreachable(
          { reason: "bad_reply", message: `the tool list has more than ${MAX_LIST_PAGES} pages` },
          true,
          ms(),
        );
      } finally {
        ctl.dispose();
      }
    },

    async check(server, opts): Promise<Reachable | Unreachable | Aborted> {
      const t0 = performance.now();
      const ms = () => Math.round(performance.now() - t0);
      const timeoutMs = opts?.timeoutMs ?? connectTimeoutMs;
      const live = entries.get(server.key)?.session;
      if (live && !live.ended) {
        // Half the time for the ping; the handshake after it gets what is left, so the whole
        // check stays within `timeoutMs`.
        const ctl = control(opts?.signal, timeoutMs / 2);
        try {
          const { raw } = await live.ping(ctl.signal);
          // A server without ping answers with an error, which still shows the session is alive.
          if (raw) return { kind: "reachable", server: live.server, ms: ms() };
          if (ctl.cause === "host") return aborted(true, ms());
        } finally {
          ctl.dispose();
        }
        // No reply to the ping: calls on the live session are left alone, and the answer comes
        // from a handshake of its own.
      }
      const ctl = control(opts?.signal);
      try {
        const session = await Session.open(server, cfg, {
          signal: ctl.signal,
          timeoutMs: Math.max(1, timeoutMs - ms()),
          idleCloseMs: 0,
        });
        await session.close();
        return { kind: "reachable", server: session.server, ms: ms() };
      } catch (error) {
        if (ctl.cause === "host") return aborted(false, ms());
        return unreachable(faultOf(error, "start"), false, ms());
      } finally {
        ctl.dispose();
      }
    },

    async close(key) {
      const targets = key === undefined ? [...entries.keys()] : [key];
      await Promise.all(
        targets.map(async (target) => {
          const entry = entries.get(target);
          entries.delete(target);
          const session = (await entry?.starting?.catch(() => undefined)) ?? entry?.session;
          await session?.close();
        }),
      );
    },
  };
}
