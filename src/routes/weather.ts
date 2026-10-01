/**
 * The product: five weather endpoints, each with its own price.
 *
 * This is not a transparent proxy. Each route pins one upstream host and one
 * upstream path, forwards only an allow-listed set of query parameters, and
 * normalises failures into a single error envelope — so a caller never sees
 * "whatever open-meteo felt like returning", and an unknown query parameter
 * cannot be used to probe the upstream for free.
 */
import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { TtlCache } from "../support/cache.js";
import { log } from "../support/log.js";
import type { UsageMeter } from "../support/meter.js";

export interface DataRoute {
  /** Short id. Also the env suffix for the price override: PRICE_<ID>. */
  readonly id: string;
  /** Public path of this endpoint. */
  readonly path: string;
  readonly summary: string;
  readonly upstreamBase: string;
  readonly upstreamPath: string;
  /** Price in USD, overridable at deploy time. */
  readonly defaultPrice: string;
  /** Query parameters forwarded upstream. Everything else is dropped. */
  readonly allowedParams: readonly string[];
  /** Query parameters that must be present, or the call is rejected before billing. */
  readonly requiredParams: readonly string[];
  readonly example: string;
}

export const DATA_ROUTES: readonly DataRoute[] = [
  {
    id: "forecast",
    path: "/v1/forecast",
    summary: "Hourly and daily forecast for a coordinate",
    upstreamBase: "https://api.open-meteo.com",
    upstreamPath: "/v1/forecast",
    defaultPrice: "0.002",
    allowedParams: [
      "latitude",
      "longitude",
      "hourly",
      "daily",
      "current",
      "timezone",
      "forecast_days",
      "past_days",
      "temperature_unit",
      "wind_speed_unit",
    ],
    requiredParams: ["latitude", "longitude"],
    example: "/v1/forecast?latitude=52.52&longitude=13.41&hourly=temperature_2m",
  },
  {
    id: "air-quality",
    path: "/v1/air-quality",
    summary: "PM2.5 / PM10 / pollen and the rest of the CAMS fields",
    upstreamBase: "https://air-quality-api.open-meteo.com",
    upstreamPath: "/v1/air-quality",
    defaultPrice: "0.001",
    allowedParams: ["latitude", "longitude", "hourly", "current", "timezone", "forecast_days", "domains"],
    requiredParams: ["latitude", "longitude"],
    example: "/v1/air-quality?latitude=48.85&longitude=2.35&hourly=pm2_5",
  },
  {
    id: "climate",
    path: "/v1/climate",
    summary: "Reanalysis archive for a date range (the expensive one: ~5GB of source data)",
    upstreamBase: "https://archive-api.open-meteo.com",
    upstreamPath: "/v1/archive",
    defaultPrice: "0.01",
    allowedParams: [
      "latitude",
      "longitude",
      "start_date",
      "end_date",
      "daily",
      "hourly",
      "timezone",
      "temperature_unit",
    ],
    requiredParams: ["latitude", "longitude", "start_date", "end_date"],
    example: "/v1/climate?latitude=40.71&longitude=-74.01&start_date=2026-01-01&end_date=2026-01-07&daily=temperature_2m_max",
  },
  {
    id: "marine",
    path: "/v1/marine",
    summary: "Wave height, swell, and sea surface conditions for a coordinate",
    upstreamBase: "https://marine-api.open-meteo.com",
    upstreamPath: "/v1/marine",
    defaultPrice: "0.002",
    allowedParams: [
      "latitude",
      "longitude",
      "current",
      "hourly",
      "daily",
      "timezone",
      "forecast_days",
      "past_days",
      "cell_selection",
    ],
    requiredParams: ["latitude", "longitude"],
    example: "/v1/marine?latitude=54.09&longitude=13.38&hourly=wave_height",
  },
  {
    id: "geocode",
    path: "/v1/geocode",
    summary: "City or place name to coordinates — the lookup most weather calls need first",
    upstreamBase: "https://geocoding-api.open-meteo.com",
    upstreamPath: "/v1/search",
    defaultPrice: "0.0005",
    allowedParams: ["name", "count", "language", "format"],
    requiredParams: ["name"],
    example: "/v1/geocode?name=Berlin&count=1",
  },
];

/** Route id -> default price, for the env loader. */
export function priceDefaults(): Record<string, string> {
  return Object.fromEntries(DATA_ROUTES.map((route) => [route.id, route.defaultPrice]));
}

export function routeById(id: string): DataRoute | undefined {
  return DATA_ROUTES.find((route) => route.id === id);
}

/** Route id for a public path, e.g. "/v1/forecast" -> "forecast". */
export function routeIdForPath(path: string): string | undefined {
  return DATA_ROUTES.find((route) => route.path === path)?.id;
}

export function errorEnvelope(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message, ...extra } };
}

export interface DataHandlerDeps {
  readonly cache: TtlCache;
  readonly meter: UsageMeter;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  /** Injectable for tests: defaults to AbortSignal.timeout. */
  readonly timeoutSignal?: (ms: number) => AbortSignal;
}

/** Build the request handler for one route. */
export function createDataHandler(route: DataRoute, deps: DataHandlerDeps) {
  const timeout = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));

  return async (c: Context): Promise<Response> => {
    const incoming = new URL(c.req.url);
    const upstream = new URL(route.upstreamPath, route.upstreamBase);
    const forwarded: string[] = [];

    for (const name of route.allowedParams) {
      for (const value of incoming.searchParams.getAll(name)) {
        upstream.searchParams.append(name, value);
        forwarded.push(name);
      }
    }

    const missing = route.requiredParams.filter((name) => !upstream.searchParams.has(name));
    if (missing.length > 0) {
      // 4xx means the caller is not charged: the paywall cancels settlement
      // on any handler status >= 400.
      return c.json(
        errorEnvelope("missing_params", `${route.id} requires ${missing.join(", ")}`, {
          required: route.requiredParams,
        }),
        400,
      );
    }

    // Cache key: the upstream URL, so two spellings of the same query hit one entry.
    upstream.searchParams.sort();
    const cacheKey = upstream.toString();

    const hit = deps.cache.get(cacheKey);
    if (hit) {
      deps.meter.recordCacheHit(route.id);
      log.debug("cache_hit", { route: route.id, age: hit.ageSeconds });
      const etag = etagOf(hit.body);
      // Conditional request: the caller already has these bytes. A 304 is
      // still a settled call — the price is per request, not per byte — but
      // the body doesn't cross the wire again. Polling agents love this.
      if (requestMatches(c.req.header("If-None-Match"), etag)) {
        return new Response(null, {
          status: 304,
          headers: responseHeaders(route, { cached: true, age: hit.ageSeconds, etag }),
        });
      }
      return new Response(hit.body, {
        status: 200,
        headers: responseHeaders(route, { cached: true, age: hit.ageSeconds, contentType: hit.contentType, etag }),
      });
    }

    let upstreamResponse: Response;
    try {
      upstreamResponse = await deps.fetchImpl(upstream, {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": "nimbus402/0.2 (+weather)" },
        redirect: "manual",
        signal: timeout(deps.timeoutMs),
      });
    } catch (error) {
      // 502 >= 400, so the caller pays nothing for an upstream that is down.
      log.warn("upstream_unreachable", { route: route.id, detail: String(error) });
      return c.json(errorEnvelope("upstream_unreachable", "the data provider did not answer in time"), 502);
    }

    const body = await upstreamResponse.text();

    if (!upstreamResponse.ok) {
      log.warn("upstream_error", { route: route.id, status: upstreamResponse.status });
      return c.json(
        errorEnvelope("upstream_error", `data provider returned ${upstreamResponse.status}`, {
          upstreamStatus: upstreamResponse.status,
        }),
        502,
      );
    }

    deps.meter.recordFetch(route.id);
    const contentType = upstreamResponse.headers.get("Content-Type") ?? "application/json";
    deps.cache.put(cacheKey, body, contentType);
    log.debug("upstream_fetch", { route: route.id, params: forwarded.length });

    return new Response(body, {
      status: 200,
      headers: responseHeaders(route, { cached: false, contentType, etag: etagOf(body) }),
    });
  };
}

/** Strong ETag: the first half of the body's sha256. Same bytes, same tag. */
function etagOf(body: string): string {
  return `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
}

/** RFC 9110 If-None-Match comparison, simplified to what we actually emit. */
function requestMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === etag || candidate === "*");
}

function responseHeaders(
  route: DataRoute,
  options: { cached: boolean; contentType?: string; age?: number; etag: string },
): Record<string, string> {
  const headers: Record<string, string> = {
    ETag: options.etag,
    "X-Nimbus-Route": route.id,
    "X-Nimbus-Cache": options.cached ? "hit" : "miss",
    "X-Nimbus-Upstream": new URL(route.upstreamBase).host,
  };
  if (options.contentType) headers["Content-Type"] = options.contentType;
  if (options.age !== undefined) headers["X-Nimbus-Age"] = String(options.age);
  return headers;
}
