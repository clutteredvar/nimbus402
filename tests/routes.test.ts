/**
 * The product surface: what the service advertises about itself and what it
 * does with the traffic it receives.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { harness, route } from "./support/harness.js";

describe("GET /", () => {
  test("describes the service, its chain, and its menu", async () => {
    const h = harness();
    const response = await h.request("/");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);

    const body = (await response.json()) as {
      service: string;
      chain: { network: string; asset: string };
      payTo: string;
      endpoints: Array<{ path: string; price: string }>;
      protocol: string;
    };

    assert.equal(body.service, "nimbus402");
    assert.equal(body.chain.network, "eip155:2366");
    assert.equal(body.chain.asset, "USDC.e");
    assert.equal(body.payTo, h.env.payTo);
    assert.equal(body.endpoints.length, 5);
    assert.deepEqual(
      body.endpoints.map((endpoint) => endpoint.path),
      ["/v1/forecast", "/v1/air-quality", "/v1/climate", "/v1/marine", "/v1/geocode"],
    );
    assert.equal(body.endpoints[0]?.price, "0.002 USDC.e");
    assert.match(body.protocol, /x402/);
  });
});

describe("GET /catalog", () => {
  test("is a machine-readable price list, including the settlement token", async () => {
    const h = harness({ PRICE_AIR_QUALITY: "0.0009" });
    const body = (await (await h.request("/catalog")).json()) as {
      generatedAt: string;
      chain: string;
      asset: { address: string; symbol: string; decimals: number; domain: { name: string; version: string } };
      routes: Array<{ id: string; path: string; price: string; required: string[]; allowed: string[]; cachedForSeconds: number }>;
    };

    assert.equal(body.chain, "eip155:2366");
    assert.equal(body.asset.symbol, "USDC.e");
    assert.equal(body.asset.decimals, 6);
    assert.deepEqual(body.asset.domain, { name: "Bridged USDC (Kite AI)", version: "2" });
    assert.ok(!Number.isNaN(Date.parse(body.generatedAt)));

    const air = body.routes.find((entry) => entry.id === "air-quality");
    assert.equal(air?.price, "0.0009");
    assert.deepEqual(air?.required, ["latitude", "longitude"]);
    assert.ok(air?.allowed.includes("hourly"));
    assert.equal(air?.cachedForSeconds, 45);

    const climate = body.routes.find((entry) => entry.id === "climate");
    assert.deepEqual(climate?.required, route("climate").requiredParams);
  });
});

describe("GET /healthz", () => {
  test("is free, greppable, and reports usage per route", async () => {
    const h = harness();
    const empty = (await (await h.request("/healthz")).json()) as {
      ok: boolean;
      network: string;
      uptimeSeconds: number;
      totalSettled: number;
    };
    assert.equal(empty.ok, true);
    assert.equal(empty.network, "eip155:2366");
    assert.equal(empty.totalSettled, 0);
    assert.ok(empty.uptimeSeconds >= 0);

    await h.paid("/v1/forecast?latitude=1&longitude=2");
    await h.paid("/v1/climate?latitude=1&longitude=2&start_date=2026-01-01&end_date=2026-01-02");

    const after = (await (await h.request("/healthz")).json()) as {
      totalSettled: number;
      uniquePayers: number;
      routes: Record<string, { fetched: number; settled: number; collected: string }>;
    };
    assert.equal(after.totalSettled, 2);
    assert.equal(after.uniquePayers, 1);
    assert.equal(after.routes.forecast?.collected, "2000");
    assert.equal(after.routes.climate?.collected, "10000");
  });
});

describe("cache configuration", () => {
  test("CACHE_TTL_SECONDS=0 turns caching off entirely", async () => {
    const h = harness({ CACHE_TTL_SECONDS: "0" });
    await h.paid("/v1/forecast?latitude=1&longitude=2");
    const second = await h.paid("/v1/forecast?latitude=1&longitude=2");

    assert.equal(second.headers.get("X-Nimbus-Cache"), "miss");
    assert.equal(h.upstream.calls.length, 2);
  });
});

describe("route table", () => {
  test("every paid route has a unique path, price, and upstream host", async () => {
    const h = harness();
    const body = (await (await h.request("/catalog")).json()) as {
      routes: Array<{ id: string; path: string; price: string }>;
    };
    const paths = body.routes.map((entry) => entry.path);
    const ids = body.routes.map((entry) => entry.id);
    assert.equal(new Set(paths).size, paths.length, "duplicate route path");
    assert.equal(new Set(ids).size, ids.length, "duplicate route id");
    for (const entry of body.routes) {
      assert.match(entry.path, /^\/v1\//);
      assert.ok(Number(entry.price) > 0, `${entry.id} has no positive price`);
    }
  });

  test("the climate route is priced above a forecast, as its upstream cost dictates", async () => {
    const h = harness();
    const body = (await (await h.request("/catalog")).json()) as {
      routes: Array<{ id: string; price: string }>;
    };
    const forecast = Number(body.routes.find((entry) => entry.id === "forecast")?.price);
    const climate = Number(body.routes.find((entry) => entry.id === "climate")?.price);
    assert.ok(climate > forecast, "archive queries cost more upstream than a forecast");
  });
});

describe("the marine route", () => {
  test("is paid, forwarded to the marine host, and priced like a forecast", async () => {
    const h = harness();
    const response = await h.paid("/v1/marine?latitude=54.09&longitude=13.38&hourly=wave_height");

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Nimbus-Route"), "marine");
    assert.equal(response.headers.get("X-Nimbus-Upstream"), "marine-api.open-meteo.com");
    assert.equal(h.upstream.calls.length, 1);
    assert.match(h.upstream.calls[0]?.url ?? "", /marine-api\.open-meteo\.com\/v1\/marine/);
    assert.match(h.upstream.calls[0]?.url ?? "", /hourly=wave_height/);
    assert.equal(h.facilitator.lastSettleRequirements?.amount, "2000", "0.002 USDC.e");
  });

  test("rejects a missing coordinate before billing", async () => {
    const h = harness();
    const response = await h.paid("/v1/marine?hourly=wave_height");
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "missing_params");
  });
});

describe("the geocode route", () => {
  test("turns a place name into coordinates, priced at the floor", async () => {
    const h = harness();
    const response = await h.paid("/v1/geocode?name=Berlin&count=1");

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Nimbus-Upstream"), "geocoding-api.open-meteo.com");
    assert.match(h.upstream.calls[0]?.url ?? "", /\/v1\/search\?/);
    assert.match(h.upstream.calls[0]?.url ?? "", /name=Berlin/);
    // 0.0005 USDC.e in atomic units.
    assert.equal(h.facilitator.lastSettleRequirements?.amount, "500");
  });

  test("a call without a name is rejected before billing", async () => {
    const h = harness();
    const response = await h.paid("/v1/geocode?count=1");
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "missing_params");
    assert.match(body.error.message, /name/);
  });
});

describe("conditional requests", () => {
  test("every 200 carries an ETag that is stable across identical calls", async () => {
    const h = harness();
    const first = await h.paid("/v1/forecast?latitude=52.52&longitude=13.41");
    const etag = first.headers.get("ETag");
    assert.ok(etag, "a data response must carry an ETag");

    const second = await h.paid("/v1/forecast?latitude=52.52&longitude=13.41");
    assert.equal(second.headers.get("ETag"), etag);
  });

  test("If-None-Match on a cached answer yields a 304 with no body", async () => {
    const h = harness();
    const first = await h.paid("/v1/forecast?latitude=52.52&longitude=13.41");
    const etag = first.headers.get("ETag");
    assert.ok(etag);

    const revalidation = await h.paid("/v1/forecast?latitude=52.52&longitude=13.41", {
      headers: { "If-None-Match": etag ?? "" },
    });

    assert.equal(revalidation.status, 304);
    assert.equal(revalidation.headers.get("ETag"), etag);
    assert.equal(revalidation.headers.get("X-Nimbus-Cache"), "hit");
    assert.equal(await revalidation.text(), "", "a 304 carries no body");
    // The revalidation still settled: the price is per request, not per byte.
    assert.equal(h.facilitator.settleCount(), 2);
  });

  test("a stale If-None-Match gets the full body back", async () => {
    const h = harness();
    await h.paid("/v1/forecast?latitude=52.52&longitude=13.41");
    const stale = await h.paid("/v1/forecast?latitude=52.52&longitude=13.41", {
      headers: { "If-None-Match": '"00000000000000000000000000000000"' },
    });
    assert.equal(stale.status, 200);
    assert.ok((await stale.text()).length > 0);
  });

  test("If-None-Match: * matches anything we could return", async () => {
    const h = harness();
    await h.paid("/v1/air-quality?latitude=48.85&longitude=2.35");
    const anyTag = await h.paid("/v1/air-quality?latitude=48.85&longitude=2.35", {
      headers: { "If-None-Match": "*" },
    });
    assert.equal(anyTag.status, 304);
  });
});
