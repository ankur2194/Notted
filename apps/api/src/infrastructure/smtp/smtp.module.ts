import { Module } from "@nestjs/common";
import nodemailer from "nodemailer";

import { SMTP_CONFIG, type SmtpConfig } from "../../config/smtp.config";

import { SmtpService } from "./smtp.service";
import { SMTP_TRANSPORT } from "./smtp.tokens";

import type { Transporter } from "nodemailer";

@Module({
  providers: [
    {
      provide: SMTP_TRANSPORT,
      inject: [SMTP_CONFIG],
      useFactory: (config: SmtpConfig): Transporter | null =>
        config.enabled
          ? nodemailer.createTransport({
              host: config.host,
              port: config.port,
              secure: config.secure,
              requireTLS: config.requireTls,
              pool: true,
              maxConnections: 3,
              maxMessages: 100,
              logger: false,
              debug: false,
              connectionTimeout: config.connectionTimeoutMs,
              greetingTimeout: config.greetingTimeoutMs,
              socketTimeout: config.socketTimeoutMs,
              auth:
                config.user === undefined
                  ? undefined
                  : {
                      user: config.user,
                      pass: config.password,
                    },
            })
          : null,
    },
    SmtpService,
  ],
  exports: [SmtpService],
})
export class SmtpModule {}
