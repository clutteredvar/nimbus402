/**
 * Bridges a Hono request context onto the x402 SDK's HTTPAdapter contract.
 *
 * The SDK's orchestration layer never touches a framework object directly —
 * it goes through these nine methods, which is why "add x402 to framework X"
 * is a bounded amount of work rather than a rewrite. The official packages
 * cover Express and Go/Gin; Hono needs this file and nothing else.
 */
import type { Context } from "hono";
import type { HTTPAdapter } from "@x402/core/server";

export class HonoHttpAdapter implements HTTPAdapter {
  constructor(private readonly context: Context) {}

  getMethod(): string {
    return this.context.req.method;
  }

  getPath(): string {
    return this.context.req.path;
  }

  getUrl(): string {
    return this.context.req.url;
  }

  getHeader(name: string): string | undefined {
    const value = this.context.req.header(name);
    // Hono normalises a missing header to "", but the SDK distinguishes
    // "absent" from "present and empty" when deciding whether to challenge.
    return value === "" ? undefined : value;
  }

  getAcceptHeader(): string {
    return this.context.req.header("Accept") ?? "";
  }

  getUserAgent(): string {
    return this.context.req.header("User-Agent") ?? "";
  }

  getQueryParams(): Record<string, string | string[]> {
    const search = new URL(this.context.req.url).searchParams;
    const collected: Record<string, string | string[]> = {};
    for (const key of new Set(search.keys())) {
      const values = search.getAll(key);
      collected[key] = values.length > 1 ? values : (values[0] ?? "");
    }
    return collected;
  }

  getQueryParam(name: string): string | string[] | undefined {
    const values = new URL(this.context.req.url).searchParams.getAll(name);
    if (values.length > 1) return values;
    return values[0];
  }

  /**
   * Only read a body when the SDK actually asks for one, and only for JSON.
   * Hono caches the parse on the context, so repeated reads are free.
   */
  getBody(): unknown {
    if (!this.context.req.raw.body) return undefined;
    const contentType = this.context.req.header("Content-Type") ?? "";
    if (!contentType.includes("application/json")) return undefined;
    return this.context.req.json().catch(() => undefined);
  }
}
