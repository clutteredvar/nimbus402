/**
 * The billing lifecycle, end to end but with the chain stubbed out:
 * challenge shape, per-route pricing, verify -> upstream -> settle order,
 * and every path where the caller must NOT be charged.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CHAIN, TEST_PAYER, decodeChallenge, harness, route } from "./support/harness.js";

describe("the 402 challenge", () => {
  test("an unpaid call to a paid route is refused with a payment challenge", async () => {
    const h = harness();
    const response = await h.request("/v1/forecast?latitude=52.52&longitude=13.41");

    assert.equal(response.status, 402);
    const challenge = decodeChallenge(response);
    assert.equal(challenge.x402Version, 2);
    // URL must point at the route, query string and all — clients use this to
    // confirm the paywall really is for the call they're about to make.
    assert.ok(challenge.resource.url.includes("/v1/forecast"));
    assert.match(challenge.resource.url, /\/v1\/forecast(?:\?|$)/);
    assert.equal(challenge.resource.description, route("forecast").summary);
  });

  test("the challenge carries the Kite network, asset and EIP-712 domain", async () => {
    const h = harness();
    const challenge = decodeChallenge(await h.request("/v1/forecast?latitude=1&longitude=2"));
    const accepted = challenge.accepts[0];

    assert.ok(accepted, "challenge must contain an accepts entry");
    assert.equal(accepted.scheme, "exact");
    assert.equal(accepted.network, "eip155:2366");
    assert.equal(accepted.payTo, h.env.payTo);
    assert.equal(accepted.asset, CHAIN.stablecoin.address);
    assert.deepEqual(accepted.extra, { name: "Bridged USDC (Kite AI)", version: "2" });
  });

  test("each endpoint is priced separately", async () => {
    const h = harness();
    const cases: Array<[string, string]> = [
      ["/v1/forecast?latitude=1&longitude=2", "2000"], // 0.002 USDC.e
      ["/v1/air-quality?latitude=1&longitude=2", "1000"], // 0.001
      ["/v1/climate?latitude=1&longitude=2&start_date=2026-01-01&end_date=2026-01-02", "10000"], // 0.01
    ];

    for (const [path, expected] of cases) {
      const challenge = decodeChallenge(await h.request(path));
      assert.equal(challenge.accepts[0]?.amount, expected, `price mismatch for ${path}`);
    }
  });

  test("a deploy-time override changes what the challenge asks for", async () => {
    const h = harness({ PRICE_FORECAST: "0.0075" });
    const challenge = decodeChallenge(await h.request("/v1/forecast?latitude=1&longitude=2"));
    assert.equal(challenge.accepts[0]?.amount, "7500");
  });

  test("the free endpoints are never challenged", async () => {
    const h = harness();
    for (const path of ["/", "/catalog", "/healthz"]) {
      const response = await h.request(path);
      assert.equal(response.status, 200, `${path} should be free`);
      assert.equal(response.headers.get("PAYMENT-REQUIRED"), null);
    }
    assert.equal(h.facilitator.calls.length, 0, "no facilitator traffic for free endpoints");
  });
});

describe("a paid call", () => {
  test("settles only after the upstream answered, and returns the data", async () => {
    const h = harness();
    const response = await h.paid("/v1/forecast?latitude=52.52&longitude=13.41");

    assert.equal(response.status, 200);
    const payload = (await response.json()) as { upstream: string; url: string };
    assert.equal(payload.upstream, "open-meteo");
    assert.equal(payload.url, "https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41");
    assert.equal(response.headers.get("X-Nimbus-Route"), "forecast");
    assert.equal(response.headers.get("X-Nimbus-Cache"), "miss");
    assert.equal(response.headers.get("X-Nimbus-Upstream"), "api.open-meteo.com");

    assert.equal(h.facilitator.settleCount(), 1);
    assert.ok(h.facilitator.verifyCameFirst(), "verify must happen before settle");
  });

  test("the settlement is reported to the audit hook", async () => {
    const h = harness();
    await h.paid("/v1/climate?latitude=1&longitude=2&start_date=2026-01-01&end_date=2026-01-02");

    const usage = h.meter.snapshot();
    assert.equal(usage.totalSettled, 1);
    assert.equal(usage.uniquePayers, 1);
    assert.equal(usage.routes.climate?.settled, 1);
    assert.equal(usage.routes.climate?.collected, "10000");
    assert.equal(h.facilitator.lastSettleRequirements?.amount, "10000");
  });

  test("a signature the facilitator rejects costs nothing and yields no data", async () => {
    const h = harness();
    h.facilitator.rejectVerify = true;

    const response = await h.paid("/v1/forecast?latitude=1&longitude=2");
    assert.notEqual(response.status, 200);
    assert.equal(h.facilitator.settleCount(), 0);
    assert.equal(h.upstream.calls.length, 0, "the upstream is never called for a rejected payment");
    assert.equal(h.meter.snapshot().totalSettled, 0);
  });

  test("a failed settlement yields no data", async () => {
    const h = harness();
    h.facilitator.failSettle = true;

    const response = await h.paid("/v1/forecast?latitude=1&longitude=2");
    assert.notEqual(response.status, 200);
    assert.equal(h.meter.snapshot().totalSettled, 0);
  });

  test("the payer is recorded for repeat customers without storing addresses twice", async () => {
    const h = harness();
    await h.paid("/v1/forecast?latitude=1&longitude=2");
    await h.paid("/v1/forecast?latitude=3&longitude=4");

    const usage = h.meter.snapshot();
    assert.equal(usage.totalSettled, 2);
    assert.equal(usage.uniquePayers, 1);
    assert.equal(h.facilitator.settleCount(), 2);
  });
});

describe("a request the caller should not pay for", () => {
  test("missing required parameters: 400, no settlement, no upstream call", async () => {
    const h = harness();
    const response = await h.paid("/v1/climate?latitude=1&longitude=2");

    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string; message: string; required: string[] } };
    assert.equal(body.error.code, "missing_params");
    assert.match(body.error.message, /start_date, end_date/);
    assert.deepEqual(body.error.required, route("climate").requiredParams);

    assert.equal(h.facilitator.settleCount(), 0);
    assert.equal(h.upstream.calls.length, 0);
    assert.equal(h.meter.snapshot().totalSettled, 0);
  });

  test("an upstream 5xx is passed on as 502 with no settlement", async () => {
    const h = harness();
    h.upstream.state.status = 503;

    const response = await h.paid("/v1/forecast?latitude=1&longitude=2");
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { code: string; upstreamStatus: number } };
    assert.equal(body.error.code, "upstream_error");
    assert.equal(body.error.upstreamStatus, 503);
    assert.equal(h.facilitator.settleCount(), 0);
  });

  test("an unreachable upstream is a 502 with no settlement", async () => {
    const h = harness();
    h.upstream.state.unreachable = true;

    const response = await h.paid("/v1/forecast?latitude=1&longitude=2");
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "upstream_unreachable");
    assert.equal(h.facilitator.settleCount(), 0);
  });
});

describe("caching", () => {
  test("a repeated query is served from cache, and both calls still settle", async () => {
    const h = harness();
    const first = await h.paid("/v1/forecast?latitude=52.52&longitude=13.41");
    const second = await h.paid("/v1/forecast?latitude=52.52&longitude=13.41");

    assert.equal(first.headers.get("X-Nimbus-Cache"), "miss");
    assert.equal(second.headers.get("X-Nimbus-Cache"), "hit");
    assert.equal(h.upstream.calls.length, 1);
    assert.equal(h.facilitator.settleCount(), 2, "the cache protects the upstream, not the payer");

    const usage = h.meter.snapshot();
    assert.equal(usage.routes.forecast?.fetched, 1);
    assert.equal(usage.routes.forecast?.cached, 1);
  });

  test("parameter order does not defeat the cache", async () => {
    const h = harness();
    await h.paid("/v1/forecast?latitude=1&longitude=2");
    const reordered = await h.paid("/v1/forecast?longitude=2&latitude=1");
    assert.equal(reordered.headers.get("X-Nimbus-Cache"), "hit");
    assert.equal(h.upstream.calls.length, 1);
  });
});

describe("query parameter handling", () => {
  test("only allow-listed parameters reach the upstream", async () => {
    const h = harness();
    const response = await h.paid(
      "/v1/forecast?latitude=1&longitude=2&hourly=temperature_2m&apikey=steal-me&evil=1",
    );

    assert.equal(response.status, 200);
    const sent = h.upstream.calls[0]?.url ?? "";
    assert.match(sent, /hourly=temperature_2m/);
    assert.doesNotMatch(sent, /apikey/);
    assert.doesNotMatch(sent, /evil/);
  });

  test("repeated parameters are forwarded, not squashed", async () => {
    const h = harness();
    await h.paid("/v1/forecast?latitude=1&longitude=2&hourly=temperature_2m&hourly=wind_speed_10m");
    const sent = new URL(h.upstream.calls[0]?.url ?? "");
    assert.deepEqual(sent.searchParams.getAll("hourly"), ["temperature_2m", "wind_speed_10m"]);
  });

  test("the upstream request is identifiable and asks for JSON", async () => {
    const h = harness();
    await h.paid("/v1/forecast?latitude=1&longitude=2");
    const call = h.upstream.calls[0];
    assert.equal(call?.method, "GET");
    assert.match(call?.headers.accept ?? "", /application\/json/);
    assert.match(call?.headers["user-agent"] ?? "", /nimbus402/);
  });

  test("the payment credential is never forwarded to the data provider", async () => {
    const h = harness();
    await h.paid("/v1/forecast?latitude=1&longitude=2");

    const forwarded = h.upstream.calls[0]?.headers ?? {};
    assert.equal(forwarded["payment-signature"], undefined);
    assert.equal(forwarded["x-payment"], undefined);
    assert.equal(forwarded.authorization, undefined);
  });
});

describe("the meter", () => {
  test("reports payer count without leaking addresses into the payload", async () => {
    const h = harness();
    await h.paid("/v1/forecast?latitude=1&longitude=2");
    const payload = JSON.stringify(h.meter.snapshot());
    assert.doesNotMatch(payload, new RegExp(TEST_PAYER.toLowerCase()));
    assert.doesNotMatch(payload, /0xabcdef/);
  });
});
