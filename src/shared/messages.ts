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
  /** Number of commits on the PR (GitHub's count). */
  commits?: number;
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
  | { type: "widget:getPosition" }
  | { type: "widget:setPosition"; position: { side: "left" | "right"; top: number } }
  | { type: "reviewed:get"; key: string }
  | { type: "compare:get"; pr: PRRef; base: string; head: string }
  | { type: "history:get"; pr: PRRef; headSha: string; commits?: number; paths: string[] }
  | { type: "reviewed:set"; key: string; value: unknown }
  | { type: "prefs:get"; key: PrefKey }
  | { type: "prefs:set"; key: PrefKey; value: unknown }
  | { type: "graph:openTab"; pr: PRRef; headSha?: string; demo?: boolean }
  | { type: "graph:getPlan"; pr: PRRef; headSha: string }
  | { type: "graph:jump"; tabId: number; pr: PRRef; path: string }
  | { type: "analyze"; pr: PRRef; force?: boolean }
  | { type: "cache:clear" };

/** Widget preferences content scripts may read/write (nothing sensitive). */
export const PREF_KEYS = ["view", "tourDone", "syncViewed", "storyOpen", "codeFont", "fontSize", "ligatures", "diffFont"] as const;
/** Preferences kept only for the browser session (chrome.storage.session). */
export const SESSION_PREF_KEYS: readonly string[] = ["storyOpen"];
export type PrefKey = (typeof PREF_KEYS)[number];

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

/** Messages pushed from the service worker to content scripts in GitHub tabs. */
export type TabMessage =
  | { type: "progress"; pr: PRRef; text: string }
  | { type: "widget:toggle"; source: "toolbar" | "shortcut" }
  | { type: "auth:changed" }
  | { type: "jump"; path: string }
  | { type: "ping" }
  | { type: "prefs:changed" };

/**
 * Requests a content script (running on github.com) may make. Everything else (token validation,
 * saving, clearing, cache) is only accepted from the extension's own pages.
 */
export const CONTENT_ALLOWED: ReadonlySet<Request["type"]> = new Set([
  "auth:status",
  "analyze",
  "openOnboarding",
  "widget:getPosition",
  "widget:setPosition",
  "reviewed:get",
  "reviewed:set",
  "prefs:get",
  "prefs:set",
  "graph:openTab",
  "history:get",
  "compare:get",
]);

/** Decide whether a message sender may make a request. Pure for testing. */
export function isAllowedSender(req: { type: string }, sender: { id?: string; url?: string; tab?: unknown }, extensionId: string, extensionOrigin: string): boolean {
  if (sender.id !== extensionId) return false;
  const fromExtensionPage = !!sender.url && sender.url.startsWith(extensionOrigin);
  if (fromExtensionPage) return true;
  return CONTENT_ALLOWED.has(req.type as Request["type"]);
}

export function send<T>(req: Request): Promise<T> {
  return chrome.runtime.sendMessage(req).then((res: Response<T> | undefined) => {
    if (!res) throw new Error("No response from background worker");
    if (!res.ok) throw Object.assign(new Error(res.error), { code: res.code });
    return res.data;
  });
}
