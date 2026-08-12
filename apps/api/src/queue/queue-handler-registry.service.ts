import { Injectable } from "@nestjs/common";

import { registeredJobDefinition } from "./job-registry";

import type {
  AnyOutboxJobDefinition,
  QueueJobHandler,
  QueueJobRegistration,
} from "./job-contracts";
import type { DomainJobType } from "./job-identifiers";
import type { PhysicalQueueName } from "./queue-names";

export interface RegisteredQueueHandler {
  readonly definition: AnyOutboxJobDefinition;
  readonly handler: QueueJobHandler<DomainJobType, unknown>;
}

/**
 * Runtime registration gate. Definitions alone never enable dispatch; a module
 * must explicitly register its concrete handler during startup.
 */
@Injectable()
export class QueueHandlerRegistry {
  private readonly handlers = new Map<DomainJobType, RegisteredQueueHandler>();

  register<TDefinition extends AnyOutboxJobDefinition>(
    registration: QueueJobRegistration<TDefinition>,
  ): () => void {
    const canonical = registeredJobDefinition(registration.definition.jobType);
    if (
      canonical === undefined ||
      canonical.payloadVersion !== registration.definition.payloadVersion ||
      canonical.route.physicalQueueName !== registration.definition.route.physicalQueueName
    ) {
      throw new Error("Queue handler registration does not match the canonical definition");
    }
    if (this.handlers.has(canonical.jobType)) {
      throw new Error(`Queue handler already registered for ${canonical.jobType}`);
    }

    // The generic relationship was checked above and remains encapsulated at
    // this one type-erasure boundary; callers retain their precise payload type.
    const binding: RegisteredQueueHandler = {
      definition: canonical,
      handler: registration.handler as QueueJobHandler<DomainJobType, unknown>,
    };
    this.handlers.set(canonical.jobType, binding);
    return () => {
      if (this.handlers.get(canonical.jobType) === binding) {
        this.handlers.delete(canonical.jobType);
      }
    };
  }

  lookup(jobType: string): RegisteredQueueHandler | undefined {
    const definition = registeredJobDefinition(jobType);
    return definition === undefined ? undefined : this.handlers.get(definition.jobType);
  }

  activePhysicalQueues(): readonly PhysicalQueueName[] {
    return [
      ...new Set(
        [...this.handlers.values()].map(({ definition }) => definition.route.physicalQueueName),
      ),
    ];
  }
}
