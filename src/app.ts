/**
 * Application assembly.
 *
 * Three things happen here and nothing else: the free endpoints, the paywall
 * mounted over the paid paths, and the routes behind it. Everything is
 * injectable (facilitator, fetch, meter, cache) so tests can run the whole
 * 402 -> verify -> upstream -> settle path without a network or a chain.
 */
import { Hono } from "hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { FacilitatorClient, RoutesConfig } from "@x402/core/server";
import { x402ResourceServer } from "@x402/core/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { SETTLEMENT_CHAINS, formatPrice, kiteMoneyParser, type SettlementChain } from "./billing/chains.js";
import { paywall } from "./billing/paywall.js";
import { DATA_ROUTES, createDataHandler, priceDefaults, routeIdForPath, type FetchOutcome } from "./routes/weather.js";
import { TtlCache } from "./support/cache.js";
import { log } from "./support/log.js";
import { UsageMeter } from "./support/meter.js";
import { SingleFlight } from "./support/singleflight.js";
import type { ServiceEnv } from "./env.js";

export interface AppDeps {
  readonly env: ServiceEnv;
  readonly facilitator?: FacilitatorClient;
  readonly fetchImpl?: typeof fetch;
  readonly meter?: UsageMeter;
  readonly cache?: TtlCache;
  /** Skip the boot handshake with the facilitator (tests, offline dev). */
  readonly syncOnBoot?: boolean;
}

export interface BuiltApp {
  readonly app: Hono;
  readonly meter: UsageMeter;
  readonly cache: TtlCache;
}

/**
 * Route table handed to the payment server: one entry per paid path, each
 * with its own price. Concrete paths rather than a wildcard, because a
 * wildcard forces one price for the whole service — and the archive endpoint
 * genuinely costs more to serve than a two-day forecast.
 */
export function paidRoutes(env: ServiceEnv, chain: SettlementChain): RoutesConfig {
  const routes: RoutesConfig = {};
  for (const route of DATA_ROUTES) {
    routes[route.path] = {
      accepts: {
        scheme: "exact",
        price: env.prices[route.id] ?? route.defaultPrice,
        network: chain.network,
        payTo: env.payTo,
        maxTimeoutSeconds: 60,
      },
      description: route.summary,
      mimeType: "application/json",
    };
  }
  return routes;
}

export function buildApp(deps: AppDeps): BuiltApp {
  const { env } = deps;
  const chain = SETTLEMENT_CHAINS[env.networkKey];
  const meter = deps.meter ?? new UsageMeter();
  const cache = deps.cache ?? new TtlCache(env.cacheTtlSeconds, 500, env.cacheStaleSeconds);
  const flights = new SingleFlight<FetchOutcome>();
  const facilitator = deps.facilitator ?? new HTTPFacilitatorClient({ url: env.facilitatorUrl });
  const fetchImpl = deps.fetchImpl ?? fetch;

  const server = new x402ResourceServer(facilitator).register(
    chain.network,
    new ExactEvmScheme().registerMoneyParser(kiteMoneyParser(chain)),
  );

  const app = new Hono();

  // ---- free endpoints -----------------------------------------------------

  app.get("/", (c) =>
    c.json({
      service: "nimbus402",
      tagline: "Weather, billed by the call.",
      chain: { network: chain.network, name: chain.displayName, asset: chain.stablecoin.symbol },
      payTo: env.payTo,
      endpoints: DATA_ROUTES.map((route) => ({
        path: route.path,
        summary: route.summary,
        price: formatPrice(chain, env.prices[route.id] ?? route.defaultPrice),
        example: route.example,
      })),
      catalog: "/catalog",
      health: "/healthz",
      protocol: "x402 v2 — unpaid requests receive a 402 with a PAYMENT-REQUIRED challenge",
    }),
  );

  app.get("/catalog", (c) =>
    c.json({
      generatedAt: new Date().toISOString(),
      chain: chain.network,
      asset: {
        address: chain.stablecoin.address,
        symbol: chain.stablecoin.symbol,
        decimals: chain.stablecoin.decimals,
        domain: { name: chain.stablecoin.domainName, version: chain.stablecoin.domainVersion },
      },
      routes: DATA_ROUTES.map((route) => ({
        id: route.id,
        path: route.path,
        price: env.prices[route.id] ?? route.defaultPrice,
        required: route.requiredParams,
        allowed: route.allowedParams,
        cachedForSeconds: env.cacheTtlSeconds,
        staleForSeconds: env.cacheStaleSeconds,
      })),
    }),
  );

  app.get("/healthz", (c) => c.json({ ok: true, network: chain.network, ...meter.snapshot() }));

  // ---- paid endpoints -----------------------------------------------------

  app.use(
    paywall(paidRoutes(env, chain), server, {
      syncOnBoot: deps.syncOnBoot ?? true,
      // Audit hook: one line per settled call, which is the whole billing
      // trail for a service with no database.
      onSettled: ({ path, payer, amount, transaction }) => {
        meter.recordSettlement(routeIdForPath(path) ?? path, payer, amount);
        log.info("payment_settled", { route: routeIdForPath(path) ?? path, payer, amount, tx: transaction });
      },
    }),
  );

  for (const route of DATA_ROUTES) {
    app.get(
      route.path,
      createDataHandler(route, { cache, meter, fetchImpl, flights, timeoutMs: env.upstreamTimeoutMs }),
    );
  }

  return { app, meter, cache };
}

export { priceDefaults };
