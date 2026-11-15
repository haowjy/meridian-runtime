/**
 * Per-call credentials for the adapters. A request's credential for the routed provider
 * replaces the provider's own (`ProviderConfig.auth`); each adapter derives one SDK client
 * per credential object and reuses it, so a host that keeps its credential objects keeps the
 * client's connection state and the token cache with them.
 *
 * Anthropic's SDK caches, refreshes and invalidates tokens itself. The other wires use
 * `bearerFetch`: the SDK is given a placeholder key, and every request's `Authorization`
 * header is replaced with the cached token.
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
  /** The provider rejected the last token: the next `get` mints a new one with `forceRefresh`. */
  invalidate(): void;
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
          .finally(() => {
            minting = undefined;
          });
      }
      return (await minting).token;
    },
    invalidate() {
      cached = undefined;
      force = true;
    },
  };
}

/**
 * `fetch` for a client that authenticates with a token: sends `Authorization: Bearer <token>`
 * and drops any key header the SDK added from its placeholder. A 401 invalidates the token.
 * The token is minted per request, not per client, so it can be refreshed mid-life.
 */
function bearerFetch(provider: AccessTokenProvider, base: typeof fetch): typeof fetch {
  const source = tokenSource(provider);
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("x-goog-api-key");
    headers.set("Authorization", `Bearer ${await source.get()}`);
    const response = await base(input, { ...init, headers });
    if (response.status === 401) source.invalidate();
    return response;
  };
}

/** The `fetch` and `apiKey` client options for a non-Anthropic wire carrying `credential`. */
export function bearerClientOptions(
  credential: ProviderCredential | undefined,
  base: typeof fetch,
): { apiKey: string; fetch: typeof fetch } {
  if (credential && "accessToken" in credential) {
    return { apiKey: PLACEHOLDER_KEY, fetch: bearerFetch(credential.accessToken, base) };
  }
  return { apiKey: credential?.apiKey || PLACEHOLDER_KEY, fetch: base };
}

/**
 * The client for a request: the provider's own, or one derived from the request's credential
 * for this provider. Credentials for other providers are ignored.
 */
export function clientForRequest<Client>(
  config: Pick<ProviderConfig, "id">,
  own: Client,
  derive: (credential: ProviderCredential) => Client,
): (request: GenerateRequest) => Client {
  const derived = new WeakMap<ProviderCredential, Client>();
  return (request) => {
    const credential = request.auth?.[config.id];
    if (!credential) return own;
    let client = derived.get(credential);
    if (!client) {
      client = derive(credential);
      derived.set(credential, client);
    }
    return client;
  };
}
