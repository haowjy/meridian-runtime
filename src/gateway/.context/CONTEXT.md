# Gateway

The gateway normalizes Anthropic, OpenAI, Gemini, and OpenAI-compatible providers behind
one streaming `Gateway` port. It owns routing, retry/deadline policy, usage
normalization, cancellation settlement, and provider-error mapping.

## Package boundary

The gateway reads no environment variable itself: keys arrive in `ProviderConfig`, and every SDK client option
that would default from the environment is passed explicitly. The one exception is the SDKs'
own `ANTHROPIC_CUSTOM_HEADERS` and `OPENAI_CUSTOM_HEADERS`, which no client option turns off. Entries (under `@meridian-flow/runtime`): `./gateway` (the port, adapters,
domain types), `./gateway/shapes` (usage, provider error, JSON value: no Node built-ins and no SDKs, so
a host can re-export them into a browser bundle), `./gateway/mock-script` (the mock's zod
script schemas, the one definition a host can re-export) and `./gateway/mock` (the mock server,
which needs `node:http`).

What a host offers, charges and reads from its environment stays in the host: its model list with
prices, its key variables, its observability, its dev overrides. Meridian Flow's is described in
[its gateway wiring CONTEXT](https://github.com/haowjy/meridian-flow/blob/main/apps/server/server/lib/gateway/.context/CONTEXT.md).

## Credentials

A credential is `{ apiKey }` or `{ accessToken: AccessTokenProvider }` (`domain/types.ts`; the provider
returns `{ token, expiresAt }`, Unix seconds or `null`, and is structurally the Anthropic SDK's, so
`oidcFederationProvider(...)` plugs in). Precedence: `GenerateRequest.auth[providerId]`, else
`ProviderConfig.auth`, else none (a placeholder key, for mock and self-hosted endpoints). The request's
map is keyed by provider id so a wrapper that re-routes a request (a host's model override) cannot send one
provider's credential to another; entries for other providers are ignored. `ProviderConfig.headers`
are plain extra headers, not a credential.

- Each adapter keeps one SDK client per `accessToken` function (`adapters/credentials.ts`, a
  `WeakMap`), so a host may build the credential object inline on every call and still share the
  token cache. A key's client is derived per call (a few microseconds, nothing to cache), so a host
  with a key per tenant holds no memory per key.
- An empty `apiKey` is no credential, on the request and in `ProviderConfig.auth` alike: the
  request falls back to the provider's own credential, then to the placeholder key.
- The Anthropic SDK (1.x) sends a key as `Authorization: Bearer`, not `x-api-key`; the API accepts both.
- Every wire authenticates a token the same way. The SDK gets a placeholder key and a `fetch`
  (`bearerFetch`) that replaces `Authorization` with the token and drops `x-api-key` and
  `x-goog-api-key`. `tokenSource` caches the token until 60 s before `expiresAt`, shares one
  in-flight mint per token function, and a mint that rejects keeps its `forceRefresh` for the next
  attempt. Anthropic also gets `anthropic-beta: oauth-2025-04-20` merged into any beta header. The
  Anthropic SDK's own `credentials` is not used: its one 401 refresh needs `maxRetries` above 0,
  which would also retry 5xx and 429 inside a call. Doing it in `fetch` rather than an async
  `apiKey` is what gives Gemini a Bearer at all: the SDK always sends `x-goog-api-key` for a key and
  uses Google ADC without one, but takes a custom `fetch`. A developer-API OAuth token may also
  need `x-goog-user-project`: set it in `ProviderConfig.headers`.
- A 401 on a request that used a token is retried once, inside `fetch`, with a freshly minted token
  (`forceRefresh`). No response byte has reached the caller at that point, and a request body that
  is a stream is not retried. A second 401 is `auth_error`. A 401 on a key is `auth_error` at once.
  Concurrent rejections of one token mint once.
- A token provider that throws ends the call with an error event, classified like an HTTP failure by
  the thrown error's `status` (403 is `auth_error`, 5xx retryable). Without a status it is a
  retryable `provider_error`. An SDK that wraps the failure (OpenAI's "Connection error.") is read
  through `error.cause`. The text is the host provider's own: the gateway adds nothing to it, so
  the provider must keep secrets out of its error messages.
- The gateway never serializes a request, a config or a credential into events, spans or error
  messages; error text comes from the provider's response or the token provider's own message. A
  host that captures requests must leave `auth` out: copy the fields it wants, not the request minus a denylist.

## Port and attempt policy

`Gateway.stream()` yields canonical `StreamEvent`s and `listModels()` completes the port.
A stop ends the stream with exactly one
`end`, built in the shared envelope (`adapters/provider-stream.ts`) from what the adapter had
accumulated: the envelope races the SDK against the abort, so a rejecting, returning or hung SDK
all end at once, with the text and usage so far. `attempt-stream.ts` stamps that `end` (and any
real `end` after the stop) with `finishReason: null`, since the adapter's reason says nothing true,
and with `missing_usage` when no provider usage arrived. A timeout aborts the same signal but
stays an error: `attempt-stream.ts` turns an `end` that follows a timeout into the timeout error.
A stop before an attempt starts, including one during retry backoff, made no call and ends the
stream with no events and no response.
Where the routed model is known, `attempt-stream.ts` calls `resolveCall()`
(`domain/resolve-call.ts`, given `GatewayConfig.reasoningLevels`) once and hands the adapter a `ResolvedCall`:
`{ cacheTtlSeconds, longCacheWrites, reasoning: "default" | { effort } }`. Adapters
only map it to wire fields and reject at construction (`assertCacheTtlsOnWire`) a model
whose cache lifetimes they cannot send. The host's model list (`ProviderConfig.models`) maps
model IDs to provider adapters and carries, per model, context, pricing, cache descriptor and the
required tokenizer family. Duplicate model IDs warn during construction rather than silently replacing
an entry. Where a host keeps those facts and how it checks them is the host's own.

`attempt-stream.ts` is the only retry layer. Provider SDK retries are disabled.
Retry occurs only before committed text or tool output; reasoning-only
output is retryable. Backoff honors provider retry hints and is abort-aware.
Each attempt has an inactivity stall timer and an absolute ceiling timer on one
derived signal. Every stream event re-arms the stall timer, so a slow model that
keeps streaming is never killed; the ceiling is a backstop, not the normal end.
`attemptStallMs` and `attemptCeilingMs` in the gateway config override the defaults in
`deadline.ts` (`DEFAULT_ATTEMPT_STALL_MS`, `DEFAULT_ATTEMPT_CEILING_MS`); 0
disables either. A timeout is a retryable provider error. Iterator cleanup
cannot hold cancellation hostage.

## Canonicalization and errors

Adapters normalize provider usage into the shared `Usage` contract and validate
it before returning. Provider counters differ, so adapters, not a host's billing
code, own cache-counter conversion. Cancelled-call settlement is generic and
owned by the gateway.

A close is `ok`, `error`, or `cancelled`. `cancelled` requires causal abort
evidence: the thrown error is the signal reason or an `AbortError`; message text
such as "Aborted" is insufficient. Error codes populate both provider-facing
close metadata and correlation fields.

One HTTP error policy handles all adapters: network/408/429/5xx retry; 401/403
map to `auth_error`; 400 matches shared `invalid_request`, `context_overflow`,
or `content_filtered` patterns; other 4xx are non-retryable provider errors.
`x-should-retry: false` wins. Context-window refusals normalize to
`context_overflow` with metered partial usage so the caller can trim the history and retry once.

Provider terminal failure/truncation takes precedence over accumulated tool calls:
OpenAI incomplete/failed responses and compatible length/content-filter finishes
never become successful tool-use just because a call was streamed earlier.

The dev mock selects a queued step, a built-in trigger, or its configured default,
then sends every normal response through `adapters/mock/response.ts`. Samples,
lorem, literal content and tool calls share JSON/SSE serialization, synthetic
byte-derived usage and cancellation-aware pacing. The mock's configured default response is tool-free; `times` belongs only to the script queue. Deliberately malformed
or hanging transport probes stay separate.

The compatible accumulator persists visible `reasoning_content` as a canonical
reasoning part before text and tools. This carries no provider signature or
replay metadata. Like text, it is included in the adapter's partial result on cancellation;
whether to keep it is the caller's choice. This does not change
the gateway's reasoning-only retry rule. The Chat Completions protocol does not
supply arbitrary block positions.

The mock reports request-derived synthetic input usage so a host can test its history
trimming against long histories. These counters test control flow, not provider
pricing or cache performance.

Malformed tool-argument JSON is repaired at the gateway helper or surfaced as a
typed parse refusal. Tool execution still validates the original Zod contract;
provider advertisement is not argument authority.

## Media

One part, `MediaPart` (`{ type: "media", mediaType, filename?, source }`), carries an image or a
PDF in a user message and inside a `ToolResultPart`, whose `content` is an array of text and media
parts. `source` is `{ url }` (https only; a data URL is refused), `{ data }` (base64) or
`{ reference: { provider, id } }` (a provider's own file id, for the provider that issued it; no
mapper sends one yet and one reaching a mapper is an error). `mediaType` is required and never
guessed from a URL. A mapper never downloads a link: a source its wire can't take is an error,
and the caller decides between link and bytes before building the request: only the caller knows
where a file lives and how often the same file is sent.

Two levels, in `domain/media.ts`. The model says what it takes: `ModelInfo.inputModalities`
(models.dev's `modalities.input`) and `maxLinkBytes`, the largest file its provider fetches by
link where documented. The wire (`ModelInfo.wire`, stamped from the provider's adapter when the
gateway is built) says whether a link works per kind and where a tool result's media goes.
`placeMedia(model, { mediaType, sizeBytes? })` answers `link`, `bytes` or `none` plus the
placement; it takes the model, not the wire, so the Gemini wire can key placement on the
model's `geminiV3Calls` (nested `functionResponse` parts need Gemini 3, and `placeMedia` answers
`none` for a file in a tool result, with `inToolResult`, for a Gemini model without it). The gateway
never reads a model id: `maxPdfPages` (a PDF over it is `none`; unset means no page cap) and
`geminiV3Calls` are set by the host.
It also answers `none` for an image type the wire doesn't accept (each wire lists its types), so
the caller can send the preview instead.

| Wire | Link | Tool result media |
|---|---|---|
| `anthropic` (Messages) | image, PDF | inside `tool_result.content` as `image`/`document` blocks; an `is_error` result carries text only (Anthropic rejects media in it) and its media follow the tool results in the same user message |
| `openai` (Responses) | image, PDF | inside `function_call_output.output` as `input_image`/`input_file` |
| `openai-compatible` (Chat Completions) | image only, and only where the provider's `imageLinks` is set (default: bytes) | one user message after the run of `tool` messages, each attachment group named by its tool call; a PDF is bytes only (`file` with `file_data`) |
| `gemini` (native `generateContent`) | image, PDF (`fileData`, up to 15 MB) | `geminiV3Calls` models: inside `functionResponse.parts` (`fileData` or `inlineData`); others: none |

Image types by wire: Anthropic JPEG, PNG, GIF, WebP; OpenAI and Chat Completions PNG, JPEG, WebP, GIF;
Gemini PNG, JPEG, WebP, HEIC, HEIF (Google lists only PNG, JPEG and WebP for a function response
and nothing rejects the others before the request).
Whether a Chat Completions host fetches image links is that host's fact, so it is
`ProviderConfig.imageLinks` (stamped on `ModelInfo.imageLinks`), not assumed of the wire.

A PDF sent as bytes always has a filename (`document.pdf` by default); one sent by link needs none.
Provider facts and the reasons behind this are in
[files the model sees](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/agents/files-the-model-sees.md).

## Gemini adapter

`adapters/gemini/` calls the native `generateContent` API through `@google/genai`; the SDK reads
every environment option (the key, Vertex mode, project, location, base URL, API version)
only when it is unset, so the adapter passes each, and it retries nothing unless `retryOptions`
is set, which it never is. If the machine sets both of the SDK's own Google key variables it
prints a console warning (once per client), and the explicit key still wins.

- A tool result is a `functionResponse` named for its call, found from the earlier `tool_use`;
  results of parallel calls share one user turn (adjacent same-role messages merge).
- Thought signatures live in `providerOptions.gemini.signature` beside `meridian: {provider,
  model}` on the text, reasoning or `tool_use` part they came on, and go back only to that
  provider/model. A replayed first function call of a `geminiV3Calls` model without one gets
  `skip_thought_signature_validator`, Google's documented bypass, because Gemini 3 refuses the
  step otherwise (history from another model, or one with its thinking removed).
- `Usage` folds thought tokens into `outputTokens` and tool-use prompt tokens into `inputTokens`.
  A file fetched by link is counted in `totalTokenCount` only (`promptTokenCount` is absent), so
  the input is read from the total.
- Google answers a bad key with 400 `API_KEY_INVALID`; the adapter maps it to `auth_error`. The
  SDK's `ApiError` keeps the body as JSON text (twice wrapped for a non-JSON-typed body) and drops
  the headers, so `geminiErrorShape` rebuilds the status, message and `RetryInfo` delay for the
  shared error mapping.
- No cache mark is sent; `automaticFunctionCalling` and `automaticContinuation` are off, so the
  SDK never loops or re-sends a request behind the gateway's retry layer.

## Cache, reasoning and tool schemas

A model entry carries its offering's `promptCache: { kind, shortTtlSeconds, longTtlSeconds }`; `null`
means the provider documents no lifetime, which is unknown, not infinite (a host's cache prediction
should read it as cold). Each adapter keeps one table of the
lifetimes its wire can express, used for both the creation-time check (`assertModelsOnWire`) and the
request mapping (OpenAI: 30m and 12h; Anthropic: 5m and 1h, explicit models only; Gemini: none, its
implicit cache documents no lifetime and takes no mark).

`GenerateRequest.promptCacheRetention` is required: `long`, `short`, or `none`, which resolves to a null
lifetime so no mark is sent (OpenAI still keeps its 30m default; the gateway can't turn it off).
`longCacheWrites` is true when the request is long and the two lifetimes differ; when a provider omits the
cache-write split by lifetime, adapters attribute all writes to the lifetime the request asked for.

Only `explicit` offerings get `cache_control`. The Anthropic adapter marks the last system
block and the last block of the two most recent wire `user` messages (tool results are user
turns there), walking back past a block that cannot carry a mark (thinking, empty text);
DeepSeek gets none and keeps a joined `system` string. The request carries no marks of its own, so every
Anthropic-format request is marked the same way.

`Usage.cacheWriteLongTokens` (Anthropic's `cache_creation.ephemeral_1h_input_tokens`; OpenAI's
`cache_write_tokens_details.ttl_12h_tokens`) is the long part of `cacheWriteTokens`, for a host that
bills the two rates apart.

Reasoning is data. A model row's `reasoning.efforts` lists its levels (models.dev's
`reasoning_options`, lowest first; `none` means it can switch off), and the host passes the ladder those
names sit on as `GatewayConfig.reasoningLevels`. The package keeps no level list. `resolveReasoning(requested,
support, levels)` (pure, exported from the browser-safe `./gateway` so a UI can show the level a call runs
at) returns `default` for an absent request; the requested level when the model lists it; else the listed
level nearest on the ladder (a tie goes up, never onto `none` unless `none` was asked, so asking `none` of
a model that can't switch off gives its lowest other level); else `default` when nothing can be picked.
Adapters translate only `none`. Anthropic (Claude and DeepSeek) sends a level as `output_config.effort` and
`none` as `thinking: {type: "disabled"}`; OpenAI Responses sends `reasoning.effort` with `summary: "auto"` (`none` without the summary);
`openai-compatible` sends `reasoning_effort` (nothing for `none`); Gemini sends `thinkingLevel` upper-cased
and `none` as `thinkingBudget: 0`. A model that declares `reasoning.thinksByDefault` gets an empty thinking
block before a replayed `tool_use` unless the call resolves to `none`.

A provider row declares `projectToolSchema` (copied onto `ModelInfo`; only Anthropic) to get
`anthropicToolSchema` on its tools; the adapter reads the flag and `model.provider`, never a provider id
literal. Direct Anthropic rejects a root `oneOf` or `anyOf`, so the adapter advertises one object
envelope carrying each command's purpose, required and allowed fields, and command-tagged descriptions
generated from the Zod branches; execution validates the unchanged canonical schema. Other providers
receive the canonical unions unchanged, and a root `allOf` is refused at tool registration.

No request sets an output limit: adapters that require an explicit provider field send the model's
`maxOutputTokens`, and the others leave the provider default.
