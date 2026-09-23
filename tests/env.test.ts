/**
 * Environment handling. A misconfigured payout address or a price with too
 * much precision should stop the process at boot, not surface as a confusing
 * facilitator error under load.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadEnv, readNetwork } from "../src/env.js";

const PAY_TO = "0x1234567890123456789012345678901234567890";
const DEFAULTS = { forecast: "0.002", climate: "0.01" };

describe("loadEnv", () => {
  test("fills in defaults and keeps the given payout address", () => {
    const env = loadEnv({ PAY_TO }, DEFAULTS);
    assert.equal(env.payTo, PAY_TO);
    assert.equal(env.networkKey, "mainnet");
    assert.equal(env.port, 8787);
    assert.equal(env.cacheTtlSeconds, 45);
    assert.equal(env.facilitatorUrl, "https://facilitator.pieverse.io/v2");
    assert.deepEqual(env.prices, { forecast: "0.002", climate: "0.01" });
  });

  test("a missing payout address is fatal", () => {
    assert.throws(() => loadEnv({}, DEFAULTS), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match((error as Error).message, /PAY_TO is required/);
      return true;
    });
  });

  test("a malformed payout address is fatal", () => {
    assert.throws(() => loadEnv({ PAY_TO: "0xnope" }, DEFAULTS), /40-byte hex address/);
    assert.throws(() => loadEnv({ PAY_TO: "1234567890123456789012345678901234567890" }, DEFAULTS), /0x-prefixed/);
  });

  test("per-route price overrides win over the defaults", () => {
    const env = loadEnv({ PAY_TO, PRICE_FORECAST: "0.005", PRICE_AIR_QUALITY: "0.0005" }, {
      ...DEFAULTS,
      "air-quality": "0.001",
    });
    assert.equal(env.prices.forecast, "0.005");
    assert.equal(env.prices["air-quality"], "0.0005");
    assert.equal(env.prices.climate, "0.01");
  });

  test("a nonsense price override is fatal rather than silently ignored", () => {
    assert.throws(() => loadEnv({ PAY_TO, PRICE_FORECAST: "free" }, DEFAULTS), /positive decimal/);
    assert.throws(() => loadEnv({ PAY_TO, PRICE_FORECAST: "0" }, DEFAULTS), /positive decimal/);
  });

  test("numeric variables reject negatives and non-integers", () => {
    assert.throws(() => loadEnv({ PAY_TO, PORT: "-1" }, DEFAULTS), /PORT must be an integer/);
    assert.throws(() => loadEnv({ PAY_TO, UPSTREAM_TIMEOUT_MS: "1.5" }, DEFAULTS), /integer >= 100/);
    assert.equal(loadEnv({ PAY_TO, CACHE_TTL_SECONDS: "0" }, DEFAULTS).cacheTtlSeconds, 0);
  });

  test("facilitator URL has to look like a URL", () => {
    assert.throws(() => loadEnv({ PAY_TO, FACILITATOR_URL: "pieverse.io" }, DEFAULTS), /http\(s\) URL/);
  });
});

describe("readNetwork", () => {
  test("defaults to mainnet when unset or blank", () => {
    assert.equal(readNetwork({}), "mainnet");
    assert.equal(readNetwork({ KITE_NETWORK: "  " }), "mainnet");
    assert.equal(readNetwork({ KITE_NETWORK: "MAINNET" }), "mainnet");
  });

  test("recognises testnet", () => {
    assert.equal(readNetwork({ KITE_NETWORK: "testnet" }), "testnet");
  });

  test("refuses anything else", () => {
    assert.throws(() => readNetwork({ KITE_NETWORK: "sepolia" }), /mainnet.*testnet/);
  });
});
