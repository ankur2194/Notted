import { Global, Module } from "@nestjs/common";

import { APP_CONFIG, AppConfigProvider, appConfigProvider } from "./app.config";
import { DATABASE_CONFIG, DatabaseConfigProvider, databaseConfigProvider } from "./database.config";

@Global()
@Module({
  providers: [AppConfigProvider, appConfigProvider, DatabaseConfigProvider, databaseConfigProvider],
  exports: [APP_CONFIG, DATABASE_CONFIG],
})
export class ConfigModule {}
