import type { IsoTimestamp, UserId } from "./common";

/**
 * Safe user display fields. Credential, account, session, token, two-factor,
 * passkey and provider fields are deliberately owned by Better Auth.
 */
export interface UserSummary {
  id: UserId;
  name: string;
}

export interface UserDetail extends UserSummary {
  email: string;
  emailVerifiedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
