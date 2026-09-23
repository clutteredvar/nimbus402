/**
 * Process entry point.
 *
 *   node --env-file=.env src/server.ts     (or: npm start)
 *
 * No dotenv dependency: Node reads the file itself. `.env` is optional; every
 * variable has either a default or a fail-fast error in src/env.ts.
 */
import { serve } from "@hono/node-server";
import { buildApp } from "./app.js";
import { ConfigError, loadEnv } from "./env.js";
import { DATA_ROUTES } from "./routes/weather.js";
import { SETTLEMENT_CHAINS, formatPrice } from "./billing/chains.js";
import { log, setLogLevel, type LogLevel } from "./support/log.js";

const level = process.env.LOG_LEVEL as LogLevel | undefined;
if (level) setLogLevel(level);

let env;
try {
  env = loadEnv(process.env, Object.fromEntries(DATA_ROUTES.map((r) => [r.id, r.defaultPrice])));
} catch (error) {
  if (error instanceof ConfigError) {
    log.error("config_invalid", { detail: error.message });
    process.exit(1);
  }
  throw error;
}

const chain = SETTLEMENT_CHAINS[env.networkKey];
const { app } = buildApp({ env });

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  log.info("listening", {
    port: info.port,
    network: chain.network,
    asset: chain.stablecoin.symbol,
    payTo: env.payTo,
    cacheTtl: env.cacheTtlSeconds,
    menu: DATA_ROUTES.map((r) => `${r.path}=${formatPrice(chain, env.prices[r.id] ?? r.defaultPrice)}`).join(","),
  });
});

function shutdown(signal: string): void {
  log.info("shutdown", { signal });
  // In-flight settlements finish; new connections are refused.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
