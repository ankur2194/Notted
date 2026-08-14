import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_MIN_INTERVAL_MS,
  decideCollaborativeCheckpoint,
  isCheckpointEligibleMutation,
  NON_COLLABORATIVE_CHECKPOINT_MUTATIONS,
} from "./note-version-checkpoint.policy";

const NOW = new Date("2026-08-13T12:00:00.000Z");

describe("note-version-checkpoint.policy non-misleading-snapshot rule", () => {
  it("snapshots only create/copy/update synchronous mutations", () => {
    // The eligibility rule is the single home of "do not fabricate history for
    // structural mutations". Every kind that bumps notes.version WITHOUT a
    // recoverable title/content/plain change must be absent here, or a move/
    // trash/folder op would create a misleading repetitive history entry.
    expect(isCheckpointEligibleMutation("create")).toBe(true);
    expect(isCheckpointEligibleMutation("copy")).toBe(true);
    expect(isCheckpointEligibleMutation("update")).toBe(true);
    // Structural mutations bump notes.version but are deliberately excluded.
    expect(isCheckpointEligibleMutation("move")).toBe(false);
    expect(isCheckpointEligibleMutation("delete")).toBe(false);
    expect(isCheckpointEligibleMutation("restore")).toBe(false);
    expect(isCheckpointEligibleMutation("permanentDelete")).toBe(false);
    expect(isCheckpointEligibleMutation("folderCreate")).toBe(false);
    expect(isCheckpointEligibleMutation("folderUpdate")).toBe(false);
    expect(isCheckpointEligibleMutation("folderDelete")).toBe(false);
  });

  it("exposes the read-only mutation set so Part 58 can consume the seam", () => {
    expect(NON_COLLABORATIVE_CHECKPOINT_MUTATIONS).toBeInstanceOf(Set);
    expect([...NON_COLLABORATIVE_CHECKPOINT_MUTATIONS]).toEqual(["create", "copy", "update"]);
  });
});

describe("note-version-checkpoint.policy collaborative cadence", () => {
  it("avoids a per-keystroke snapshot inside the minimum interval", () => {
    const oneMinuteAgo = new Date(NOW.getTime() - 60 * 1_000);
    const decision = decideCollaborativeCheckpoint({
      now: NOW,
      lastDurableCheckpointAt: oneMinuteAgo,
      forcedBoundary: false,
    });
    expect(decision.checkpoint).toBe(false);
    expect(decision.reason).toBe("skip");
  });

  it("checkpoints once the minimum interval has elapsed", () => {
    const justOverInterval = new Date(NOW.getTime() - CHECKPOINT_MIN_INTERVAL_MS - 1);
    const decision = decideCollaborativeCheckpoint({
      now: NOW,
      lastDurableCheckpointAt: justOverInterval,
      forcedBoundary: false,
    });
    expect(decision.checkpoint).toBe(true);
    expect(decision.reason).toBe("cadence");
  });

  it("checkpoints exactly at the interval boundary", () => {
    const atInterval = new Date(NOW.getTime() - CHECKPOINT_MIN_INTERVAL_MS);
    const decision = decideCollaborativeCheckpoint({
      now: NOW,
      lastDurableCheckpointAt: atInterval,
      forcedBoundary: false,
    });
    expect(decision.checkpoint).toBe(true);
    expect(decision.reason).toBe("cadence");
  });

  it("always checkpoints the first collaborative persistence so a baseline exists", () => {
    const decision = decideCollaborativeCheckpoint({
      now: NOW,
      lastDurableCheckpointAt: null,
      forcedBoundary: false,
    });
    expect(decision.checkpoint).toBe(true);
    expect(decision.reason).toBe("first_checkpoint");
  });

  it("honors forced durable boundaries even inside the minimum interval", () => {
    const oneSecondAgo = new Date(NOW.getTime() - 1_000);
    const decision = decideCollaborativeCheckpoint({
      now: NOW,
      lastDurableCheckpointAt: oneSecondAgo,
      forcedBoundary: true,
    });
    expect(decision.checkpoint).toBe(true);
    expect(decision.reason).toBe("forced_boundary");
  });

  it("forces a boundary checkpoint even when no prior checkpoint exists", () => {
    const decision = decideCollaborativeCheckpoint({
      now: NOW,
      lastDurableCheckpointAt: null,
      forcedBoundary: true,
    });
    expect(decision.checkpoint).toBe(true);
    expect(decision.reason).toBe("forced_boundary");
  });

  it("is pure: identical inputs yield identical decisions", () => {
    const last = new Date(NOW.getTime() - 10 * 1_000);
    const a = decideCollaborativeCheckpoint({
      now: NOW,
      lastDurableCheckpointAt: last,
      forcedBoundary: false,
    });
    const b = decideCollaborativeCheckpoint({
      now: NOW,
      lastDurableCheckpointAt: last,
      forcedBoundary: false,
    });
    expect(a).toEqual(b);
  });
});
