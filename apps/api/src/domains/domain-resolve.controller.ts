// Part 73 — the PUBLIC host-to-workspace lookup.
//
// WHY IT IS PUBLIC, AND WHY THAT IS SAFE.
//
// Two callers need this before any session exists:
//
//   1. A reverse proxy answering `on_demand_tls ask` — it asks "should I obtain
//      a certificate for this SNI name?" during a TLS handshake, and there is no
//      request, no cookie, and no header to authenticate with at that point.
//   2. The web proxy (`apps/web/src/proxy.ts`) deciding whether an incoming
//      custom host is one of ours at all, before it renders anything.
//
// What it discloses is the mapping between a hostname that is ALREADY PUBLIC in
// the global DNS and the workspace it points at — which is what the CNAME the
// administrator published already announces. It returns identifiers only (no
// name, no plan, no member count), it answers ONLY for verified hosts, and every
// miss is the same 404, so it cannot be used to enumerate pending claims or to
// probe which workspaces exist.
//
// It is a SECOND deliberately unauthenticated route (the workspace logo GET is
// the first), and `docs/API.md` names both.
//
// It is NOT mounted under `workspaces/:workspaceId` on purpose: the caller does
// not know the workspace — finding it out is the entire question.

import { Controller, Get, HttpStatus, Query } from "@nestjs/common";
import { domainResolveQuerySchema } from "@notted/shared-validators";

import { ApiHttpException } from "../common/errors/api-http.exception";

import { DomainsService } from "./domains.service";

import type { DomainResolveResult } from "@notted/shared-types";

@Controller("domains")
export class DomainResolveController {
  constructor(private readonly domains: DomainsService) {}

  /**
   * DELIBERATELY ON THE DEFAULT UNAUTHENTICATED TIER, not `sensitive`.
   *
   * `sensitive` was the instinctive choice for an unauthenticated route and it
   * is the wrong one here. Every caller arrives through the SAME reverse proxy,
   * so they all share one `ip:<addr>:sensitive` bucket — and that bucket's
   * default is 10 requests a minute. A refused `on_demand_tls ask` is a FAILED
   * TLS HANDSHAKE: the visitor sees a certificate error, and because the refusal
   * happens before any application request exists, nothing about it appears in
   * the application logs. Throttling certificate issuance into silent breakage
   * is a worse outcome than the enumeration this tier would slow down.
   *
   * The enumeration it would slow down is also worth little: an attacker must
   * already know a verified hostname to get anything but a 404, and what they
   * learn is the workspace id and slug that the hostname's own public CNAME
   * already announces. The default unauthenticated allowance still bounds it.
   */
  @Get("resolve")
  resolve(@Query() rawQuery: unknown): Promise<DomainResolveResult> {
    const query = domainResolveQuerySchema.safeParse(rawQuery);
    // A malformed host is answered with the SAME 404 as an unknown one: this
    // route's whole contract is "yes, and whose" or "no", and a 422 here would
    // tell a prober that their syntax, at least, was on the right track.
    if (!query.success) {
      throw new ApiHttpException(HttpStatus.NOT_FOUND, {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      });
    }
    return this.domains.resolve(query.data.host);
  }
}
