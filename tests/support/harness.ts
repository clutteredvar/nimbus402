/**
 * Shared test scaffolding.
 *
 * The stub facilitator owns verify/settle/getSupported and records the order
 * it was called in — which is how the "verify happens before settle" and
 * "nothing settles on a failed handler" assertions are made, rather than by
 * inspecting side effects on a real chain.
 */
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";
import type { Hono } from "hono";
import { buildApp } from "../../src/app.js";
import { loadEnv, type ServiceEnv } from "../../src/env.js";
import { SETTLEMENT_CHAINS, type SettlementChain } from "../../src/billing/chains.js";
import { DATA_ROUTES, priceDefaults } from "../../src/routes/weather.js";
import { UsageMeter } from "../../src/support/meter.js";

export const TEST_PAY_TO = "0x1234567890123456789012345678901234567890";
export const TEST_PAYER = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
export const CHAIN: SettlementChain = SETTLEMENT_CHAINS.mainnet;

type Call = { kind: "verify" | "settle"; seq: number };

export class StubFacilitator implements FacilitatorClient {
  readonly calls: Call[] = [];
  rejectVerify = false;
  failSettle = false;
  lastSettleRequirements: PaymentRequirements | null = null;
  private seq = 0;

  private note(kind: Call["kind"]): void {
    this.calls.push({ kind, seq: this.seq++ });
  }

  async verify(paymentPayload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    this.note("verify");
    if (this.rejectVerify) {
      return { isValid: false, invalidReason: "stub_rejected", invalidMessage: "stub said no" };
    }
    return { isValid: true, payer: TEST_PAYER };
  }

  async settle(paymentPayload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.note("settle");
    this.lastSettleRequirements = requirements;
    if (this.failSettle) {
      return {
        success: false,
        errorReason: "stub_settle_failed",
        errorMessage: "stub refused to settle",
        transaction: "",
        network: requirements.network,
      };
    }
    return {
      success: true,
      transaction: "0xfeedface",
      network: requirements.network,
      payer: TEST_PAYER,
      amount: requirements.amount,
    };
  }

  /** The boot handshake reads this; without a matching kind the SDK refuses to price anything. */
  async getSupported(): Promise<SupportedResponse> {
    const kinds = [SETTLEMENT_CHAINS.mainnet, SETTLEMENT_CHAINS.testnet].map((chain) => ({
      x402Version: 2 as const,
      scheme: "exact" as const,
      network: chain.network,
    }));
    return { kinds, extensions: [], signers: {} };
  }

  settleCount(): number {
    return this.calls.filter((call) => call.kind === "settle").length;
  }

  verifyCameFirst(): boolean {
    const verify = this.calls.find((call) => call.kind === "verify");
    const settle = this.calls.find((call) => call.kind === "settle");
    return verify !== undefined && settle !== undefined && verify.seq < settle.seq;
  }

  reset(): void {
    this.calls.length = 0;
    this.seq = 0;
  }
}

export interface UpstreamCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export function stubUpstream() {
  const calls: UpstreamCall[] = [];
  const state = { status: 200, unreachable: false, body: null as string | null };

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    calls.push({ url, method: init?.method ?? "GET", headers });
    if (state.unreachable) throw new Error("ECONNRESET (simulated)");
    const payload = state.body ?? JSON.stringify({ upstream: "open-meteo", url });
    return new Response(payload, {
      status: state.status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }) as unknown as typeof fetch;

  return { calls, state, fetchImpl };
}

export function testEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): ServiceEnv {
  return loadEnv({ PAY_TO: TEST_PAY_TO, ...overrides }, priceDefaults());
}

export interface Harness {
  app: Hono;
  env: ServiceEnv;
  chain: SettlementChain;
  facilitator: StubFacilitator;
  upstream: ReturnType<typeof stubUpstream>;
  meter: UsageMeter;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  paid: (path: string, init?: RequestInit) => Promise<Response>;
}

export function harness(overrides: Partial<NodeJS.ProcessEnv> = {}): Harness {
  const facilitator = new StubFacilitator();
  const upstream = stubUpstream();
  const env = testEnv(overrides);
  const meter = new UsageMeter();
  const { app, cache } = buildApp({ env, facilitator, fetchImpl: upstream.fetchImpl, meter });
  cache.clear();

  const request = async (path: string, init?: RequestInit): Promise<Response> => app.request(path, init);

  const paid = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const challengeResponse = await request(path);
    if (challengeResponse.status !== 402) {
      throw new Error(`expected a 402 challenge for ${path}, got ${challengeResponse.status}`);
    }
    const { accepts } = decodeChallenge(challengeResponse);
    const requirement = accepts[0];
    if (!requirement) throw new Error("challenge has no accepts entry");
    const headers = new Headers(init.headers);
    headers.set("PAYMENT-SIGNATURE", fakePayment(requirement));
    return request(path, { ...init, headers });
  };

  return {
    app,
    env,
    chain: SETTLEMENT_CHAINS[env.networkKey],
    facilitator,
    upstream,
    meter,
    request,
    paid,
  };
}

export interface Challenge {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
}

export function decodeChallenge(response: Response): Challenge {
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) throw new Error("no PAYMENT-REQUIRED header on the response");
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Challenge;
}

/**
 * A structurally valid v2 payment payload. The stub facilitator does not
 * check signatures (a real one would recover the EIP-3009 signer), but the
 * payload still has to satisfy the SDK's shape validation, `accepted`
 * included — omit that field and every paid request comes back 402 again.
 */
export function fakePayment(requirement: PaymentRequirements): string {
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: requirement,
    payload: {
      authorization: {
        from: TEST_PAYER,
        to: requirement.payTo,
        value: requirement.amount,
        validAfter: "0",
        validBefore: "999999999999999999",
        nonce: `0x${"00".repeat(31)}01`,
      },
      signature: `0x${"ab".repeat(65)}`,
      authorizationType: "transferWithAuthorization",
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

export function route(id: string) {
  const found = DATA_ROUTES.find((entry) => entry.id === id);
  if (!found) throw new Error(`no such route: ${id}`);
  return found;
}
