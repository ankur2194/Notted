# Custom Domains

This document is the operational reference for serving a workspace on a hostname its
owner controls — `notes.acme.com` instead of `app.example.com/workspaces/<id>`. It covers
enabling the feature, the DNS an administrator publishes, the reverse proxy that has to
sit in front of it, certificate renewal, and the limitations a tenant hostname carries.
It is the companion to
[ADR 0014](decisions/0014-workspace-branding-and-custom-domains.md), which records the
decision and its alternatives.

> **Authority.** Part 73 implements custom domains. The reverse proxy this feature
> depends on is **not** shipped by Part 73 — Parts 79 and 80 build the production images
> and the production Compose stack, and Part 82 configures the proxy, TLS, and network
> policy. Until those parts land, everything below describes a deployment an operator
> assembles themselves, and the renewal procedure in § 8 is **documented, not executed**.

## 1. What the feature is

A workspace owner or admin claims a hostname, publishes two DNS records, and asks Notted
to verify them. Once verified, that hostname serves **that one workspace's** web app, and
the API and realtime socket answer on the same origin.

| Concern | Where it lives |
|---|---|
| The claim and its verification state | `workspace_domains` (one row per workspace, hostname globally unique) |
| The verified hostname, mirrored for reads | `workspaces.domain` — **read-only**, written only by the domains service |
| Administrator UI | Workspace settings (`/workspaces/{workspaceId}/settings`), visible to owners and admins |
| REST surface | `GET` / `PUT` / `DELETE /api/v1/workspaces/{workspaceId}/domain`, `POST …/domain/verify`, public `GET /api/v1/domains/resolve` |
| Host enforcement | `TrustedHostMiddleware`, installed in `main.ts` immediately after the request-id middleware |

`workspaces.domain` is no longer writable through `POST`/`PATCH /api/v1/workspaces` — the
`domain` field was removed from both request schemas. Any integration that used to set it
now uses `PUT /api/v1/workspaces/{workspaceId}/domain` and must verify the name before it
does anything.

### 1.1 The prerequisite

**A TLS-terminating reverse proxy that can obtain a certificate for a hostname it has
never seen before, at handshake time.** Notted never obtains, stores, renews, or presents
a certificate. A tenant's browser arrives at the proxy with an SNI name the proxy has no
certificate for, and either the proxy can answer that or the connection fails before any
HTTP request exists.

Two shapes work:

- **On-demand issuance** (Caddy, § 5). The proxy asks Notted whether a name is one of
  ours during the handshake and issues on the spot. Nothing has to be reconfigured when a
  workspace verifies a domain.
- **A controller that reconciles routers** (Traefik, § 6). Something watches the verified
  set and writes a router and a certificate request per host. More moving parts, and a
  newly verified host is live only after the next reconcile.

A wildcard certificate for `*.example.com` covers subdomains of your own zone. It does
**not** cover a tenant's own zone, which is the entire point of the feature, so a
wildcard alone is not a substitute for either shape above.

## 2. Enabling it

Two API environment variables, both documented in
[`environment.md`](environment.md) → Custom-domain values.

| Variable | Default | Notes |
|---|---|---|
| `CUSTOM_DOMAINS_ENABLED` | `false` | The whole feature. Nothing else turns it on. |
| `CUSTOM_DOMAIN_CNAME_TARGET` | the `APP_URL` host | The name tenants CNAME to. A bare hostname — no scheme, no port, no path. |

`CUSTOM_DOMAIN_CNAME_TARGET` defaults to the `APP_URL` hostname, which is correct for the
single-edge topology in § 5. Name something else only when tenant TLS terminates on a
separate edge. Startup fails if the value carries a protocol or a port, exceeds 253
characters, or — in production — is `localhost`, a `*.localhost` name, or an IPv4
literal: a tenant cannot CNAME to a name that only resolves inside your network, and the
resulting failure would be reported to them as a problem with *their* DNS.

### 2.1 What happens with the flag off

This is the default, and it is a complete no-op rather than a half-enabled state:

- All five REST routes answer `404 NOT_FOUND`. The service checks the flag before it
  checks authorization, so the capability does not exist rather than being forbidden.
- `TrustedHostMiddleware` passes every request through untouched. A deployment that has
  always been reached on an address its configuration does not name — a container IP, a
  service-mesh name — keeps working exactly as it did.
- The web app's proxy answers `404` for any host that is not the configured
  `NEXT_PUBLIC_APP_URL` host or a loopback address, because `resolve` refuses every host.
  There is deliberately no second, web-side feature flag that could disagree with this one.
- The workspace settings card renders a single neutral sentence: *"Custom domains are not
  enabled on this deployment, or you do not have access to them."* A `404` cannot
  distinguish "switched off" from "not an admin", and guessing would tell an admin they
  lack a permission they hold.

There is no way to enable half of it. Turning the flag on without a proxy that can serve
tenant hostnames means telling an administrator to point DNS at an address that answers
with the wrong certificate.

## 3. The administrator's DNS steps

An owner or admin opens workspace settings, enters the hostname, and saves. The claim
always lands **`pending`** — a claim is not a proof — and the page then shows the exact
two records to publish. Re-saving the *same* hostname is idempotent and keeps the existing
token, so an administrator who returns to the form is never told to publish a different
value. Saving a *different* hostname replaces the claim wholesale: new token, `pending`
again, and the `workspaces.domain` mirror cleared.

### 3.1 The two records

For a claimed hostname `notes.acme.com` and a `CUSTOM_DOMAIN_CNAME_TARGET` of
`app.example.com`:

| # | Type | Name | Value |
|---|---|---|---|
| 1 | `TXT` | `_notted-verify.notes.acme.com` | `notted-verify=<32 hex characters>` |
| 2 | `CNAME` | `notes.acme.com` | `app.example.com` |

The token is 16 random bytes rendered as 32 hex characters, minted when the claim is
created. The UI renders both records verbatim with a copy control; the API returns them
on every read, so a client never has to know the token format or the CNAME target.

**At a zone apex** (`acme.com` rather than `notes.acme.com`) a CNAME is illegal
(RFC 1034 §3.6.2). Publish the ownership TXT as normal and use your provider's
`ALIAS`/`ANAME`/flattened-CNAME record for the apex. Verification falls back to comparing
resolved addresses: **every** address the claimed host resolves to must also be an address
the target resolves to. Partial overlap fails — a name that answers both with us and with
somewhere else is not delegated to us.

### 3.2 Verification

`POST /api/v1/workspaces/{workspaceId}/domain/verify` — the **Check again** button — runs
the checks in order and records the verdict. Ownership TXT first, then delegation; only
the first failure is reported, because there is no point telling someone their CNAME is
wrong when they have not published the ownership record yet.

Every lookup is bounded at **5 seconds**, and a verify performs at most four of them.

On success the status becomes `verified`, `verified_at` is stamped, `workspaces.domain`
mirrors the hostname, and the host starts answering within the caches described in § 10.1.
On failure the status becomes `error` and `lastError` carries one of four fixed values —
never a resolver's own message, which would be uncontrolled third-party text in a
tenant-readable column.

| `lastError` | What it means | Remedy |
|---|---|---|
| `txt_missing` | No TXT record answered at `_notted-verify.<host>`, or the lookup failed. | Add the record exactly as shown. New records can take up to an hour to publish. |
| `txt_mismatch` | A TXT record exists but no value matches `notted-verify=<token>`. | Replace it with the value shown, and delete any older Notted verification record on the same name. |
| `cname_mismatch` | The CNAME does not point at the target, and the apex address fallback did not match either. | Point the CNAME at the target shown, and remove any `A`/`AAAA` record on the same name. At an apex, make the ALIAS resolve to exactly the target's addresses. |
| `dns_failure` | The zone's nameservers could not be reached at all during the address fallback. | Confirm the domain is registered and its nameservers respond, then check again. |

A failed **re-**verification of a previously verified host clears the mirror and stops the
host routing. That is deliberate: a hostname whose delegation has been withdrawn must not
keep serving under a claim nobody can currently prove.

Removing a claim (`DELETE …/domain`) is idempotent, frees the hostname globally for
whoever proves ownership next, and clears the mirror.

## 4. The same-origin routing requirement

**A tenant hostname must serve the web app, `/api/`, `/api/auth/`, and `/socket.io/` from
the same origin, proxied to the same backends the primary host uses.** This is not a
recommendation; the feature does not work otherwise.

Why: session cookies are **host-only** and `SameSite=Lax`. A browser on
`https://notes.acme.com` does not attach a cookie set for `api.example.com`, so a page
that called the configured API origin cross-site would render for a signed-in user who
cannot read anything. `apps/web/src/lib/api/api-origin.ts` therefore picks the API and
WebSocket origin **at runtime**: in a browser whose own host is not the configured
`NEXT_PUBLIC_APP_URL` host, both resolve to the page's own origin. That is only correct if
the proxy actually terminates all four path families there.

| Path prefix on the tenant host | Proxy to | Why |
|---|---|---|
| `/api/` | the API | Every REST and tRPC call the page makes |
| `/api/auth/` | the API | Better Auth is mounted outside the versioned API; it is a subset of `/api/`, so one rule covers both |
| `/socket.io/` | the API | Realtime. The default path; `REALTIME_PATH` renames it |
| everything else | the web app | Pages and assets |

Two more proxy obligations:

- **Set the forwarded headers** (`X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-For`)
  and set **`TRUST_PROXY_HOPS`** to the number of proxies in front of the API. The
  trusted-host check reads Express's `request.hostname`, which derives from
  `X-Forwarded-Host` only when `trust proxy` is configured. With `TRUST_PROXY_HOPS=0` a
  forged `X-Forwarded-Host` is correctly ignored — and so is a genuine one.
- **Do not expose the API directly to the public internet** alongside the proxy. The
  trusted-host middleware refuses unknown hosts, but the whole forwarded-header contract
  assumes one path in.

Nothing about `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL`
changes. They are baked into the browser bundle at build time and stay pointed at the
primary host; the runtime swap above is what makes one bundle correct on every tenant
host.

## 5. Caddy (the reference topology)

Caddy is the reference here because it is the one common proxy with a native hook for
this: `on_demand_tls`'s `ask` directive. **Caddy calls `ask` during the TLS handshake**,
before any HTTP request exists, appending `?domain=<sni-name>` to the URL. It issues a
certificate **only on a 2xx**; anything else — including our `404` — makes it abandon the
handshake. That is exactly the contract `GET /api/v1/domains/resolve` implements, and it
is why the route accepts `?domain=` as well as `?host=`: Caddy offers no way to rename its
parameter.

```caddyfile
{
	# Called during the TLS handshake for any hostname Caddy has no certificate
	# for. Caddy appends ?domain=<sni-name>. 2xx issues; 404 refuses.
	#
	# Address the API on the INTERNAL network. Sending this back through the
	# public edge would make certificate issuance depend on the certificate.
	on_demand_tls {
		ask http://api:3001/api/v1/domains/resolve
	}
}

# The deployment's own hostnames keep ordinary, up-front ACME.
app.example.com {
	@backend path /api/* /socket.io/*
	reverse_proxy @backend api:3001
	reverse_proxy web:3000
}

api.example.com {
	reverse_proxy api:3001
}

# Every other hostname that arrives is a candidate tenant host. Caddy matches
# this block only when no named block above matched.
https:// {
	tls {
		on_demand
	}

	@backend path /api/* /socket.io/*
	reverse_proxy @backend api:3001
	reverse_proxy web:3000
}
```

`/api/auth/*` needs no rule of its own — it is under `/api/*`. Caddy's `reverse_proxy`
sets `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For` by default, so set
`TRUST_PROXY_HOPS=1` on the API.

The tenant-host block deliberately proxies to the **same** backends as the primary host.
The API decides which workspace a request may touch; the proxy's job is only to terminate
TLS for a name Notted has already vouched for.

### 5.1 The `ask` route and rate limits

`GET /api/v1/domains/resolve` is deliberately on the **default unauthenticated** tier
(`RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE`, default **60**) rather than the sensitive one.
Behind a proxy every `ask` arrives from a single IP and therefore shares a single bucket,
and a refused `ask` is a **failed TLS handshake** — the visitor sees a certificate error,
and because the refusal happens before any application request exists, nothing about it
reaches the application logs. Throttling certificate issuance into silent breakage is a
worse outcome than the enumeration a tighter tier would slow down, particularly as an
attacker must already know a verified hostname to get anything but a `404`, and what they
learn is the workspace id and slug that the hostname's own public CNAME already announces.

Caddy asks once per name it does not already hold a certificate for, and the web app's own
resolve lookups are cached for 60 seconds, so 60 a minute is ample in steady state. A
deployment onboarding many hostnames at once should still raise
`RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE` and watch for `429` in the proxy's logs.

## 6. Traefik

**Traefik has no equivalent of `ask`.** Its certificate resolvers issue for the hostnames
declared on routers, and there is no hook that consults an external service mid-handshake.
Serving tenant hostnames with Traefik therefore needs two pieces:

1. **A certificate resolver** (ACME HTTP-01 or TLS-ALPN-01) as usual.
2. **A controller** — a small process or a config-generation step — that keeps one router
   per verified hostname in Traefik's dynamic configuration, each with the same
   service and path rules the primary host uses (§ 4), and each pinned to that resolver.

**`GET /api/v1/domains/resolve` is the source of truth that controller reconciles
against.** It answers `{ "workspaceId": …, "slug": … }` for a verified host and `404` for
everything else, so a controller can confirm any hostname it is about to publish a router
for, and drop routers whose host has stopped resolving. There is no list endpoint: the
route answers about one host at a time, by design (§ 11).

Consequences to plan for, none of which apply to the Caddy topology:

- A newly verified hostname is live only after the next reconcile, not at the next
  handshake. Tell administrators what that interval is.
- A removed or re-verification-failed hostname keeps a valid certificate until the
  controller removes its router. The API still refuses the host with `421`, so the tenant
  sees an error rather than someone else's content — but the certificate is live until it
  is cleaned up.
- Let's Encrypt rate limits apply per registered domain, and a controller that
  re-requests on every reconcile will find them. Persist the resolver's storage.

## 7. Certificates and renewal

**Renewal is entirely the reverse proxy's job.** Notted stores no certificate, no private
key, and no ACME account, and has no code path that talks to an ACME server. The
`workspace_domains` table holds a hostname, a status, a DNS verification token, and
timestamps — nothing cryptographic.

That has three practical consequences:

- **Renewal cannot fail "in Notted".** A certificate that fails to renew is a proxy
  incident, diagnosed in the proxy's logs and its ACME storage.
- **The proxy's certificate storage is state that must be persisted and backed up.**
  A volume that is recreated on deploy makes every tenant hostname re-issue at once, and
  Let's Encrypt's per-domain rate limits will notice.
- **Notted can still break renewal indirectly.** A hostname whose claim was removed, or
  whose re-verification failed, stops resolving through `GET /api/v1/domains/resolve`. On
  Caddy that means the next issuance or renewal attempt for it is refused, which is
  correct — but it is why a renewal failure should always be checked against the claim's
  current status before it is treated as a proxy fault.

## 8. Staging renewal verification (documented, not executed in this part)

This procedure is **written down here and deliberately not run by Part 73**. Part 82
configures the proxy and its TLS, and this is the check to run against a staging
deployment once that exists. Never rehearse it against production ACME: failed attempts
consume Let's Encrypt's production rate limits and take a week to clear.

**Preconditions.** A staging deployment with `CUSTOM_DOMAINS_ENABLED=true`, a
`CUSTOM_DOMAIN_CNAME_TARGET` that resolves publicly to the staging edge, one throwaway
domain you control, and the proxy from § 5 or § 6.

1. **Point the proxy at the Let's Encrypt staging directory.** In Caddy, set
   `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory` in the global options
   block; in Traefik, set the resolver's `caServer` to the same URL. Staging issues
   untrusted certificates from a test root, which is what you want — a browser warning
   here is expected and is not the thing under test.
2. **Wipe the proxy's certificate storage** so nothing is served from a previous run
   (Caddy: the `/data` volume; Traefik: `acme.json`). Restart the proxy.
3. **Claim and verify the throwaway hostname** through workspace settings: publish the TXT
   and CNAME from § 3.1, then **Check again** until the status reads `Verified`.
4. **Assert first issuance.** Open `https://<throwaway-host>/` in a browser and accept the
   staging-root warning, or run
   `openssl s_client -connect <edge>:443 -servername <throwaway-host> </dev/null | openssl x509 -noout -issuer -subject -dates`.
   Assert: the issuer names the Let's Encrypt **staging** root, the subject covers the
   throwaway hostname, and the page renders the workspace's app.
   Assert in the proxy's log that exactly one `ask` was made and that it returned 2xx.
5. **Force an early renewal.** Do **not** wait 60 days. Either move the proxy's clock
   forward past the renewal window in an isolated container, or delete just that
   hostname's certificate from the proxy's storage and reload — which exercises issuance
   again, including the `ask` call, though not the renewal scheduler itself. State in your
   record which of the two you did; they prove different things.
6. **Assert renewal.** Re-run the `openssl` command. Assert: the `notBefore` date has
   moved, the certificate serial has changed, the page still renders, and **no
   configuration change and no Notted restart was needed** in between.
7. **Assert the negative.** Remove the claim in workspace settings
   (`DELETE …/domain`), wait past the negative cache (10 s in the API, up to 60 s for the
   web app's resolve cache), then request an issuance for a *different*, unclaimed
   hostname pointed at the same edge. Assert: `GET /api/v1/domains/resolve?domain=<name>`
   returns `404`, the handshake fails, and **no certificate was issued**. This is the
   check that proves the `ask` seam is actually gating issuance rather than decorating it.
8. **Restore.** Remove the staging `acme_ca`/`caServer` override, wipe the staging
   certificate storage again so no test-root certificate survives into a production
   directory, and restart.

Record the issuer, the serials before and after, and the `ask` responses in the part or
incident record. A run that only proves step 4 has proved issuance, not renewal.

## 9. Sessions and sign-in limitations

Both of these are consequences of host-only cookies, and both are **current, documented
limitations** rather than bugs.

### 9.1 Sessions are per host

A session cookie set on `app.example.com` is not sent to `notes.acme.com`, and vice
versa. A user who is signed in on the primary host and then opens the tenant host is
signed out there, and must sign in again. Signing out on one host does not sign them out
on the other.

This is the correct security posture — a tenant's hostname must not receive a cookie
scoped to the platform's, and one tenant's host must never receive another's — but it is
a visible cost, and administrators should be told about it before they roll a custom
domain out to their members.

### 9.2 OAuth, magic link, and passkey always return to the primary host

Every sign-in flow that leaves the page and comes back builds its return URL from
`NEXT_PUBLIC_APP_URL`, which is the **primary** application host:

| Method | On a custom host |
|---|---|
| Email + password (and the 2FA challenge) | Works. Nothing leaves the page. |
| OAuth (Google, GitHub, Microsoft) | The provider redirects to the primary host. The user ends up signed in **there**, not on the tenant host. |
| Magic link | The emailed link points at the primary host. |
| Passkey | The WebAuthn relying-party ID and origins are fixed configuration (`AUTH_PASSKEY_RP_ID`, `AUTH_PASSKEY_ORIGINS`) and name the primary host. |

So the supported flow on a custom host today is **password sign-in**, with TOTP if the
account requires it. A member who uses OAuth, a magic link, or a passkey signs in on the
primary host and then navigates to the tenant host, where they will be asked to sign in
again (§ 9.1). Say so in whatever you hand your administrators.

## 10. Troubleshooting

### 10.1 Caches to know about before you debug anything

| Cache | TTL | Effect |
|---|---|---|
| API trusted-host, positive | 60 s per process | A removed or failed host can keep answering for up to a minute |
| API trusted-host, negative | 10 s per process | A newly verified host starts answering within about ten seconds |
| Web proxy unknown-host memo | 60 s per web process, 500 entries | The web app can 404 a freshly verified host for up to a minute. Only a definitive `404` from `resolve` is remembered; a timeout or 5xx is not, so an API blip cannot pin a real host |
| Proxy certificate cache | proxy-specific | Caddy holds an issued certificate independently of all of the above |

None of these is a correctness mechanism, and a database error is never cached. If a
change has not taken effect, wait out the longest applicable TTL before investigating.

**Removal is not instant fleet-wide.** `invalidate()` clears the process that
handled the call and no other, so after `DELETE …/domain` — or after a
re-verification that fails — **every other API process keeps trusting the
hostname for up to 60 s**: no `421`, a CORS allow, and a passing
`assertTrustedMutationOrigin`. Nothing is granted by that alone (the request
still authenticates and still passes workspace authorization; what lags is the
routing decision, not the access decision), but if a hostname is being removed
because it was compromised, treat it as still trusted for a further minute and
pull it at the reverse proxy as well. The fix is a `domain.verified` /
`domain.removed` message over the Redis pub/sub the realtime adapter already
runs on, invalidating in every process; it lands with the first multi-replica
deployment (Part 80).

### 10.2 Symptoms

| Symptom | Likely cause | What to check |
|---|---|---|
| `421 UNTRUSTED_HOST` from the API | The `Host` (or `X-Forwarded-Host`) the API saw is not a configured host and not a verified tenant host. | Is the claim `verified`? Is `CUSTOM_DOMAINS_ENABLED=true` on **this** API process? Is `TRUST_PROXY_HOPS` ≥ 1 so the forwarded host is read at all? Is the negative cache still holding a stale "no" (§ 10.1)? A database outage fails **closed** — check readiness. `/health/live` and `/health/ready` are exempt and will answer regardless, so a healthy probe proves nothing here. |
| `404` from the web app on the tenant host | The web proxy could not resolve the host. | Call `GET /api/v1/domains/resolve?host=<name>` from inside the network. A `404` means unverified, removed, feature disabled, or a malformed name. A slow or failed call also resolves to 404 — the lookup carries a 3-second abort and fails closed. |
| `resolve` returns `404` for a host that looks verified | Normalisation mismatch, or the status is not `verified`. | The stored hostname is lowercase punycode with no trailing dot. `Notes.ACME.com`, `notes.acme.com.` and `münchen.example` all normalise before lookup — but a name with a port, path, or wildcard is refused outright and answers the same `404`. Confirm the row's `status` is `verified` and not `pending`/`error`. Only `verified` rows answer. |
| Signed in, but every request 401s; or the session cookie is never attached | The tenant host is not serving `/api/` and `/api/auth/` from its own origin. | § 4. The browser resolves the API to the page's own origin on a non-primary host; if the proxy sends those paths anywhere else — or nowhere — the host-only cookie is not attached. Check the proxy's path rules, and confirm the cookie's `Domain` is the tenant host. |
| Sign-in redirects to the primary host and the tenant host still asks for a sign-in | Expected. | § 9.2. Use password sign-in on the tenant host. |
| Certificate handshake fails for one hostname only | The `ask` refused it, or the controller has not published a router. | Caddy: grep the proxy log for the `ask` and its status. Traefik: check the reconcile. Then check for `429` on the resolve route (§ 5.1). |
| `409 DOMAIN_TAKEN` on a name nobody appears to be using | Another workspace holds the claim, or this workspace already has one. | The message is deliberately identical for both — naming the other workspace would leak that a foreign tenant holds the name. Ask the claimant to remove it, or remove this workspace's existing claim first. |
| `422 DOMAIN_RESERVED` | The hostname is one the deployment already answers on. | `APP_URL`, `API_URL`, `WS_URL`, `BETTER_AUTH_URL`, the configured trusted origins, and `CUSTOM_DOMAIN_CNAME_TARGET` are all reserved. Choose a different name. |

## 11. Security notes

**A pending claim routes nothing.** Only rows with `status = 'verified'` are consulted by
the trusted-host check and by `resolve`. Claiming a hostname is therefore not an attack:
it reserves the name in the database and produces a token to publish, and until DNS proves
the claimant controls the name, the hostname serves nothing, issues no certificate, and
is refused with `421`.

**The hostname is globally unique.** Two workspaces claiming the same name is not a
conflict to reconcile later — it is two tenants racing for one address, and the database
unique constraint is the only place that race can be settled honestly. The 409 that
results is deliberately indistinguishable from "you already have a claim".

**Both DNS records are required, and neither is sufficient.** The TXT record proves
control of DNS for the name; without it, anyone could aim a CNAME at us and claim a
hostname they merely point at us. The CNAME (or apex address match) proves the name is
actually delegated here; without it, a workspace could hold a globally unique hostname
that resolves somewhere else entirely, denying it to its real owner.

**`verification_token` is stored in plaintext, on purpose.** Its entire function is to be
**published in a TXT record that anyone on the internet can read**. It is not a
credential: it grants nothing, authenticates nothing, and proves only that whoever
published it controls the zone. Hashing it would make it impossible to tell the
administrator what to publish, in exchange for protecting a value that is public by
construction. It is never written to the audit log, not because it is secret, but because
`audit_logs` is CSV-exportable and an auditor learns nothing from it.

**`GET /api/v1/domains/resolve` is public, and narrow.** It answers only for verified
hosts, returns identifiers only — no name, no plan, no member count — and every miss is
the same `404`, so it cannot enumerate pending claims or probe which workspaces exist.
What it discloses is the mapping between a hostname that is already public in the global
DNS and the workspace the administrator's own CNAME already announces. It is one of two
deliberately unauthenticated routes in the API; see [`API.md`](API.md) for the other.

**The trusted-host middleware is the edge check, not the boundary.** It refuses a request
whose `Host` this deployment does not serve, so nothing downstream that builds an absolute
URL from the host header can be steered by an attacker. It runs before CORS, before the
Better Auth handler, and before every route. It is not what keeps one tenant out of
another's data — every route still re-authorizes workspace membership server-side
(see [`authorization.md`](authorization.md)), and the web proxy's host rules are a
coherence boundary, not a security one.

---

Related: [ADR 0014](decisions/0014-workspace-branding-and-custom-domains.md) (the
decision), [`environment.md`](environment.md) (the two variables),
[`API.md`](API.md) (the five routes),
[`standards/operations.md`](standards/operations.md) (reverse-proxy and TLS posture).
