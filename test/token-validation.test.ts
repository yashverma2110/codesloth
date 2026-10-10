import { describe, expect, it } from "vitest";
import { parseScopes, tokenCreationUrl, tokenHint, tokenKind, validateTokenFormat, validateTokenProbe, writeCapableScopes } from "../src/shared/token-validation";

// Fake tokens are assembled at runtime so no token-shaped literal is committed.
const FG = ["github", "pat", "11ABCDEFG0123456789", "FAKEfakeFAKEfakeFAKEfakeFAKEfakeFAKEfakeFAKEUVWX"].join("_");
const CLASSIC = ["ghp", "FAKEfakeFAKEfakeFAKEfakeFAKEfakeFAKE"].join("_");
const ok200 = { status: 200, oauthScopes: null, sso: null, expiration: null, login: "yash" };

describe("token kind", () => {
  it.each([
    [FG, "fine-grained"],
    [CLASSIC, "classic"],
    ["0123456789abcdef0123456789abcdef01234567", "classic"],
    ["gho_abc", "oauth"],
    ["ghu_abc", "app-user"],
    ["ghs_abc", "app-installation"],
    ["ghr_abc", "refresh"],
    ["hello", "unknown"],
  ])("%s -> %s", (t, k) => expect(tokenKind(t)).toBe(k));
});

describe("format validation", () => {
  it("accepts fine-grained tokens", () => expect(validateTokenFormat(FG).ok).toBe(true));
  it("rejects classic tokens outright with a fix", () => {
    const r = validateTokenFormat(CLASSIC);
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe("classic_token");
    expect(r.errors[0].fix).toMatch(/fine-grained/);
  });
  it("rejects OAuth/App tokens, empty and whitespace", () => {
    expect(validateTokenFormat("gho_x").errors[0].code).toBe("not_a_pat");
    expect(validateTokenFormat("").errors[0].code).toBe("empty");
    expect(validateTokenFormat("github_pat_a b").errors[0].code).toBe("whitespace");
    expect(validateTokenFormat("abc").errors[0].code).toBe("unknown_format");
  });
});

describe("scope analysis (classic/OAuth X-OAuth-Scopes)", () => {
  it("parses the header", () => expect(parseScopes("repo, read:org ,workflow")).toEqual(["repo", "read:org", "workflow"]));
  it("flags write-capable scopes and allows read-only ones", () => {
    expect(writeCapableScopes("repo, public_repo, workflow, write:packages, admin:org, delete_repo, gist, user, read:org, read:user, user:email")).toEqual([
      "repo", "public_repo", "workflow", "write:packages", "admin:org", "delete_repo", "gist", "user",
    ]);
    expect(writeCapableScopes("read:org, read:user")).toEqual([]);
    expect(writeCapableScopes("")).toEqual([]);
    expect(writeCapableScopes(null)).toEqual([]);
  });
});

describe("probe validation", () => {
  it("accepts a working fine-grained token with no scopes header", () => {
    const r = validateTokenProbe(FG, { ...ok200, expiration: "2027-01-08 10:00:00 UTC" }, Date.parse("2026-10-10T00:00:00Z"));
    expect(r.ok).toBe(true);
    expect(r.checks.join(" ")).toMatch(/@yash/);
    expect(r.checks.join(" ")).toMatch(/2027-01-08/);
  });
  it("warns when no expiry is reported", () => {
    expect(validateTokenProbe(FG, ok200).warnings.join(" ")).toMatch(/expiry/);
  });
  it("rejects any token reporting write scopes, even if the prefix looks fine-grained", () => {
    const r = validateTokenProbe(FG, { ...ok200, oauthScopes: "repo, read:org" });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain("write_scopes");
    expect(r.errors.find((e) => e.code === "write_scopes")!.message).toContain("repo");
  });
  it("rejects a fine-grained-looking token that reports an (empty) scopes header", () => {
    expect(validateTokenProbe(FG, { ...ok200, oauthScopes: "" }).errors.map((e) => e.code)).toContain("unexpected_scopes_header");
  });
  it("rejects classic tokens even with read-only scopes", () => {
    const r = validateTokenProbe(CLASSIC, { ...ok200, oauthScopes: "read:org" });
    expect(r.errors.map((e) => e.code)).toEqual(["classic_token"]);
  });
  it("explains 401 and SSO failures", () => {
    expect(validateTokenProbe(FG, { ...ok200, status: 401, login: undefined }).errors[0].code).toBe("unauthorized");
    const sso = validateTokenProbe(FG, { ...ok200, status: 403, sso: "required; url=https://github.com/orgs/x/sso?authorization_request=1" });
    expect(sso.errors[0].code).toBe("sso_required");
    expect(sso.errors[0].fix).toMatch(/SSO/);
  });
});

describe("token creation URL", () => {
  it("uses only documented prefill params with read-only permissions", () => {
    const u = new URL(tokenCreationUrl({ owner: "wayground", expiresInDays: 90 }));
    expect(u.origin + u.pathname).toBe("https://github.com/settings/personal-access-tokens/new");
    expect(u.searchParams.get("target_name")).toBe("wayground");
    expect(u.searchParams.get("expires_in")).toBe("90");
    expect(u.searchParams.get("pull_requests")).toBe("read");
    expect(u.searchParams.get("contents")).toBe("read");
    expect(u.searchParams.get("name")!.length).toBeLessThanOrEqual(40);
    expect([...u.searchParams.values()]).not.toContain("write");
  });
  it("omits target_name when no owner", () => expect(new URL(tokenCreationUrl()).searchParams.has("target_name")).toBe(false));
  it("masks tokens", () => expect(tokenHint(FG)).toBe("github_pat_11AB…UVWX"));
});
