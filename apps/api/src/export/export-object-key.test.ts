import { describe, expect, it } from "vitest";

import { exportDownloadFilename, exportObjectKey } from "./export-object-key";

const workspaceId = "30000000-0000-4000-8100-000000000001";
const exportId = "30000000-0000-4000-8200-000000000002";

describe("exportObjectKey", () => {
  it("is deterministic, so a retried generation overwrites instead of orphaning bytes", () => {
    expect(exportObjectKey(workspaceId, exportId, "txt")).toBe(
      exportObjectKey(workspaceId, exportId, "txt"),
    );
  });

  it("partitions by workspace so the maintenance sweep can list one tenant", () => {
    const key = exportObjectKey(workspaceId, exportId, "txt");
    expect(key.startsWith(`${workspaceId}/`)).toBe(true);
    expect(key).toBe(`${workspaceId}/${exportId}.txt`);
    // A different workspace can never address the same object.
    expect(exportObjectKey("30000000-0000-4000-8100-000000000009", exportId, "txt")).not.toBe(key);
  });
});

describe("exportDownloadFilename", () => {
  it("strips path separators out of a hostile title", () => {
    const filename = exportDownloadFilename("../../etc/passwd", "txt");
    expect(filename).not.toContain("/");
    expect(filename).not.toContain("..");
    expect(filename).toBe("etcpasswd.txt");
  });

  it("drops quotes and control characters that would break Content-Disposition", () => {
    expect(exportDownloadFilename('a"b;c\r\nd', "txt")).toBe("abc-d.txt");
  });

  it("collapses whitespace and keeps the extension", () => {
    expect(exportDownloadFilename("  Quarterly   plan  ", "txt")).toBe("Quarterly-plan.txt");
  });

  it("falls back to a generic name when nothing survives sanitisation", () => {
    expect(exportDownloadFilename("日本語 ✅", "txt")).toBe("export.txt");
    expect(exportDownloadFilename("", "txt")).toBe("export.txt");
    expect(exportDownloadFilename("...", "txt")).toBe("export.txt");
  });

  it("caps the stem so a pathological title cannot produce a header of any length", () => {
    const filename = exportDownloadFilename("a".repeat(500), "txt");
    expect(filename).toBe(`${"a".repeat(80)}.txt`);
  });
});
