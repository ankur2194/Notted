import { MODULE_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";

import { SearchModule } from "./search.module";

describe("SearchModule wiring", () => {
  it("owns the auth and authorization imports required by its controller guard", () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      SearchModule,
    ) as readonly unknown[];
    expect(imports).toEqual(expect.arrayContaining([AuthModule, AuthorizationModule]));
  });

  it("is retained in the application bootstrap module", () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as readonly unknown[];
    expect(imports).toContain(SearchModule);
  });
});
