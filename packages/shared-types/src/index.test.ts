import { describe, expect, it } from "vitest";

import { APP_NAME } from "./index";

describe("@notted/shared-types", () => {
  it("exposes the Notted application name", () => {
    expect(APP_NAME).toBe("Notted");
  });
});
