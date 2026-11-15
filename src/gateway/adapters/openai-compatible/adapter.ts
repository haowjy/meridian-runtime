/**
 * OpenAI-compatible (Chat Completions) provider adapter: implements the
 * provider-adapter port over any OpenAI-Chat-Completions-shaped endpoint
 * (gemini, mock, self-hosted). Owns the chat-completions streaming wiring. The
 * shared stream envelope is `../provider-stream.ts`.
 *
 * Its accumulator takes no `longCacheWrites`: this wire reports no cache writes.
 */
import OpenAI from "openai";
import type { ProviderConfig } from "../../domain/index.js";
import type { ProviderAdapter } from "../../ports/provider-adapter.js";
import { bearerClientOptions, clientForRequest } from "../credentials.js";
import { OPENAI_ENV_OPTOUT, providerClientOptions, providerFetch } from "../provider-http-error.js";
import { streamProvider } from "../provider-stream.js";
import { toOpenAIChatCompletionParams } from "./request-map.js";
import {
  buildGenerateResult,
  createStreamAccumulator,
  eventsFromOpenAIChunk,
} from "./stream-collect.js";

export function createOpenAICompatibleAdapter(config: ProviderConfig): ProviderAdapter {
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
      const acc = createStreamAccumulator(model.id, providerId);
      return streamProvider({
        start: { type: "start", model: model.id, provider: providerId },
        signal: request.signal,
        open: () =>
          clientFor(request).chat.completions.create(
            { ...toOpenAIChatCompletionParams(request, model, call), stream: true },
            { signal: request.signal },
          ),
        events: (chunk) => eventsFromOpenAIChunk(chunk, acc),
        result: () => buildGenerateResult(acc),
      });
    },
  };
}
