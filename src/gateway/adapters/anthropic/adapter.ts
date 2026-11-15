/**
 * Anthropic provider adapter: implements the provider-adapter port by streaming
 * the Anthropic Messages SDK and translating to/from canonical gateway types.
 * Owns the Anthropic-specific wiring; the only place the @anthropic-ai SDK is
 * driven for streaming. The shared stream envelope is `../provider-stream.ts`.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ProviderConfig, ProviderCredential } from "../../domain/index.js";
import type { ProviderAdapter } from "../../ports/provider-adapter.js";
import { bearerClientOptions, clientForRequest } from "../credentials.js";
import {
  ANTHROPIC_ENV_OPTOUT,
  type ProviderErrorPatterns,
  providerClientOptions,
  providerFetch,
} from "../provider-http-error.js";
import { streamProvider } from "../provider-stream.js";
import { toAnthropicMessageParams } from "./request-map.js";
import {
  buildGenerateResult,
  createStreamAccumulator,
  eventsFromAnthropicStreamEvent,
} from "./stream-collect.js";

/**
 * Anthropic also reports a filtered request as "blocked". The word must be "blocked",
 * not "block": "invalid content block" is a malformed request, not a filter.
 */
export const ANTHROPIC_ERROR_PATTERNS: Partial<ProviderErrorPatterns> = {
  contentFiltered: /content[\s\S]*(?:filter|blocked)|(?:filter|blocked)[\s\S]*content/,
};

/**
 * A token goes through the shared `bearerFetch` (with Anthropic's OAuth beta header) instead of
 * the SDK's `credentials`, because the SDK's one 401 refresh needs `maxRetries` above 0, which
 * would also retry 5xx and 429 inside a call. `authToken: null` stops the SDK's environment
 * lookup; with a key set, it never reads a profile or federation config from disk.
 */
function authOptions(credential: ProviderCredential | undefined) {
  return { authToken: null, ...bearerClientOptions(credential, providerFetch, "anthropic") };
}

export function createAnthropicAdapter(config: ProviderConfig): ProviderAdapter {
  const own = new Anthropic({
    ...providerClientOptions(config, "https://api.anthropic.com"),
    ...ANTHROPIC_ENV_OPTOUT,
    ...authOptions(config.auth),
  });
  const clientFor = clientForRequest(config, own, (credential) =>
    own.withOptions(authOptions(credential)),
  );
  const providerId = config.id;

  return {
    stream(request, model, call) {
      const acc = createStreamAccumulator(model.id, providerId, call.longCacheWrites);
      return streamProvider({
        start: { type: "start", model: model.id, provider: providerId },
        signal: request.signal,
        errorPatterns: ANTHROPIC_ERROR_PATTERNS,
        open: () =>
          clientFor(request).messages.create(toAnthropicMessageParams(request, model, call), {
            signal: request.signal,
          }),
        events: (event) => eventsFromAnthropicStreamEvent(event, acc),
        result: () => buildGenerateResult(acc),
      });
    },
  };
}
