// Part 45: maintenance module barrel.

export { MaintenanceModule } from "./maintenance.module";
export {
  STORAGE_MAINTENANCE_AUDIT_ACTION,
  STORAGE_MAINTENANCE_AUDIT_ENTITY_TYPE,
  STORAGE_MAINTENANCE_NOTES,
} from "./maintenance.constants";
export { StorageMaintenanceScheduler } from "./storage-maintenance.scheduler";
export {
  StorageMaintenanceService,
  type MaintenanceScope,
  type RunWorkspaceMaintenanceInput,
} from "./storage-maintenance.service";
export {
  decideAbandonedUpload,
  decideExportSweep,
  decideOrphanObject,
  deletedNoteRetentionDays,
  shouldMarkMissingObject,
  shouldPurgeDeletedNote,
  SWEEP_SAMPLE_LIMIT,
  SweepAccumulator,
  type AbandonedUploadCandidate,
  type AttachmentLifecycleStatus,
  type DeletedNoteCandidate,
  type DeletedNoteRetentionWindows,
  type ExportCandidate,
  type ExportLifecycleStatus,
  type ExportSweepAction,
  type MissingObjectCandidate,
  type ObjectOwnerFacts,
  type OrphanObjectCandidate,
  type SweepWindows,
} from "./storage-maintenance.selection";
