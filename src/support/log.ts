/**
 * Logfmt-ish structured logging on stdout.
 *
 * No logging dependency: one line per event, `key=value` pairs, timestamps in
 * UTC ISO so they sort lexicographically in whatever the operator pipes them
 * into. Levels are filtered by LOG_LEVEL, defaulting to `info` — payments are
 * logged at that level because "who paid how much for what" is the whole
 * audit trail for a service like this.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: LogLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";
if (!(threshold in RANK)) threshold = "info";

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

function emit(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (RANK[level] < RANK[threshold]) return;
  const parts = [`ts=${new Date().toISOString()}`, `level=${level}`, `event=${event}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(`${key}=${text.includes(" ") ? JSON.stringify(text) : text}`);
  }
  const line = parts.join(" ");
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
