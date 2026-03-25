/**
 * Shared pino logger for the Mia daemon.
 *
 * In background/daemon mode (stdout redirected to ~/.mia/daemon.log) logs are
 * written as newline-delimited JSON — trivially queryable with jq:
 *   jq 'select(.level=="error")' ~/.mia/daemon.log
 *   jq 'select(.mia_level=="success")' ~/.mia/daemon.log
 *   jq 'select(.reqId=="a3f2c1b4")' ~/.mia/daemon.log
 *
 * In foreground/TTY mode (or when MIA_PRETTY=1) pino-pretty is used as the
 * transport, producing colourised, human-friendly output instead.
 *
 * The `success` level is a Mia-internal concept that doesn't exist in pino.
 * It maps to pino `info` with an extra `mia_level: "success"` field so callers
 * can still distinguish it downstream without breaking standard log-aggregator
 * level semantics.
 *
 * Set MIA_LOG_LEVEL=trace|debug|info|warn|error to control verbosity.
 * Defaults to "debug" so no runtime messages are silently dropped.
 *
 * ## Request correlation
 *
 * Every daemon command pipeline entry-point (routeMessage, MessageQueue item)
 * generates a short hex request ID and stores it in an AsyncLocalStorage
 * context via withRequestId(). The log() function reads the context on
 * each call and automatically injects reqId into the JSON log object.
 *
 * Multi-step traces are trivially greppable:
 *   jq 'select(.reqId=="a3f2c1b4")' ~/.mia/daemon.log
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';
import type { LogLevel } from '../daemon/constants';

const usePretty = process.stdout.isTTY || process.env.MIA_PRETTY === '1';

export const logger = pino({
  level: process.env.MIA_LOG_LEVEL ?? 'debug',
  base: { pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  ...(usePretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname',
            messageFormat: '{msg}',
          },
        },
      }
    : {}),
});

/**
 * Per-request async context. Carries a short correlation ID that is
 * automatically threaded through every async continuation without needing
 * to plumb it through every function signature.
 */
export interface RequestContext {
  reqId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Run fn with a bound request ID. Every log() call inside fn — including
 * nested async callbacks and promise chains — will automatically include
 * reqId in its JSON output.
 *
 * @example
 *   const reqId = randomBytes(4).toString('hex')
 *   return withRequestId(reqId, async () => { ... })
 */
export function withRequestId<T>(reqId: string, fn: () => T): T {
  return requestContext.run({ reqId }, fn);
}

/**
 * Drop-in replacement for the old ad-hoc (level, msg) => void pattern.
 *
 * Signature is intentionally identical to the inline log() in daemon/index.ts
 * so every call-site — including modules that receive it as a callback
 * (services.ts, queue.ts, router.ts) — works without modification.
 *
 * When called inside a withRequestId() scope the active reqId is merged
 * into the structured log object automatically.
 */
export function log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
  const ctx = requestContext.getStore();
  const base = ctx ? { reqId: ctx.reqId, ...extra } : (extra ?? {});
  switch (level) {
    case 'success':
      logger.info({ mia_level: 'success', ...base }, message);
      break;
    case 'debug':
      logger.debug(base, message);
      break;
    case 'info':
      logger.info(base, message);
      break;
    case 'warn':
      logger.warn(base, message);
      break;
    case 'error':
      logger.error(base, message);
      break;
  }
}
