import { Injectable, type Provider } from "@nestjs/common";

import { type Environment, readBoolean, wrapConfigError } from "./environment-readers";

export const FEATURES_CONFIG = Symbol("FEATURES_CONFIG");

export interface FeaturesConfig {
  readonly redisEnabled: boolean;
  readonly storageEnabled: boolean;
  readonly searchEnabled: boolean;
  readonly emailEnabled: boolean;
  readonly aiEnabled: boolean;
  readonly registrationEnabled: boolean;
  readonly realtimeEnabled: boolean;
  readonly collaborationEnabled: boolean;
}

export function parseFeaturesConfig(environment: Environment): FeaturesConfig {
  try {
    const redisEnabled = readBoolean(environment, "FEATURE_REDIS_ENABLED", true);
    const realtimeEnabled = readBoolean(environment, "FEATURE_REALTIME_ENABLED", true);
    if (realtimeEnabled && !redisEnabled) {
      throw new Error("FEATURE_REALTIME_ENABLED=true requires FEATURE_REDIS_ENABLED=true");
    }
    // Part 58: collaborative editing is carried entirely by the authenticated
    // Socket.io transport, so enabling it without realtime would advertise a
    // capability with no way to deliver an update.
    //
    // THE DEFAULT FOLLOWS REALTIME rather than being a second independent
    // `true`. A deployment (or a test harness) that turns realtime off has
    // already said it wants no socket transport; making it name a second key it
    // has never heard of just to keep booting turns a new flag into a breaking
    // change for every existing environment file. An EXPLICIT
    // `FEATURE_COLLABORATION_ENABLED=true` against `FEATURE_REALTIME_ENABLED=false`
    // is still a hard error below — the derived default only removes the
    // surprise, never the contradiction.
    const collaborationEnabled = readBoolean(
      environment,
      "FEATURE_COLLABORATION_ENABLED",
      realtimeEnabled,
    );
    if (collaborationEnabled && !realtimeEnabled) {
      throw new Error("FEATURE_COLLABORATION_ENABLED=true requires FEATURE_REALTIME_ENABLED=true");
    }
    return Object.freeze({
      redisEnabled,
      storageEnabled: readBoolean(environment, "FEATURE_STORAGE_ENABLED", true),
      searchEnabled: readBoolean(environment, "FEATURE_SEARCH_ENABLED", true),
      emailEnabled: readBoolean(environment, "FEATURE_EMAIL_ENABLED", true),
      aiEnabled: readBoolean(environment, "FEATURE_AI_ENABLED", false),
      registrationEnabled: readBoolean(environment, "FEATURE_REGISTRATION_ENABLED", true),
      realtimeEnabled,
      collaborationEnabled,
    });
  } catch (error: unknown) {
    wrapConfigError("Invalid feature configuration", error);
  }
}

@Injectable()
export class FeaturesConfigProvider {
  readonly value = parseFeaturesConfig(process.env);
}

export const featuresConfigProvider: Provider<FeaturesConfig> = {
  provide: FEATURES_CONFIG,
  inject: [FeaturesConfigProvider],
  useFactory: (provider: FeaturesConfigProvider): FeaturesConfig => provider.value,
};
