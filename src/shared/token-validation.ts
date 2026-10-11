/**
 * Token validation. Pure functions so they can be unit tested.
 *
 * What GitHub exposes (see README "Token validation: what can and can't be detected"):
 *  - Token type is visible from the prefix: ghp_ (classic PAT), github_pat_ (fine-grained PAT),
 *    gho_ (OAuth app), ghu_ (GitHub App user-to-server), ghs_ (App installation), ghr_ (refresh).
 *  - Classic PATs / OAuth tokens report their scopes in the X-OAuth-Scopes response header.
 *  - Fine-grained PATs do NOT expose their granted permissions via any header or endpoint callable
 *    with the token itself. X-Accepted-GitHub-Permissions only says what an endpoint *requires*.
 *    The repo `permissions` field is the *user's* role, not the token's, so we never use it.
 *  - We never send a non-GET request to probe for write access.
 */

export type TokenKind = "fine-grained" | "classic" | "oauth" | "app-user" | "app-installation" | "refresh" | "unknown";

export function tokenKind(token: string): TokenKind {
  const t = token.trim();
  if (t.startsWith("github_pat_")) return "fine-grained";
  if (t.startsWith("ghp_")) return "classic";
  if (t.startsWith("gho_")) return "oauth";
  if (t.startsWith("ghu_")) return "app-user";
  if (t.startsWith("ghs_")) return "app-installation";
  if (t.startsWith("ghr_")) return "refresh";
  // Pre-2021 classic tokens were 40 hex chars.
  if (/^[0-9a-f]{40}$/i.test(t)) return "classic";
  return "unknown";
}

/**
 * OAuth/classic scopes that are read-only. Anything else is treated as write-capable.
 * Source: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
 */
const READ_ONLY_SCOPES = new Set([
  "read:org",
  "read:user",
  "user:email",
  "read:public_key",
  "read:repo_hook",
  "read:gpg_key",
  "read:ssh_signing_key",
  "read:packages",
  "read:project",
  "read:audit_log",
  "read:enterprise",
  "read:discussion",
]);

export function parseScopes(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Scopes in an X-OAuth-Scopes header that can write (repo, public_repo, workflow, write:*, admin:*, delete_repo, gist, user, ...). */
export function writeCapableScopes(header: string | null | undefined): string[] {
  return parseScopes(header).filter((s) => !READ_ONLY_SCOPES.has(s));
}

export interface TokenProbe {
  /** HTTP status of GET /user with the token. */
  status: number;
  /** Raw X-OAuth-Scopes header (null when absent, which is the case for fine-grained PATs). */
  oauthScopes: string | null;
  /** X-GitHub-SSO header, if any. */
  sso: string | null;
  /** GitHub-Authentication-Token-Expiration header, if any (observed on PAT responses; not relied on). */
  expiration: string | null;
  login?: string;
}

export type ValidationCode =
  | "empty"
  | "whitespace"
  | "classic_token"
  | "not_a_pat"
  | "unknown_format"
  | "write_scopes"
  | "unexpected_scopes_header"
  | "unauthorized"
  | "sso_required"
  | "http_error"
  | "not_attested";

export interface ValidationIssue {
  code: ValidationCode;
  message: string;
  fix: string;
}

export interface ValidationResult {
  ok: boolean;
  kind: TokenKind;
  errors: ValidationIssue[];
  warnings: string[];
  /** Things we verified, for display. */
  checks: string[];
}

const CREATE_FIX = "Create a fine-grained token with only Pull requests: Read-only and Contents: Read-only (use the button above), then paste it here.";

/** Format-only checks that need no network. */
export function validateTokenFormat(token: string): ValidationResult {
  const errors: ValidationIssue[] = [];
  const checks: string[] = [];
  const kind = tokenKind(token);
  if (!token.trim()) {
    errors.push({ code: "empty", message: "No token entered.", fix: CREATE_FIX });
  } else if (/\s/.test(token.trim())) {
    errors.push({ code: "whitespace", message: "The token contains spaces or line breaks.", fix: "Copy the token again from GitHub and paste only the token." });
  } else if (kind === "classic") {
    errors.push({
      code: "classic_token",
      message: "This is a classic personal access token (ghp_…). Classic tokens can't be limited to read-only pull request access, so CodeSloth doesn't accept them.",
      fix: CREATE_FIX + " You can delete the classic token afterwards.",
    });
  } else if (kind === "oauth" || kind === "app-user" || kind === "app-installation" || kind === "refresh") {
    errors.push({
      code: "not_a_pat",
      message: `This looks like a ${kind.replace("-", " ")} token, not a fine-grained personal access token.`,
      fix: CREATE_FIX,
    });
  } else if (kind === "unknown") {
    errors.push({ code: "unknown_format", message: "This doesn't look like a GitHub fine-grained token (they start with github_pat_).", fix: CREATE_FIX });
  } else {
    checks.push("Token is a fine-grained personal access token (github_pat_…).");
  }
  return { ok: errors.length === 0, kind, errors, warnings: [], checks };
}

/** Combine format checks with the result of a read-only GET /user probe. */
export function validateTokenProbe(token: string, probe: TokenProbe, now = Date.now()): ValidationResult {
  const r = validateTokenFormat(token);
  const errors = [...r.errors];
  const warnings = [...r.warnings];
  const checks = [...r.checks];

  if (probe.status === 401) {
    errors.push({ code: "unauthorized", message: "GitHub rejected the token (401): it is invalid, expired or revoked.", fix: CREATE_FIX });
  } else if (probe.status === 403 && probe.sso) {
    errors.push({
      code: "sso_required",
      message: "Your organization requires SAML single sign-on for this token.",
      fix: "Sign in to the organization through SSO in this browser (open the org on github.com), then create the fine-grained token again with the organization as Resource owner. Fine-grained tokens are SSO-authorized at creation time.",
    });
  } else if (probe.status !== 200) {
    errors.push({ code: "http_error", message: `GitHub returned HTTP ${probe.status} for GET /user.`, fix: "Check your network and try again." });
  } else if (probe.login) {
    checks.push(`Token works and belongs to @${probe.login}.`);
  }

  // A scopes header means the token is scope-based (classic/OAuth) regardless of its prefix.
  if (probe.oauthScopes !== null && probe.oauthScopes !== undefined) {
    const write = writeCapableScopes(probe.oauthScopes);
    if (write.length) {
      errors.push({
        code: "write_scopes",
        message: `The token has write-capable scopes: ${write.join(", ")}.`,
        fix: CREATE_FIX,
      });
    } else if (r.kind === "fine-grained") {
      errors.push({
        code: "unexpected_scopes_header",
        message: "GitHub reported OAuth scopes for this token, which fine-grained tokens don't have.",
        fix: CREATE_FIX,
      });
    }
  } else if (probe.status === 200) {
    checks.push("No OAuth scopes reported (expected for fine-grained tokens).");
  }

  if (probe.expiration) {
    const t = Date.parse(probe.expiration.replace(" UTC", "Z").replace(" ", "T"));
    if (!Number.isNaN(t)) {
      const days = Math.round((t - now) / 86_400_000);
      checks.push(`Token expires ${new Date(t).toISOString().slice(0, 10)} (in ${days} days).`);
      if (days > 366) warnings.push("Token expires in more than a year; consider a shorter expiry.");
    }
  } else if (probe.status === 200 && r.kind === "fine-grained") {
    warnings.push("GitHub didn't report an expiry for this token. If you chose 'No expiration', consider regenerating it with an expiry.");
  }

  return { ok: errors.length === 0, kind: r.kind, errors, warnings, checks };
}

/** Pre-filled fine-grained token creation URL (documented query params: name, description, target_name, expires_in, <permission>=<level>). */
export function tokenCreationUrl(opts: { owner?: string; expiresInDays?: number } = {}): string {
  const p = new URLSearchParams();
  p.set("name", "CodeSloth (read-only)");
  p.set("description", "Read-only token for the CodeSloth Chrome extension: reads pull request files and file contents. Never used to write.");
  if (opts.owner?.trim()) p.set("target_name", opts.owner.trim());
  p.set("expires_in", String(opts.expiresInDays ?? 90));
  p.set("pull_requests", "read");
  p.set("contents", "read");
  return `https://github.com/settings/personal-access-tokens/new?${p.toString()}`;
}

/** Mask a token for display: github_pat_11AB…wxyz */
export function tokenHint(token: string): string {
  const t = token.trim();
  if (t.length < 16) return "…";
  const pre = t.startsWith("github_pat_") ? 15 : 6;
  return `${t.slice(0, pre)}…${t.slice(-4)}`;
}
