/**
 * Auth = a fine-grained personal access token pasted by the user, stored in chrome.storage.local.
 * No GitHub App / OAuth App is used (decision: no app registration). The token never leaves the
 * browser except as the Authorization header on GET requests to api.github.com.
 */
import { tokenHint, validateTokenProbe, type ValidationResult } from "../shared/token-validation";
import type { AuthStatus, RepoCheck } from "../shared/messages";
import { GitHubClient } from "./github";

const KEY = "auth.pat";

interface StoredPat {
  token: string;
  login?: string;
  savedAt: string;
}

export async function getToken(): Promise<string | null> {
  const v = (await chrome.storage.local.get(KEY))[KEY] as StoredPat | undefined;
  return v?.token ?? null;
}

export async function getStatus(): Promise<AuthStatus> {
  const v = (await chrome.storage.local.get(KEY))[KEY] as StoredPat | undefined;
  if (!v) return { method: "none" };
  return { method: "pat", login: v.login, tokenHint: tokenHint(v.token), savedAt: v.savedAt };
}

export async function clearToken(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}

/** Validate a candidate token with read-only GETs only. */
export async function validateToken(token: string, testRepo?: string): Promise<{ result: ValidationResult; repoCheck?: RepoCheck }> {
  const t = token.trim();
  const client = new GitHubClient(async () => t);
  const user = await client.probe("/user", t);
  const result = validateTokenProbe(t, {
    status: user.status,
    oauthScopes: user.headers.get("x-oauth-scopes"),
    sso: user.headers.get("x-github-sso"),
    expiration: user.headers.get("github-authentication-token-expiration"),
    login: user.json?.login,
  });
  let repoCheck: RepoCheck | undefined;
  const m = /^\s*([\w.-]+)\/([\w.-]+)\s*$/.exec(testRepo ?? "");
  if (result.ok && m) {
    const [, owner, repo] = m;
    const lines: RepoCheck["lines"] = [];
    const meta = await client.probe(`/repos/${owner}/${repo}`, t);
    const isPrivate = meta.json?.private === true;
    lines.push({
      label: "Repository visible",
      ok: meta.status === 200,
      detail: meta.status === 200 ? `${owner}/${repo} (${isPrivate ? "private" : "public"})` : explain(meta.status, meta.headers),
    });
    if (meta.status === 200) {
      const pulls = await client.probe(`/repos/${owner}/${repo}/pulls?per_page=1&state=all`, t);
      lines.push({ label: "Pull requests: read", ok: pulls.status === 200, detail: pulls.status === 200 ? "OK" : explain(pulls.status, pulls.headers) });
      const contents = await client.probe(`/repos/${owner}/${repo}/contents/?ref=${encodeURIComponent(meta.json?.default_branch ?? "HEAD")}`, t);
      lines.push({ label: "Contents: read", ok: contents.status === 200, detail: contents.status === 200 ? "OK" : explain(contents.status, contents.headers) });
      if (!isPrivate) lines.push({ label: "Note", ok: true, detail: "This repo is public, so reads succeed even without permissions. Test with a private repo to confirm the token's grants." });
    }
    repoCheck = { repo: `${owner}/${repo}`, ok: lines.every((l) => l.ok), lines };
  }
  return { result, repoCheck };
}

function explain(status: number, h: Headers): string {
  const need = h.get("x-accepted-github-permissions");
  if (status === 404) return `404: the token can't see this repository. Add it under "Repository access"${need ? ` (needs ${need})` : ""}.`;
  if (status === 403 && h.get("x-github-sso")) return "403: SAML SSO authorization required for this organization.";
  if (status === 403) return `403: missing permission${need ? ` (endpoint needs ${need})` : ""}. If your org requires approval, the token may still be pending.`;
  return `HTTP ${status}`;
}

export async function saveToken(token: string, testRepo: string | undefined, attested: boolean) {
  const v = await validateToken(token, testRepo);
  if (!attested) {
    v.result.ok = false;
    v.result.errors.push({
      code: "not_attested",
      message: "Please confirm the token only has Pull requests: Read-only and Contents: Read-only.",
      fix: "GitHub can't tell us a fine-grained token's permissions, so we ask you to confirm. Tick the checkbox.",
    });
  }
  if (!v.result.ok) return { ...v, saved: false };
  const login = v.result.checks.map((c) => /@([\w-]+)/.exec(c)?.[1]).find(Boolean);
  await chrome.storage.local.set({ [KEY]: { token: token.trim(), login, savedAt: new Date().toISOString() } satisfies StoredPat });
  return { ...v, saved: true };
}
