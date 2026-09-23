/**
 * Kite settlement chains.
 *
 * Both Kite networks pay in EIP-3009 stablecoins, which means the payer signs
 * a `transferWithAuthorization` — and the facilitator re-derives the EIP-712
 * domain hash to check that signature. So the challenge has to carry the
 * token's domain (name + version) alongside the contract address. Get the
 * name wrong and verifying fails forever with no useful error.
 */
import type { MoneyParser, Network } from "@x402/core/types";

export interface StablecoinInfo {
  /** Contract address of the settling token. */
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  /** EIP-712 domain fields the facilitator hashes. */
  readonly domainName: string;
  readonly domainVersion: string;
}

export interface SettlementChain {
  readonly key: "mainnet" | "testnet";
  readonly network: Network;
  readonly displayName: string;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  readonly stablecoin: StablecoinInfo;
}

export const SETTLEMENT_CHAINS: Readonly<Record<"mainnet" | "testnet", SettlementChain>> = {
  mainnet: {
    key: "mainnet",
    network: "eip155:2366",
    displayName: "Kite mainnet",
    rpcUrl: "https://rpc.gokite.ai",
    explorerUrl: "https://kitescan.ai",
    stablecoin: {
      address: "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e",
      symbol: "USDC.e",
      decimals: 6,
      domainName: "Bridged USDC (Kite AI)",
      domainVersion: "2",
    },
  },
  testnet: {
    key: "testnet",
    network: "eip155:2368",
    displayName: "Kite testnet",
    rpcUrl: "https://rpc-testnet.gokite.ai",
    explorerUrl: "https://testnet.kitescan.ai",
    stablecoin: {
      address: "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A",
      symbol: "pieUSD",
      decimals: 18,
      domainName: "pieUSD",
      domainVersion: "1",
    },
  },
};

/** Kite's hosted facilitator. The /v2 prefix is part of the base URL — keep it. */
export const DEFAULT_FACILITATOR = "https://facilitator.pieverse.io/v2";

/**
 * Turn "0.002" / "$0.002" / 0.002 into atomic units.
 *
 * Exported because the price catalog endpoint shows the same numbers the
 * challenge carries, and those two must never drift apart.
 */
export function toAtomicUnits(price: string | number, decimals: number): bigint {
  const text = typeof price === "number" ? price.toFixed(decimals) : price.trim().replace(/^\$/, "");

  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`price "${String(price)}" is not a plain positive decimal`);
  }

  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > decimals) {
    throw new Error(
      `price "${text}" needs ${fraction.length} decimal places but the token only has ${decimals}`,
    );
  }

  const atomic = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (atomic <= 0n) {
    throw new Error(`price "${text}" rounds down to zero atomic units`);
  }
  return atomic;
}

/**
 * Money parser handed to the SDK's ExactEvmScheme.
 *
 * The SDK keeps a built-in table of known stablecoins; Kite's are not in it,
 * so without this parser pricing a route on eip155:2366 throws. Returning
 * `null` from a parser defers to the next one in the chain, which is why the
 * network check comes first.
 */
export function kiteMoneyParser(chain: SettlementChain, fallbackPrice: string | number = "0"): MoneyParser {
  return async (amount, network) => {
    if (network !== chain.network) return null;
    const atomic = toAtomicUnits(amount ?? fallbackPrice, chain.stablecoin.decimals);
    return {
      asset: chain.stablecoin.address,
      amount: atomic.toString(),
      extra: {
        name: chain.stablecoin.domainName,
        version: chain.stablecoin.domainVersion,
      },
    };
  };
}

/** Human-readable price for the catalog, e.g. "0.002" -> "0.002 USDC.e". */
export function formatPrice(chain: SettlementChain, price: string): string {
  return `${price.trim().replace(/^\$/, "")} ${chain.stablecoin.symbol}`;
}
