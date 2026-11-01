// Mirrors the server's password rules (server/src/security.ts) so people see them met as they type.
// The server still checks everything; this is for guidance only.

export const MIN_PASSWORD_LENGTH = 12;

export function passwordRules(password: string, confirm: string, email: string) {
  const local = (email.split('@')[0] ?? '').toLowerCase();
  const lower = password.toLowerCase();
  const checksName = local.length >= 4;
  return {
    longEnough: password.length >= MIN_PASSWORD_LENGTH,
    avoidsEmail: password.length > 0 && lower !== email.toLowerCase() && !(checksName && lower.includes(local)),
    matches: password.length > 0 && password === confirm,
    /** Wording for the email rule, depending on whether the name part is checked. */
    emailRuleText: checksName ? `Doesn't contain "${local}" (your email name)` : "Isn't your email address",
  };
}
