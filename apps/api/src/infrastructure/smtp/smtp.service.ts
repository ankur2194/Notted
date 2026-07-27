import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";

import { StructuredLogger } from "../../common/logging/structured-logger.service";
import { SMTP_CONFIG, type SmtpConfig } from "../../config/smtp.config";
import { DependencyState, retryBounded, withTimeout } from "../dependency-lifecycle";

import { SMTP_TRANSPORT } from "./smtp.tokens";

import type { ReadinessCheckResult, ReadinessIndicator } from "../../health/readiness-indicator";
import type { Transporter } from "nodemailer";

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
}

@Injectable()
export class SmtpService implements ReadinessIndicator, OnModuleInit, OnApplicationShutdown {
  readonly name = "smtp";
  private readonly state: DependencyState;

  constructor(
    @Inject(SMTP_CONFIG) private readonly config: SmtpConfig,
    @Inject(SMTP_TRANSPORT) private readonly transport: Transporter | null,
    logger: StructuredLogger,
  ) {
    this.state = new DependencyState(this.name, config.enabled, logger);
  }

  async onModuleInit(): Promise<void> {
    if (this.transport === null) {
      return;
    }
    try {
      await retryBounded(
        () => this.verify(),
        this.config.startupRetryAttempts,
        this.config.retryDelayMs,
      );
      this.state.transition("up");
    } catch {
      this.state.transition("down");
    }
  }

  async send(message: EmailMessage): Promise<string> {
    const result = await this.requireTransport().sendMail({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return result.messageId;
  }

  async check(): Promise<ReadinessCheckResult> {
    if (this.transport === null) {
      return this.state.result();
    }
    try {
      await this.verify();
      this.state.transition("up");
      return this.state.result();
    } catch {
      this.state.transition("down");
      return this.state.result("SMTP probe failed");
    }
  }

  onApplicationShutdown(): void {
    this.state.transition("down");
    this.transport?.close();
  }

  private async verify(): Promise<void> {
    await withTimeout(
      () =>
        this.requireTransport()
          .verify()
          .then(() => undefined),
      this.config.readinessTimeoutMs,
    );
  }

  private requireTransport(): Transporter {
    if (this.transport === null) {
      throw new Error("SMTP is disabled");
    }
    return this.transport;
  }
}
