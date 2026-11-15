/**
 * Per-call credentials for the adapters. A request's credential for the routed provider
 * replaces the provider's own (`ProviderConfig.auth`). Each adapter keeps one SDK client per
 * token function, so calls with the same `accessToken` share its token cache whether or not the
 * host reuses the credential object; a key's client is derived per call.
 *
 * Every wire authenticates a token through `bearerFetch`: the SDK is given a placeholder key,
 * and every request's `Authorization` header is replaced with the cached token. One rule
 * decides the refresh: a 401 on a request that used a token is retried once with a fresh one.
 */
import type {
  AccessToken,
  AccessTokenProvider,
  GenerateRequest,
  ProviderConfig,
  ProviderCredential,
} from "../domain/index.js";

/** Mint a new token this long before `expiresAt`, so one never expires in flight. */
const EXPIRY_MARGIN_SECONDS = 60;

/** Placeholder for SDKs that refuse to start without a key: self-hosted and mock endpoints need none. */
export const PLACEHOLDER_KEY = "not-needed";

type TokenSource = {
  get(): Promise<string>;
  /** The provider rejected `rejected`: the next `get` mints a new one with `forceRefresh`. */
  invalidate(rejected: string): void;
};

/**
 * Caches one provider's token until shortly before it expires. Concurrent `get`s share one
 * mint, which also keeps single-use identity tokens from being spent twice. A token with no
 * `expiresAt` is kept until the provider rejects it.
 */
function tokenSource(provider: AccessTokenProvider): TokenSource {
  let cached: AccessToken | undefined;
  let minting: Promise<AccessToken> | undefined;
  let force = false;
  return {
    async get() {
      if (
        cached &&
        (cached.expiresAt === null || cached.expiresAt - Date.now() / 1000 > EXPIRY_MARGIN_SECONDS)
      ) {
        return cached.token;
      }
      if (!minting) {
        const forceRefresh = force;
        force = false;
        minting = provider(forceRefresh ? { forceRefresh } : undefined)
          .then((token) => {
            cached = token;
            return token;
          })
          .catch((error: unknown) => {
            // A rejected mint must not lose the instruction to refresh.
            force ||= forceRefresh;
            throw error;
          })
          .finally(() => {
            minting = undefined;
          });
      }
      return (await minting).token;
    },
    invalidate(rejected) {
      // Concurrent requests rejected with the same token invalidate once: a later one
      // must not discard the token the first one already replaced it with.
      if (cached?.token !== rejected) return;
      cached = undefined;
      force = true;
    },
  };
}

/**
 * `fetch` for a client that authenticates with a token: sends `Authorization: Bearer <token>`
 * and drops any key header the SDK added from its placeholder. The token is minted per
 * request, not per client, so it can be refreshed mid-life.
 *
 * A 401 means the token is bad and no response byte has reached the caller, so the request is
 * sent once more with a fresh token. A second 401 is returned as it is. A request body that
 * cannot be replayed (a stream) is not retried; the next call mints a fresh token.
 */
function bearerFetch(
  provider: AccessTokenProvider,
  base: typeof fetch,
  prepare: (headers: Headers) => void,
): typeof fetch {
  const source = tokenSource(provider);
  const send = async (input: Parameters<typeof fetch>[0], init: RequestInit | undefined) => {
    const token = await source.get();
    const headers = new Headers(init?.headers);
    headers.delete("x-api-key");
    headers.delete("x-goog-api-key");
    headers.set("Authorization", `Bearer ${token}`);
    prepare(headers);
    const response = await base(input, { ...init, headers });
    if (response.status === 401) source.invalidate(token);
    return response;
  };
  return async (input, init) => {
    const response = await send(input, init);
    const replayable = !(input instanceof Request) && !(init?.body instanceof ReadableStream);
    if (response.status !== 401 || !replayable) return response;
    await response.body?.cancel();
    return send(input, init);
  };
}

/** Anthropic's OAuth bearer tokens need this beta, next to any beta the request already names. */
function anthropicOAuthBeta(headers: Headers) {
  const beta = headers.get("anthropic-beta");
  headers.set("anthropic-beta", beta ? `${beta},oauth-2025-04-20` : "oauth-2025-04-20");
}

/** The `fetch` and `apiKey` client options for a wire carrying `credential`. */
export function bearerClientOptions(
  credential: ProviderCredential | undefined,
  base: typeof fetch,
  wire: "anthropic" | "other" = "other",
): { apiKey: string; fetch: typeof fetch } {
  if (credential && "accessToken" in credential) {
    return {
      apiKey: PLACEHOLDER_KEY,
      fetch: bearerFetch(
        credential.accessToken,
        base,
        wire === "anthropic" ? anthropicOAuthBeta : () => {},
      ),
    };
  }
  return { apiKey: credential?.apiKey || PLACEHOLDER_KEY, fetch: base };
}

/**
 * The client for a request: the provider's own, or one derived from the request's credential
 * for this provider; an empty key is no credential. Credentials for other providers are
 * ignored. A token's client is kept by its token function, so its token cache survives across
 * calls; a key's client is derived per call, since it caches nothing and is cheap to build.
 */
export function clientForRequest<Client>(
  config: Pick<ProviderConfig, "id">,
  own: Client,
  derive: (credential: ProviderCredential) => Client,
): (request: GenerateRequest) => Client {
  const byToken = new WeakMap<AccessTokenProvider, Client>();
  return (request) => {
    const credential = request.auth?.[config.id];
    if (!credential || ("apiKey" in credential && !credential.apiKey)) return own;
    if ("accessToken" in credential) {
      let client = byToken.get(credential.accessToken);
      if (!client) {
        client = derive(credential);
        byToken.set(credential.accessToken, client);
      }
      return client;
    }
    return derive(credential);
  };
}
