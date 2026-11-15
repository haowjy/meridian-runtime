import {
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type { Unreachable } from "./types.js";

export type Fault = Pick<Unreachable, "reason" | "httpStatus" | "message">;

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error).slice(0, 500);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`.slice(0, 500);
}

/** What the SDK or the network threw when no reply arrived, as an `unreachable` reason. */
export function faultOf(error: unknown, phase: "start" | "call"): Fault {
  const message = describe(error);
  const other = phase === "start" ? "start_failed" : "bad_reply";
  if (error instanceof UnauthorizedError)
    return { reason: "unauthorized", httpStatus: 401, message };
  if (error instanceof SdkHttpError) {
    const status = error.status;
    if (status === 401) return { reason: "unauthorized", httpStatus: status, message };
    if (status === 403) return { reason: "forbidden", httpStatus: status, message };
    if (status === 429) return { reason: "rate_limited", httpStatus: status, message };
    if (status >= 500) return { reason: "server_error", httpStatus: status, message };
    return { reason: other, httpStatus: status, message };
  }
  if (error instanceof SdkError) {
    if (error.code === SdkErrorCode.RequestTimeout)
      return { reason: phase === "start" ? "connect_timeout" : "call_timeout", message };
    if (error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.NotConnected)
      return { reason: phase === "start" ? "start_failed" : "disconnected", message };
    return { reason: "bad_reply", message };
  }
  // fetch rejects with a TypeError for a refused, reset or unresolvable connection.
  if (error instanceof TypeError)
    return { reason: phase === "start" ? "start_failed" : "disconnected", message };
  if (error instanceof SyntaxError || error instanceof ProtocolError)
    return { reason: "bad_reply", message };
  return { reason: other, message };
}

/** The server said it does not know this session (a 404, or a 400 "not initialized"): the call did not run. */
export function sessionForgotten(error: unknown): boolean {
  if (!(error instanceof SdkHttpError)) return false;
  if (error.status === 404) return true;
  const { text } = error.data as { text?: unknown };
  return error.status === 400 && typeof text === "string" && /initializ|session/i.test(text);
}
