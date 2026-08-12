import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";

import type { QueueJobJson } from "@bull-board/api/typings/app";
import type { Job, Queue } from "bullmq";

const REDACTED = Object.freeze({ redacted: true });

/** Defense in depth beyond formatters: no raw job can reach Bull Board JSON. */
export class RedactedBullMqAdapter extends BullMQAdapter {
  constructor(queue: Queue<unknown>) {
    super(queue, {
      allowRetries: true,
      readOnlyMode: false,
      displayName: queue.name,
      description: "Operational queue (job details redacted)",
    });
    this.setFormatter("data", () => REDACTED);
    this.setFormatter("returnValue", () => REDACTED);
    this.setFormatter("name", () => "redacted-job");
  }

  override async getJob(id: string): Promise<Job | undefined> {
    const job = await super.getJob(id);
    return job === undefined ? undefined : redactedJob(job);
  }

  override async getJobs(...args: Parameters<BullMQAdapter["getJobs"]>): Promise<Job[]> {
    const jobs = await super.getJobs(...args);
    return jobs.map(redactedJob);
  }

  override async getJobLogs(): Promise<string[]> {
    return [];
  }
}

function redactedJob(job: Job): Job {
  const originalToJson = job.toJSON.bind(job);
  Object.defineProperty(job, "toJSON", {
    configurable: true,
    value: () => safeJobJson(originalToJson()),
  });
  return job;
}

export function safeJobJson(job: ReturnType<Job["toJSON"]>): QueueJobJson {
  return {
    id: job.id,
    name: "redacted-job",
    progress: 0,
    attemptsMade: job.attemptsMade,
    finishedOn: job.finishedOn,
    processedOn: job.processedOn,
    processedBy: null,
    delay: job.delay,
    timestamp: job.timestamp,
    failedReason: job.failedReason ? "redacted-error" : "",
    stacktrace: null,
    data: REDACTED,
    returnvalue: REDACTED,
    opts: {
      attempts: job.opts.attempts,
      delay: job.opts.delay,
      priority: job.opts.priority,
    },
  };
}
