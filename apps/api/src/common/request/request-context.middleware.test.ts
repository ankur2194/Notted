import { describe, expect, it } from "vitest";

import { selectRequestId } from "./request-context.middleware";

describe("selectRequestId", () => {
  it("accepts only bounded version-4 UUID request IDs", () => {
    const incoming = "9BB58C7E-8F49-4A7D-B60C-0E32A30A2980";

    expect(selectRequestId(incoming, () => "generated")).toBe(incoming.toLowerCase());
    expect(selectRequestId("not-safe", () => "generated")).toBe("generated");
    expect(selectRequestId("a".repeat(100), () => "generated")).toBe("generated");
  });
});
