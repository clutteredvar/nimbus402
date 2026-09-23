/**
 * Chain parameters and price maths. These are the numbers that, if wrong,
 * quietly fail signature verification in production — so they are pinned.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FACILITATOR,
  SETTLEMENT_CHAINS,
  formatPrice,
  kiteMoneyParser,
  toAtomicUnits,
} from "../src/billing/chains.js";

describe("settlement chain registry", () => {
  test("mainnet settles USDC.e on eip155:2366 with a 6-decimal token", () => {
    const { stablecoin, network } = SETTLEMENT_CHAINS.mainnet;
    assert.equal(network, "eip155:2366");
    assert.equal(stablecoin.symbol, "USDC.e");
    assert.equal(stablecoin.decimals, 6);
    assert.equal(stablecoin.address, "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e");
    // The facilitator hashes these two strings; a typo means every payment
    // fails verification with a message that points nowhere near the cause.
    assert.equal(stablecoin.domainName, "Bridged USDC (Kite AI)");
    assert.equal(stablecoin.domainVersion, "2");
  });

  test("testnet settles pieUSD with 18 decimals on eip155:2368", () => {
    const { stablecoin, network } = SETTLEMENT_CHAINS.testnet;
    assert.equal(network, "eip155:2368");
    assert.equal(stablecoin.symbol, "pieUSD");
    assert.equal(stablecoin.decimals, 18);
    assert.equal(stablecoin.domainName, "pieUSD");
    assert.equal(stablecoin.domainVersion, "1");
  });

  test("facilitator default keeps the /v2 path segment", () => {
    assert.equal(DEFAULT_FACILITATOR, "https://facilitator.pieverse.io/v2");
  });
});

describe("toAtomicUnits", () => {
  test("scales by the token decimals", () => {
    assert.equal(toAtomicUnits("0.002", 6), 2000n);
    assert.equal(toAtomicUnits("0.001", 6), 1000n);
    assert.equal(toAtomicUnits("0.01", 6), 10000n);
    assert.equal(toAtomicUnits("1", 6), 1_000_000n);
  });

  test("handles 18-decimal tokens", () => {
    assert.equal(toAtomicUnits("0.5", 18), 500_000_000_000_000_000n);
    assert.equal(toAtomicUnits("0.000000000000000001", 18), 1n);
  });

  test("accepts a dollar sign and a numeric price", () => {
    assert.equal(toAtomicUnits("$0.002", 6), 2000n);
    assert.equal(toAtomicUnits(0.002, 6), 2000n);
  });

  test("refuses more precision than the token has", () => {
    // 0.0000001 USDC.e would be unrepresentable; rounding it silently would
    // mean charging someone a different price than the catalog advertises.
    assert.throws(() => toAtomicUnits("0.0000001", 6), /decimal places/);
  });

  test("refuses garbage and non-positive prices", () => {
    assert.throws(() => toAtomicUnits("free", 6), /plain positive decimal/);
    assert.throws(() => toAtomicUnits("0", 6), /rounds down to zero/);
    assert.throws(() => toAtomicUnits(0, 6), /rounds down to zero/);
  });
});

describe("kiteMoneyParser", () => {
  test("prices a route with the contract address and EIP-712 domain", async () => {
    const parser = kiteMoneyParser(SETTLEMENT_CHAINS.mainnet);
    const priced = await parser("0.002", "eip155:2366");
    assert.deepEqual(priced, {
      asset: "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e",
      amount: "2000",
      extra: { name: "Bridged USDC (Kite AI)", version: "2" },
    });
  });

  test("defers to the next parser on an unknown network", async () => {
    const parser = kiteMoneyParser(SETTLEMENT_CHAINS.mainnet);
    assert.equal(await parser("0.002", "eip155:8453"), null);
  });

  test("still refuses an impossible price", async () => {
    const parser = kiteMoneyParser(SETTLEMENT_CHAINS.mainnet);
    await assert.rejects(async () => parser("0.0000001", "eip155:2366"), /decimal places/);
  });
});

describe("formatPrice", () => {
  test("drops a leading dollar sign and names the asset", () => {
    assert.equal(formatPrice(SETTLEMENT_CHAINS.mainnet, "$0.002"), "0.002 USDC.e");
    assert.equal(formatPrice(SETTLEMENT_CHAINS.testnet, "0.01"), "0.01 pieUSD");
  });
});
