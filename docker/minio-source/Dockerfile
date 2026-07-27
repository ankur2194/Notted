# syntax=docker/dockerfile:1.18
ARG GO_IMAGE=golang:1.24.5-alpine3.22@sha256:daae04ebad0c21149979cd8e9db38f565ecefd8547cf4a591240dc1972cf1399
ARG RUNTIME_IMAGE=alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1

FROM ${GO_IMAGE} AS server-build
ARG MINIO_SERVER_COMMIT=7aac2a2c5b7c882e68c1ce017d8256be2feea27f
ADD --checksum=sha256:71794c2df26aad0cc99e8421c58b7aa2dd55969f979b0e7d1e931042e9fabcd6 "https://github.com/minio/minio/archive/${MINIO_SERVER_COMMIT}.tar.gz" /tmp/source.tar.gz
RUN mkdir /src && tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src
WORKDIR /src
RUN CGO_ENABLED=0 go build -trimpath -buildvcs=false -o /out/minio .

FROM ${GO_IMAGE} AS client-build
ARG MINIO_CLIENT_COMMIT=77f82e18b5401a65958f1619df6ebb994634bd88
ADD --checksum=sha256:167415edd21bc29f5360943dac64272aa5cda0a39f3070b15cfeca671c43d975 "https://github.com/minio/mc/archive/${MINIO_CLIENT_COMMIT}.tar.gz" /tmp/source.tar.gz
RUN mkdir /src && tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src
WORKDIR /src
RUN CGO_ENABLED=0 go build -trimpath -buildvcs=false -o /out/mc .

FROM ${RUNTIME_IMAGE} AS runtime
RUN addgroup -S -g 10001 notted \
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
