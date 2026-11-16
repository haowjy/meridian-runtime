/**
 * Per-call model decisions, made once by the gateway core where the routed
 * model is known. Adapters only map a `ResolvedCall` to their wire fields; they
 * never re-derive cache lifetimes or clamp efforts themselves.
 */
import {
  type GenerateRequest,
  type ModelInfo,
  type ReasoningSupport,
  resolvePromptCacheTtlSeconds,
} from "./types.js";

/** `default` sends nothing and leaves the model's own default; `effort: "none"` means reasoning off. */
export type ResolvedReasoning = "default" | { effort: string };

export interface ResolvedCall {
  /** Lifetime to put on the wire for cache breakpoints; null when the provider publishes none or the retention is `none` (no mark sent). */
  cacheTtlSeconds: number | null;
  /** Whether cache writes are billed at the model's long lifetime. */
  longCacheWrites: boolean;
  reasoning: ResolvedReasoning;
}

/**
 * The level a call runs at. A level the model lists is used as asked. Otherwise the nearest
 * level it lists by position in `levels`, a tie going to the higher one; `none` is only chosen
 * when asked for, so asking `none` of a model that cannot switch off gives its lowest other
 * level. With nothing to pick (no listed level is on the ladder, or the request is neither
 * listed nor on the ladder) or no request, the model's default.
 *
 * Differs from Mars's `resolveEffort` for a model whose row lists no level: that gets `default`
 * for any request, where Mars returns the requested level. Such models take no effort parameter
 * on the wire, so sending one would be rejected; the row is the data.
 */
export function resolveReasoning(
  requested: string | undefined,
  support: ReasoningSupport,
  levels: readonly string[],
): ResolvedReasoning {
  if (requested === undefined) return "default";
  if (support.efforts.includes(requested)) return { effort: requested };
  const target = levels.indexOf(requested);
  if (target < 0) return "default";
  let best: { effort: string; distance: number; rank: number } | undefined;
  for (const effort of support.efforts) {
    const rank = levels.indexOf(effort);
    if (rank < 0 || (effort === "none" && requested !== "none")) continue;
    const distance = Math.abs(rank - target);
    if (!best || distance < best.distance || (distance === best.distance && rank > best.rank)) {
      best = { effort, distance, rank };
    }
  }
  return best ? { effort: best.effort } : "default";
}

export function resolveCall(
  request: Pick<GenerateRequest, "promptCacheRetention" | "reasoning">,
  model: Pick<ModelInfo, "promptCache" | "reasoning">,
  levels: readonly string[],
): ResolvedCall {
  const { promptCache } = model;
  return {
    cacheTtlSeconds: resolvePromptCacheTtlSeconds(promptCache, request.promptCacheRetention),
    longCacheWrites:
      request.promptCacheRetention === "long" &&
      promptCache.longTtlSeconds !== promptCache.shortTtlSeconds,
    reasoning: resolveReasoning(request.reasoning, model.reasoning, levels),
  };
}
