# syntax=docker/dockerfile:1.18
#
# Security patches applied on top of three upstream images that are still
# published with fixable HIGH/CRITICAL advisories against them.
#
# Every base here stays pinned by digest, exactly as it was when compose.yaml
# pulled it directly; the targets below add one patch layer each and nothing
# else. No configuration, no entrypoint, no user change — all three upstream
# images run as root and keep doing so, so `pnpm security:containers` is the
# only observable difference.
#
# The alternative was suppressing the advisories with an expiry date, which the
# repository already does for dependencies (`pnpm.auditConfig.ignoreGhsas`).
# A suppression is right when nothing can be done; here something can, in four
# lines per image, so it is not.
ARG GO_IMAGE=golang:1.26.7-alpine3.24@sha256:28d89ee9cc0ff9fec75c82ca201e6bf7fdf9a679d4b7b24dfa04f2bb766bb468
ARG POSTGRES_IMAGE=pgvector/pgvector:0.8.6-pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b
ARG MEILISEARCH_IMAGE=getmeili/meilisearch:v1.45.1@sha256:ac40212f9e5a7526d8007586e3e46fb0441d29dd36c7b02fa2341d2c9a1f6493
ARG MAILPIT_IMAGE=axllent/mailpit:v1.31.0@sha256:c96991d9bef73594c246d89ca81411d4e916f03e76a7d2d72fa2ab5dd3c9ce24

# `gosu` is the only Go binary in the Postgres image, and the only thing Trivy
# reports against it: the published binary is built with Go 1.24.6, which
# carries one CRITICAL and eight HIGH standard-library advisories. Go links the
# standard library statically, so rebuilding the same released source with a
# patched toolchain is the fix — there is no package to upgrade.
FROM ${GO_IMAGE} AS gosu-build
ARG GOSU_VERSION=1.19
ADD --checksum=sha256:cd9719b775dbfedae53923c9b0dc792b66d42c51e0b36652ed6f747fbadc0164 "https://github.com/tianon/gosu/archive/refs/tags/${GOSU_VERSION}.tar.gz" /tmp/gosu.tar.gz
RUN mkdir /src && tar -xzf /tmp/gosu.tar.gz --strip-components=1 -C /src
WORKDIR /src
RUN CGO_ENABLED=0 go build -trimpath -buildvcs=false -o /out/gosu .

# `docker-entrypoint.sh` calls `exec gosu postgres …` to drop privileges before
# starting the server, so this binary has to keep working: `gosu --version`
# reports the same 1.19, built with the patched toolchain.
FROM ${POSTGRES_IMAGE} AS postgres
COPY --from=gosu-build /out/gosu /usr/local/bin/gosu

# Alpine ships security fixes to the branch well before it republishes the base
# image, and both images below are Alpine-based, so their openssl (and, for
# Meilisearch, c-ares) advisories are fixed in the repository the image already
# points at. `apk upgrade` is therefore the whole patch. It is deliberately
# floating: the pinned digest fixes what is built on, and this step takes the
# branch's current patch level on top of it.
FROM ${MEILISEARCH_IMAGE} AS meilisearch
RUN apk upgrade --no-cache

FROM ${MAILPIT_IMAGE} AS mailpit
RUN apk upgrade --no-cache
