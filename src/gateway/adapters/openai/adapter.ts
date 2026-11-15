/**
 * OpenAI Responses provider adapter: implements the provider-adapter port over
 * the OpenAI Responses API, translating to/from canonical gateway types. Owns
 * the OpenAI-specific streaming wiring. The shared stream envelope is
 * `../provider-stream.ts`.
 */
import OpenAI from "openai";
import type { ProviderConfig } from "../../domain/index.js";
import type { ProviderAdapter } from "../../ports/provider-adapter.js";
import { bearerClientOptions, clientForRequest } from "../credentials.js";
import { OPENAI_ENV_OPTOUT, providerClientOptions, providerFetch } from "../provider-http-error.js";
import { streamProvider } from "../provider-stream.js";
import { toOpenAIResponsesParams } from "./request-map.js";
import {
  buildGenerateResult,
  createStreamAccumulator,
  eventsFromResponseStreamEvent,
} from "./stream-collect.js";

export function createOpenAIResponsesAdapter(config: ProviderConfig): ProviderAdapter {
  const own = new OpenAI({
    ...providerClientOptions(config, "https://api.openai.com/v1"),
    ...OPENAI_ENV_OPTOUT,
    ...bearerClientOptions(config.auth, providerFetch),
  });
  const clientFor = clientForRequest(config, own, (credential) =>
    own.withOptions(bearerClientOptions(credential, providerFetch)),
  );
  const providerId = config.id;

  return {
    stream(request, model, call) {
      const acc = createStreamAccumulator(model.id, providerId, call.longCacheWrites);
      return streamProvider({
        start: { type: "start", model: model.id, provider: providerId },
        signal: request.signal,
        open: () =>
          clientFor(request).responses.create(toOpenAIResponsesParams(request, model, call), {
            signal: request.signal,
          }),
        events: (event) => eventsFromResponseStreamEvent(event, acc),
        result: () => buildGenerateResult(acc),
      });
    },
  };
}
