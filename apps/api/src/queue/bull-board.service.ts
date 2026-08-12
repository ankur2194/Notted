import { createBullBoard } from "@bull-board/api";
import { ExpressAdapter } from "@bull-board/express";
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { Router } from "express";

import { BULL_BOARD_PATH } from "./bull-board-policy";
import { QueueInfrastructureService } from "./queue-infrastructure.service";
import { RedactedBullMqAdapter } from "./redacted-bull-mq.adapter";

import type { NextFunction, Request, RequestHandler, Response } from "express";

@Injectable()
export class BullBoardService implements OnApplicationBootstrap {
  private readonly router = Router();
  private ready = false;

  constructor(private readonly infrastructure: QueueInfrastructureService) {}

  onApplicationBootstrap(): void {
    this.initialize();
  }

  middleware(): RequestHandler {
    return (request: Request, response: Response, next: NextFunction): void => {
      this.initialize();
      if (!this.ready) {
        response.status(503).json({
          success: false,
          error: { code: "SERVICE_UNAVAILABLE", message: "Queue administration is unavailable." },
          requestId: response.getHeader("X-Request-Id") ?? "unknown",
        });
        return;
      }
      this.router(request, response, next);
    };
  }

  private initialize(): void {
    if (this.ready) return;
    const queues = this.infrastructure.internalBullBoardQueues();
    if (queues.length === 0) return;
    const serverAdapter = new ExpressAdapter().setBasePath(BULL_BOARD_PATH);
    createBullBoard({
      queues: queues.map((queue) => new RedactedBullMqAdapter(queue)),
      serverAdapter,
      options: { uiConfig: { boardTitle: "Notted queue operations" } },
    });
    serverAdapter.setErrorHandler(() => ({
      status: 500,
      body: { error: "Administrative queue action failed." },
    }));
    this.router.use(serverAdapter.getRouter() as RequestHandler);
    this.ready = true;
  }
}
