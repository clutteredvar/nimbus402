# nimbus402

A small, honest weather API that bills you per call. Wraps the
[open-meteo](https://open-meteo.com) public service behind an x402 paywall
so each request settles a few cents of USDC.e on Kite AI before the data
goes anywhere.

Built to scratch two itches at once:

1. **A worked example of a real x402 service**, not a wrapper. The official
   `gokite-ai/kite-x402-services` repo ships templates that *proxy* an
   upstream API; this one is the upstream. If you want to see what a paid
   endpoint looks like from the inside (route table, price per endpoint,
   settle-on-success, no double-charges), open `src/routes/weather.ts` and
   `src/billing/paywall.ts`.
2. **A reasonable service skeleton** you can copy. Routes are typed, the
   cache is small but real, every paid call goes through `verify →
   upstream → settle`, and `/healthz` exposes the meter so you can tell
   from the outside whether the thing is alive and getting used.

## Layout

```
src/
  env.ts                 # env parsing + defaults
  server.ts              # HTTP entry point (port, boot handshake)
  app.ts                 # Hono app + paywall + routes
  billing/
    chains.ts            # Kite mainnet/testnet constants, EIP-712 domain
    paywall.ts           # the 402 → verify → settle pipeline
    adapter.ts           # Hono → SDK HTTPRequestContext adapter
  routes/
    weather.ts           # /v1/forecast, /v1/air-quality, /v1/climate
  support/
    cache.ts             # TTL cache for upstream responses
    meter.ts             # in-process usage counters
    log.ts               # structured one-line logs
tests/                   # node:test, no third-party runner
scripts/smoke.sh         # boot + 402 probe, plain bash
```

## Run it

```bash
npm install
cp .env.example .env       # then edit PAY_TO
npm start                  # listens on :8787 by default
```

A working paid request then looks like:

```
curl http://localhost:8787/v1/forecast?latitude=52.52&longitude=13.41
→ 402, PAYMENT-REQUIRED header carrying the base64 challenge

# client signs a payment payload, retries with PAYMENT-SIGNATURE
curl -H "PAYMENT-SIGNATURE: <base64-v2-payload>" \
     http://localhost:8787/v1/forecast?latitude=52.52&longitude=13.41
→ 200, weather JSON
```

`/healthz` is always free and reports usage; `/` and `/catalog` are
free advertising for the route table. Everything under `/v1/*` is paid.

## Configuration

See `.env.example` for the full set. The interesting ones:

- `PAY_TO` — your settlement address. Must be set; the service refuses to
  start without it.
- `KITE_NETWORK` — `mainnet` (USDC.e, 6 decimals) or `testnet` (pieUSD,
  18 decimals).
- `CACHE_TTL_SECONDS` — how long an identical upstream response is reused,
  so a burst of requests for the same city doesn't hammer the free
  upstream quota.

## Pricing

One price per route, in USD, converted to atomic units of the settlement
asset at request time. Defaults are overridable per route (`PRICE_<ID>`).
The spread reflects what each endpoint actually costs the upstream to
serve.

| Route              | Default | Why that number                                   |
| ------------------ | ------- | ------------------------------------------------- |
| `/v1/air-quality`  | $0.001  | one CAMS grid cell, single pollutant set          |
| `/v1/forecast`     | $0.002  | one point, hourly, up to a week                   |
| `/v1/climate`      | $0.010  | reanalysis archive — the expensive one (~5 GB of source data) |

The challenge always carries the price as raw atomic units in the
`amount` field; the table above is the humanised display.

## How billing actually works

The middleware in `src/billing/paywall.ts` is the whole billing logic. It
mirrors the SDK's reference Express adapter, with one Hono-specific
simplification: `await next()` already gives you the finalised response
in `c.res`, so there's no need to monkey-patch `res.write` to buffer the
body. The pipeline:

```
no PAYMENT-SIGNATURE        → 402 + PAYMENT-REQUIRED challenge
signature does not verify   → 402, reason in the body
signature verifies          → run the route handler
  handler returned < 400    → settle on chain, attach the receipt
  handler returned >= 400   → cancel; the caller is not charged
  handler threw             → cancel; the caller is not charged
settlement fails            → 402 with PAYMENT-RESPONSE; caller not charged
```

Two details worth noticing, because they're where over-charging usually
creeps in:

- A missing required query parameter is a **400 from the handler**, which
  lands in the ">= 400 → cancel" branch. A caller who mistypes their
  latitude pays nothing.
- The upstream is wrapped in a timeout and failures are normalised to
  **502**, again below the payer. A flaky provider doesn't become a
  revenue source.

The meter at `/healthz` counts `fetched`, `cached`, `settled`, and total
`collected` atomic units, broken out per route.

## Tests

`node --test` is enough — no third-party runner. The test harness
(`tests/support/harness.ts`) provides a stub facilitator that records the
verify/settle call order, which is how "verify happens before settle" and
"nothing settles when the upstream fails" are asserted, rather than by
inspecting a real chain.

```
npm test          # 48 tests
npm run check     # tsc --noEmit
```

`scripts/smoke.sh` is the other half: it boots the real server and checks
that an unpaid call comes back 402 with a well-formed challenge. Plain
bash + curl, so it drops into whatever pipeline you already have rather
than assuming one.

```
npm run smoke
```

## License

MIT.
