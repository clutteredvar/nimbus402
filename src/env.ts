/**
 * Environment parsing.
 *
 * Hand-rolled on purpose. Pulling in a schema library to validate eight
 * variables costs more than it saves, and the error messages a service
 * prints on boot are the first thing an operator reads when their deploy
 * does not come up — worth writing by hand.
 */

export type NetworkKey = "mainnet" | "testnet";

export interface ServiceEnv {
  readonly payTo: string;
  readonly networkKey: NetworkKey;
  readonly facilitatorUrl: string;
  readonly port: number;
  readonly cacheTtlSeconds: number;
  readonly upstreamTimeoutMs: number;
  /** route id -> USD price string, e.g. { forecast: "0.002" } */
  readonly prices: Readonly<Record<string, string>>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 0x followed by 40 hex chars. Deliberately strict: a typo'd payout address is unrecoverable. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function readAddress(source: NodeJS.ProcessEnv, key: string): string {
  const raw = (source[key] ?? "").trim();
  if (raw === "") {
    throw new ConfigError(
      `${key} is required — set it to the EVM address that should receive payments`,
    );
  }
  if (!EVM_ADDRESS.test(raw)) {
    throw new ConfigError(`${key} must be a 0x-prefixed 40-byte hex address, got "${raw}"`);
  }
  return raw;
}

function readInt(source: NodeJS.ProcessEnv, key: string, fallback: number, min: number): number {
  const raw = (source[key] ?? "").trim();
  if (raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(`${key} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

export function readNetwork(source: NodeJS.ProcessEnv): NetworkKey {
  const raw = (source.KITE_NETWORK ?? "mainnet").trim().toLowerCase();
  if (raw === "" || raw === "mainnet") return "mainnet";
  if (raw === "testnet") return "testnet";
  throw new ConfigError(`KITE_NETWORK must be "mainnet" or "testnet", got "${raw}"`);
}

/**
 * @param priceDefaults route id -> default price, so the schema of what this
 *        service sells lives with the route table rather than in this file.
 */
export function loadEnv(
  source: NodeJS.ProcessEnv = process.env,
  priceDefaults: Readonly<Record<string, string>> = {},
): ServiceEnv {
  const prices: Record<string, string> = {};
  for (const [id, fallback] of Object.entries(priceDefaults)) {
    const override = (source[`PRICE_${id.toUpperCase().replace(/-/g, "_")}`] ?? "").trim();
    const price = override === "" ? fallback : override;
    if (!/^\$?\d+(\.\d+)?$/.test(price) || Number(price.replace(/^\$/, "")) <= 0) {
      throw new ConfigError(`price for "${id}" must be a positive decimal, got "${price}"`);
    }
    prices[id] = price;
  }

  const facilitatorUrl = (source.FACILITATOR_URL ?? "https://facilitator.pieverse.io/v2").trim();
  if (!/^https?:\/\//.test(facilitatorUrl)) {
    throw new ConfigError(`FACILITATOR_URL must be an http(s) URL, got "${facilitatorUrl}"`);
  }

  return {
    payTo: readAddress(source, "PAY_TO"),
    networkKey: readNetwork(source),
    facilitatorUrl,
    port: readInt(source, "PORT", 8787, 1),
    cacheTtlSeconds: readInt(source, "CACHE_TTL_SECONDS", 45, 0),
    upstreamTimeoutMs: readInt(source, "UPSTREAM_TIMEOUT_MS", 4000, 100),
    prices,
  };
}
