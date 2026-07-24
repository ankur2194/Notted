import { Global, Module } from "@nestjs/common";

import { APP_CONFIG, AppConfigProvider, appConfigProvider } from "./app.config";

@Global()
@Module({
  providers: [AppConfigProvider, appConfigProvider],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
