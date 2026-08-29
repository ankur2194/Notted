# syntax=docker/dockerfile:1.18
#
# Both toolchain images carry the security patch level of the binaries built
# from them, so they are bumped for CVEs, not only for features. `go build`
# links the Go standard library statically, which means every stdlib advisory
# fixed in a Go patch release is fixed here by rebuilding with that release and
# nowhere else.
ARG GO_IMAGE=golang:1.26.7-alpine3.24@sha256:28d89ee9cc0ff9fec75c82ca201e6bf7fdf9a679d4b7b24dfa04f2bb766bb468
ARG RUNTIME_IMAGE=alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

FROM ${GO_IMAGE} AS server-build
ARG MINIO_SERVER_COMMIT=7aac2a2c5b7c882e68c1ce017d8256be2feea27f
ADD --checksum=sha256:71794c2df26aad0cc99e8421c58b7aa2dd55969f979b0e7d1e931042e9fabcd6 "https://github.com/minio/minio/archive/${MINIO_SERVER_COMMIT}.tar.gz" /tmp/source.tar.gz
RUN mkdir /src && tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src
WORKDIR /src
# Upstream is dormant: `MINIO_SERVER_COMMIT` is the current HEAD of minio/minio
# (12 Feb 2026) and the last tagged release predates it, so there is no newer
# source to pin. Its `go.mod` therefore still names module versions with
# published HIGH/CRITICAL advisories, and the only remaining way to clear them
# is to raise those modules here. Each version below is the lowest release that
# closes every advisory Trivy reports against the module it replaces; they are
# exact versions, not ranges, so the build stays reproducible.
#
# `go mod tidy -e` rather than `go mod tidy`: raising prometheus/prometheus
# drags in test-only imports of `github.com/go-openapi/testify/v2/assert/yaml`,
# a package that module does not contain, and a strict tidy aborts on it. `-e`
# records what it can and keeps going, which is enough — `go build` needs the
# `go.sum` entries for the packages it actually compiles, and the step after
# this one fails loudly if any are missing.
RUN go get github.com/apache/thrift@v0.23.0 \
      github.com/buger/jsonparser@v1.1.2 \
      github.com/go-jose/go-jose/v4@v4.1.4 \
      github.com/prometheus/prometheus@v0.311.3 \
      go.opentelemetry.io/otel/sdk@v1.43.0 \
      google.golang.org/grpc@v1.82.1 \
      golang.org/x/crypto@v0.53.0 \
      golang.org/x/net@v0.56.0 \
      golang.org/x/text@v0.39.0 \
    && go mod tidy -e
RUN CGO_ENABLED=0 go build -trimpath -buildvcs=false -o /out/minio .

FROM ${GO_IMAGE} AS client-build
ARG MINIO_CLIENT_COMMIT=77f82e18b5401a65958f1619df6ebb994634bd88
ADD --checksum=sha256:167415edd21bc29f5360943dac64272aa5cda0a39f3070b15cfeca671c43d975 "https://github.com/minio/mc/archive/${MINIO_CLIENT_COMMIT}.tar.gz" /tmp/source.tar.gz
RUN mkdir /src && tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src
WORKDIR /src
# Same reason as the server stage: this commit is minio/mc's current HEAD, and
# `mc` links a smaller dependency set, so it needs a shorter list.
RUN go get github.com/prometheus/prometheus@v0.311.3 \
      google.golang.org/grpc@v1.82.1 \
      golang.org/x/crypto@v0.53.0 \
      golang.org/x/net@v0.56.0 \
      golang.org/x/text@v0.39.0 \
    && go mod tidy -e
RUN CGO_ENABLED=0 go build -trimpath -buildvcs=false -o /out/mc .

FROM ${RUNTIME_IMAGE} AS runtime
# `RUNTIME_IMAGE` is pinned by digest for reproducibility, and Alpine publishes
# security patches to the branch faster than it republishes the base image — so
# the pin alone leaves openssl, musl and zlib advisories standing. `apk upgrade`
# takes the branch's current patch level on top of the pinned base. It is the
# one deliberately floating step in this file: the same Dockerfile built a month
# apart produces different package versions, which is the point.
RUN apk upgrade --no-cache \
    && addgroup -S -g 10001 notted \
    && adduser -S -D -u 10001 -G notted -h /home/notted notted \
    && mkdir -p /home/notted /data \
    && chown -R 10001:10001 /home/notted /data
ENV HOME=/home/notted

FROM runtime AS minio-server
COPY --from=server-build /out/minio /usr/bin/minio
EXPOSE 9000 9001
USER 10001:10001
ENTRYPOINT ["/usr/bin/minio"]

FROM runtime AS minio-client
COPY --from=client-build /out/mc /usr/bin/mc
USER 10001:10001
ENTRYPOINT ["/usr/bin/mc"]
