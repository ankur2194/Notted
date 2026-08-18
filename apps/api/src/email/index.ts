export { EmailModule } from "./email.module";
export { EmailRendererService } from "./email-renderer.service";
export {
  WorkspaceEmailProducerService,
  workspaceEmailIdempotencyKey,
  WORKSPACE_EMAIL_IDEMPOTENCY_PREFIX,
  type QueueWorkspaceEmailInput,
  type QueueWorkspaceEmailResult,
} from "./workspace-email-producer.service";
export {
  isSuppressed,
  normalizeRecipient,
  SUPPRESSIBLE_TEMPLATE_KEYS,
  UNSUBSCRIBE_RELATED_ENTITY_TYPE,
} from "./email-suppression";
export {
  resolveBranding,
  DEFAULT_ACCENT_COLOR,
  PLATFORM_BRANDING_NAME,
  type BrandingWorkspaceRow,
  type EmailBranding,
} from "./email-branding";
export {
  isEmailTemplateKey,
  EMAIL_TEMPLATE_KEYS,
  type EmailMessage,
  type EmailTemplateKey,
  type EmailTemplateProps,
} from "./email-templates";
