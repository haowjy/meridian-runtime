/**
 * Gateway port: the provider-neutral interface (stream/listModels) a host depends on instead of
 * any concrete provider.
 *
 * A caller runs `gateway.stream(request)` to get an AsyncIterable<StreamEvent> and never knows
 * which provider is behind the call.
 *
 * Why a port: adapters are chosen by config (see create-gateway.ts). The host builds the gateway
 * once from GatewayConfig and never imports a concrete adapter factory.
 */
import type { GenerateRequest, ModelInfo, StreamEvent } from "../domain/index.js";

export interface Gateway {
  stream(request: GenerateRequest): AsyncIterable<StreamEvent>;
  listModels(): ModelInfo[];
  getDefaultModel(): string | undefined;
}
