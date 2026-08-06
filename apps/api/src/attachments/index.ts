export {
  ATTACHMENT_AUDIT_ACTIONS,
  ATTACHMENT_AUDIT_ENTITY_TYPE,
  ATTACHMENT_DOMAIN_EVENT_IDEMPOTENCY_PREFIX,
  ATTACHMENT_DOMAIN_EVENT_PAYLOAD_VERSION,
  ATTACHMENT_DOMAIN_EVENT_QUEUE,
  ATTACHMENT_DOMAIN_EVENTS,
  ATTACHMENT_PROCESSING_ERRORS,
  ATTACHMENT_UPLOAD_FILE_FIELD,
  ATTACHMENT_VARIANT_FALLBACKS,
} from "./attachments.constants";
export {
  ATTACHMENT_OBJECT_EXTENSIONS,
  ATTACHMENT_OBJECT_KEY_PATTERN,
  ATTACHMENT_VARIANT_NAMES,
  attachmentObjectExtension,
  buildAttachmentObjectKey,
  parseAttachmentObjectKey,
} from "./attachment-storage-key";
export { AttachmentsController, NoteAttachmentsController } from "./attachments.controller";
export { AttachmentsModule } from "./attachments.module";
export { AttachmentsService } from "./attachments.service";
export { canonicalDisplayExtension, sanitizeAttachmentFilename } from "./filename";
export {
  decodeHeicToJpeg,
  isHeicDecoderAvailable,
  resetHeicConverter,
  setHeicConverter,
  type HeicConverter,
} from "./heic-decoder";
export {
  IMAGE_PROCESSOR,
  ImageProcessingError,
  PassthroughImageProcessor,
  type ImageProcessor,
  type ProcessedImage,
} from "./image-processing";
export { ImageProcessingService } from "./image-processing.service";
export {
  IMAGE_SIGNATURE_HEAD_BYTES,
  SNIFFED_IMAGE_TYPES,
  sniffImageMediaType,
  type SniffedImageType,
} from "./image-signature";
export {
  BLUR_WIDTH_PX,
  FULL_LONGEST_EDGE_PX,
  MAX_BLUR_DATA_URI_BYTES,
  MEDIUM_WIDTH_PX,
  THUMBNAIL_WIDTH_PX,
  boundLongestEdge,
  fitInside,
  type Dimensions,
} from "./image-variants";
export { parseSingleFileUpload } from "./multipart-upload.parser";
export { scanSvgSource, type SvgRejectionReason, type SvgScanResult } from "./svg-safety";
