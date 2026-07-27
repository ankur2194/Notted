import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";

import { Module } from "@nestjs/common";
import { Client } from "minio";

import { MINIO_CONFIG, type MinioConfig } from "../../config/minio.config";

import { MinioService } from "./minio.service";
import { MINIO_AGENT, MINIO_CLIENT } from "./minio.tokens";

import type { Agent } from "node:http";

@Module({
  providers: [
    {
      provide: MINIO_AGENT,
      inject: [MINIO_CONFIG],
      useFactory: (config: MinioConfig): Agent | null =>
        config.enabled
          ? config.useSsl
            ? new HttpsAgent({ keepAlive: true, timeout: config.readinessTimeoutMs })
            : new HttpAgent({ keepAlive: true, timeout: config.readinessTimeoutMs })
          : null,
    },
    {
      provide: MINIO_CLIENT,
      inject: [MINIO_CONFIG, MINIO_AGENT],
      useFactory: (config: MinioConfig, agent: Agent | null): Client | null =>
        config.enabled
          ? new Client({
              endPoint: config.endPoint,
              port: config.port,
              useSSL: config.useSsl,
              accessKey: config.accessKey,
              secretKey: config.secretKey,
              region: config.region,
              transportAgent: agent ?? undefined,
            })
          : null,
    },
    MinioService,
  ],
  exports: [MinioService],
})
export class MinioModule {}
