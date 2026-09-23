/**
 * The paywall middleware.
 *
 * Same shape as the SDK's Express middleware, because HTTP has one way to do
 * this:
 *
 *   no PAYMENT-SIGNATURE        -> 402 + PAYMENT-REQUIRED (base64 challenge)
 *   signature that does not verify -> 402, reason in the body
 *   signature that verifies     -> run the handler, then settle
 *     handler said < 400        -> settle, attach the settlement receipt
 *     handler said >= 400       -> cancel; the caller is not charged
 *     handler threw             -> cancel; the caller is not charged
 *
 * One Hono-specific nicety: `await next()` returns with `c.res` already built,
 * so there is no need to monkey-patch `res.write`/`res.end` to buffer a
 * response the way the Express implementation does.
 */
import type { Context, MiddlewareHandler, Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  FacilitatorResponseError,
  SETTLEMENT_OVERRIDES_HEADER,
  attachBackgroundInitHandler,
  checkIfBazaarNeeded,
  getFacilitatorResponseError,
  withPrivateCacheControl,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import type {
  FacilitatorClient,
  HTTPRequestContext,
  HTTPResponseInstructions,
  PaywallConfig,
  PaywallProvider,
  RoutesConfig,
  x402HTTPResourceServer as HttpServer,
} from "@x402/core/server";
import { HonoHttpAdapter } from "./adapter.js";

/** Everything a settled call tells you. Handy for metering, audit logs, or an event stream. */
export interface SettlementEvent {
  /** Request path that was paid for. */
  readonly path: string;
  readonly payer?: string;
  /** Atomic units actually moved. */
  readonly amount?: string;
  readonly transaction?: string;
}

export interface PaywallOptions {
  /** Copy for the HTML paywall returned to browsers that send Accept: text/html. */
  paywallConfig?: PaywallConfig;
  /** Replace the built-in HTML entirely. */
  paywall?: PaywallProvider;
  /**
   * Talk to the facilitator at boot to learn which schemes it supports.
   * Turning this off lets the process start while the facilitator is down;
   * the first paid request pays the cost instead. Tests turn it off.
   */
  syncOnBoot?: boolean;
  /**
   * Fired after the facilitator confirms settlement, before the response is
   * handed back. Keeps this middleware storage-free: whatever wants to count,
   * log, or publish payments subscribes here.
   */
  onSettled?: (event: SettlementEvent) => void;
}

function respond(c: Context, instructions: HTTPResponseInstructions): Response {
  const status = instructions.status as ContentfulStatusCode;
  const response = instructions.isHtml
    ? c.body(typeof instructions.body === "string" ? instructions.body : String(instructions.body ?? ""), status)
    : c.json(instructions.body ?? {}, status);
  for (const [name, value] of Object.entries(instructions.headers)) {
    response.headers.set(name, String(value));
  }
  return response;
}

function safeDecode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Convenience wrapper: build the middleware straight from a route table. */
export function paywall(
  routes: RoutesConfig,
  server: x402ResourceServer,
  options: PaywallOptions = {},
): MiddlewareHandler {
  return paywallFrom(new x402HTTPResourceServer(server, routes), options);
}

/** For callers who already hold an x402HTTPResourceServer (e.g. to share it with other middleware). */
export function paywallFrom(httpServer: HttpServer, options: PaywallOptions = {}): MiddlewareHandler {
  const { paywallConfig, paywall: customPaywall, syncOnBoot = true, onSettled } = options;
  if (customPaywall) httpServer.registerPaywallProvider(customPaywall);

  let bootHandshake: Promise<void> | null = syncOnBoot ? httpServer.initialize() : null;
  attachBackgroundInitHandler(bootHandshake);
  let handshakeDone = false;

  // Optional extension, loaded only when a route actually declares it.
  let bazaarLoad: Promise<void> | null = null;
  if (checkIfBazaarNeeded(httpServer.routes)) {
    // The bazaar extension is loaded lazily because most routes don't use it.
    // The `@ts-expect-error` suppresses a missing-types complaint when the
    // optional package isn't installed in CI.
    bazaarLoad = (import(
      // @ts-expect-error optional peer dependency
      "@x402/extensions/bazaar"
    ) as Promise<{ validateBazaarRouteExtensions?: (routes: unknown) => Promise<void> }>)
      .then((mod) => mod.validateBazaarRouteExtensions?.(httpServer.routes) ?? Promise.resolve())
      .catch((error: unknown) => console.error("failed to load bazaar extension", error));
  }

  return async (c: Context, next: Next) => {
    const adapter = new HonoHttpAdapter(c);
    const path = adapter.getPath();
    const request: HTTPRequestContext = {
      adapter,
      path,
      decodedPath: safeDecode(path),
      method: adapter.getMethod(),
      // x-payment is the v1 header; keep reading it so older clients still work.
      paymentHeader: c.req.header("payment-signature") ?? c.req.header("x-payment"),
    };

    if (!httpServer.requiresPayment(request)) return next();

    if (syncOnBoot && !handshakeDone) {
      try {
        if (!bootHandshake) bootHandshake = httpServer.initialize();
        await bootHandshake;
        handshakeDone = true;
      } catch (error) {
        const facilitatorError = getFacilitatorResponseError(error);
        if (facilitatorError) {
          return respond(c, { status: 502, headers: {}, body: { error: facilitatorError.message } });
        }
        console.error(error);
        return respond(c, { status: 500, headers: {}, body: { error: "internal error" } });
      }
    }
    if (bazaarLoad) {
      await bazaarLoad;
      bazaarLoad = null;
    }

    let outcome;
    try {
      outcome = await httpServer.processHTTPRequest(request, paywallConfig);
    } catch (error) {
      if (error instanceof FacilitatorResponseError) {
        return respond(c, { status: 502, headers: {}, body: { error: error.message } });
      }
      console.error(error);
      return respond(c, { status: 500, headers: {}, body: { error: "internal error" } });
    }

    switch (outcome.type) {
      case "no-payment-required":
        return next();

      case "payment-error":
        return respond(c, outcome.response);

      case "payment-verified": {
        const {
          cancellationDispatcher,
          beforeHandlerSettlement,
          paymentPayload,
          paymentRequirements,
          declaredExtensions,
        } = outcome;

        try {
          await next();
        } catch (error) {
          const cancelled = await cancellationDispatcher.cancel({ reason: "handler_threw", error });
          const failureHeaders = httpServer.createFailurePathSettlementHeaders(
            cancelled,
            beforeHandlerSettlement,
            paymentPayload,
            c.res.headers.get("Cache-Control"),
          );
          const response = c.json({ error: "handler failed" }, 500);
          if (failureHeaders) {
            for (const [name, value] of Object.entries(failureHeaders)) {
              response.headers.set(name, String(value));
            }
          }
          c.res = response;
          console.error(error);
          return;
        }

        const handlerResponse = c.res;

        if (handlerResponse.status >= 400) {
          const cancelled = await cancellationDispatcher.cancel({
            reason: "handler_failed",
            responseStatus: handlerResponse.status,
          });
          const failureHeaders = httpServer.createFailurePathSettlementHeaders(
            cancelled,
            beforeHandlerSettlement,
            paymentPayload,
            handlerResponse.headers.get("Cache-Control"),
          );
          if (failureHeaders) {
            for (const [name, value] of Object.entries(failureHeaders)) {
              handlerResponse.headers.set(name, String(value));
            }
          }
          return;
        }

        const body = Buffer.from(await handlerResponse.arrayBuffer());
        const responseHeaders: Record<string, string> = {};
        handlerResponse.headers.forEach((value, name) => {
          responseHeaders[name] = value;
        });
        delete responseHeaders[SETTLEMENT_OVERRIDES_HEADER.toLowerCase()];

        let settlement;
        try {
          settlement = await httpServer.processSettlement(
            paymentPayload,
            paymentRequirements,
            declaredExtensions,
            { request, responseBody: body, responseHeaders },
            undefined,
            beforeHandlerSettlement,
          );
        } catch (error) {
          if (error instanceof FacilitatorResponseError) {
            return respond(c, { status: 502, headers: {}, body: { error: error.message } });
          }
          console.error(error);
          return respond(c, { status: 402, headers: {}, body: {} });
        }

        if (!settlement.success) {
          const failResponse = respond(c, settlement.response);
          c.res = failResponse;
          return;
        }

        onSettled?.({
          path: request.decodedPath ?? path,
          payer: (settlement as { payer?: string }).payer,
          amount: paymentRequirements.amount ?? "0",
          transaction: (settlement as { transaction?: string }).transaction,
        });

        const headers = new Headers(handlerResponse.headers);
        for (const [name, value] of Object.entries(settlement.headers)) {
          headers.set(name, String(value));
        }
        headers.set("Cache-Control", withPrivateCacheControl(headers.get("Cache-Control")));
        headers.delete(SETTLEMENT_OVERRIDES_HEADER);
        c.res = new Response(body, { status: handlerResponse.status, headers });
        return;
      }
    }
  };
}

/** Export for callers that want to build a resource server without importing the SDK directly. */
export { x402ResourceServer, x402HTTPResourceServer };
export type { FacilitatorClient, RoutesConfig };
