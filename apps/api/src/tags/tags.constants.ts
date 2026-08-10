export const TAG_AUDIT_ENTITY_TYPE = "tag" as const;
export const TAG_DOMAIN_EVENT_QUEUE = "tag-domain-events" as const;
export const TAG_DOMAIN_EVENT_PAYLOAD_VERSION = 1 as const;
export const TAG_DOMAIN_EVENT_IDEMPOTENCY_PREFIX = "tag-domain:" as const;

export const TAG_DOMAIN_EVENTS = Object.freeze({
  create: "tag.created",
  update: "tag.updated",
  delete: "tag.deleted",
} as const);

export type TagMutation = keyof typeof TAG_DOMAIN_EVENTS;

/**
 * Tags are a flat workspace-wide vocabulary, not user content: past a couple of
 * hundred the picker stops being usable and the label set stops being a
 * taxonomy. The cap is enforced in the create transaction, not by a constraint.
 */
export const TAG_MAX_PER_WORKSPACE = 200;

/** Backs the `(workspace_id, name)` unique index in `database/schema/tags.ts`. */
export const TAG_NAME_UNIQUE_CONSTRAINT = "tags_workspace_name_unique" as const;
