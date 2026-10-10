import type { LayerPlan } from "../engine/types";

export interface PRRef {
  owner: string;
  repo: string;
  number: number;
}

export interface PRMeta {
  title: string;
  headSha: string;
  baseSha: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  htmlUrl: string;
  state: string;
}

export interface AnalyzeResult {
  pr: PRRef;
  meta: PRMeta;
  plan: LayerPlan;
  fromCache: boolean;
  rate?: { remaining: number; limit: number; reset: number };
}

export type Request =
  | { type: "auth:status" }
  | { type: "auth:validate"; token: string; testRepo?: string }
  | { type: "auth:save"; token: string; testRepo?: string; attested: boolean }
  | { type: "auth:clear" }
  | { type: "openOnboarding" }
  | { type: "analyze"; pr: PRRef; force?: boolean }
  | { type: "openPanel" }
  | { type: "cache:clear" };

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export interface AuthStatus {
  method: "pat" | "none";
  login?: string;
  tokenHint?: string;
  savedAt?: string;
}

export interface RepoCheck {
  repo: string;
  ok: boolean;
  lines: { label: string; ok: boolean; detail: string }[];
}

export interface TokenValidationResponse {
  result: import("./token-validation").ValidationResult;
  repoCheck?: RepoCheck;
  saved?: boolean;
}

/** Messages pushed from the service worker / content script to the panel. */
export type Broadcast = { type: "progress"; pr: PRRef; text: string } | { type: "pr:changed"; pr: PRRef | null; url: string };

/** Messages from the panel to the content script in the GitHub tab. */
export type TabMessage = { type: "jump"; path: string } | { type: "whereAmI" };

export function send<T>(req: Request): Promise<T> {
  return chrome.runtime.sendMessage(req).then((res: Response<T> | undefined) => {
    if (!res) throw new Error("No response from background worker");
    if (!res.ok) throw Object.assign(new Error(res.error), { code: res.code });
    return res.data;
  });
}
