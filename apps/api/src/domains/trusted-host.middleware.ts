// Part 73 — host-header enforcement.
//
// WHAT THIS DEFENDS. Once a deployment answers on more than one hostname, the
// `Host` header stops being decoration. An attacker who can reach the API
// directly can send any `Host` they like, and anything downstream that builds an
// absolute URL from it — a password-reset link, a cached response key, a proxy's
// routing decision — inherits that choice. The defence is not to sanitise the
// header everywhere it is read; it is to refuse the request at the edge unless
// the host is one this deployment actually serves.
//
// WHY 421 AND NOT 404. `421 Misdirected Request` is the status that exists for
// exactly this: "this connection reached the right server but the wrong
// authority". A proxy that sees it knows to re-resolve rather than to cache a
// negative, and it does not pretend the resource is missing.
//
// HEALTH IS EXEMPT. Container and load-balancer probes dial the container's own
// address with whatever `Host` the orchestrator supplies — often an IP, often
// nothing meaningful. A readiness probe that fails because of a header would
// take a healthy deployment out of rotation, and the health routes disclose
// nothing a host check is protecting.
//
// `request.hostname` IS USED, NOT `request.headers.host`. Express derives it
// from `X-Forwarded-Host` when — and only when — `trust proxy` is configured
// (`main.ts` sets it from `TRUST_PROXY_HOPS`), which is precisely the behaviour
// wanted: behind a configured proxy the forwarded host is authoritative, and
// with no proxy configured a forged `X-Forwarded-Host` is ignored.

import { HttpStatus, Inject, Injectable, type NestMiddleware } from "@nestjs/common";

import { VerifiedHostsService } from "../common/verified-hosts.service";
import { APP_CONFIG, type AppConfig } from "../config/app.config";

import type { NextFunction, Request, Response } from "express";

/** Paths that answer whatever `Host` they are dialled with. */
const EXEMPT_PATH_PREFIXES = ["/health/live", "/health/ready"];

export function isHostCheckExempt(path: string): boolean {
  return EXEMPT_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

@Injectable()
export class TrustedHostMiddleware implements NestMiddleware {
  constructor(
    private readonly verifiedHosts: VerifiedHostsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    // With custom domains off there is exactly one set of hosts and it is the
    // configured one; enforcing it here would newly reject deployments that
    // have always been reached on an address the config does not name (a
    // container IP, a service mesh name). This part does not change who can
    // reach an API that serves one tenant surface.
    if (!this.config.customDomainsEnabled) {
      next();
      return;
    }
    if (isHostCheckExempt(request.path)) {
      next();
      return;
    }
    void this.verifiedHosts
      .isTrustedHost(request.hostname ?? "")
      .then((trusted) => {
        if (trusted) {
          next();
          return;
        }
        response.status(HttpStatus.MISDIRECTED).json({
          success: false,
          error: {
            code: "UNTRUSTED_HOST",
            message: "This host is not served by this deployment.",
          },
          requestId: response.getHeader("X-Request-Id") ?? "unknown",
        });
      })
      .catch(() => {
        // `isTrustedHost` already fails closed on a database error, so reaching
        // here means something unexpected. Refuse rather than let an unchecked
        // host through on an error path.
        response.status(HttpStatus.MISDIRECTED).json({
          success: false,
          error: {
            code: "UNTRUSTED_HOST",
            message: "This host is not served by this deployment.",
          },
          requestId: response.getHeader("X-Request-Id") ?? "unknown",
        });
      });
  }
}
