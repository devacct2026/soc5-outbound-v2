// Account registration policy (SEA-7). The OAuth exchange itself is blocked on
// the unverified SeaTalk contract; this is the decision rule applied to a
// verified identity once that integration exists.
export interface RegistrationInput {
  email: string;
  /** Verified by the provider (SeaTalk org membership), never client supplied. */
  organizationMember: boolean;
  oauthIdentityVerified: boolean;
}

export type RegistrationDecision =
  | { allow: true; accountStatus: "PENDING_APPROVAL"; role: null }
  | { allow: false; reason: "IDENTITY_UNVERIFIED" | "NOT_ORG_MEMBER" | "DOMAIN_NOT_ALLOWED" | "INVALID_EMAIL" };

/**
 * Registered accounts are ALWAYS PENDING_APPROVAL with no role: operational
 * access requires an administrator to approve and assign a role explicitly.
 */
export function evaluateRegistration(input: RegistrationInput, allowedDomains: string[]): RegistrationDecision {
  const m = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(input.email.trim().toLowerCase());
  if (!m) return { allow: false, reason: "INVALID_EMAIL" };
  if (!input.oauthIdentityVerified) return { allow: false, reason: "IDENTITY_UNVERIFIED" };
  if (!input.organizationMember) return { allow: false, reason: "NOT_ORG_MEMBER" };
  const domains = allowedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  // An empty allow-list denies everyone: eligibility must be configured and approved.
  if (!domains.includes(m[1])) return { allow: false, reason: "DOMAIN_NOT_ALLOWED" };
  return { allow: true, accountStatus: "PENDING_APPROVAL", role: null };
}
