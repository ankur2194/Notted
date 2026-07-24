import type { AttachmentId, IsoTimestamp, NoteId, UserId, WorkspaceId } from "./common";

export type AttachmentStatus = "pending" | "processing" | "ready" | "failed";

/**
 * Safe attachment metadata. Object keys, bucket names, infrastructure
 * endpoints, signed URLs and binary payloads never enter this contract.
 */
export interface AttachmentSummary {
  id: AttachmentId;
  workspaceId: WorkspaceId;
  noteId: NoteId;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  status: AttachmentStatus;
  width: number | null;
  height: number | null;
  createdAt: IsoTimestamp;
}

export interface AttachmentDetail extends AttachmentSummary {
  createdById: UserId;
}
