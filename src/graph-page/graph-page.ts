/** Full-tab graph view. Gets the plan from the background worker's cache (no token here, no network). */
import type { AnalyzeResult, Request, Response } from "../shared/messages";
import { prKey } from "../shared/pr-url";
import { GraphView, GRAPH_VIEW_CSS } from "../graph/view";
import { GRAPH_CSS } from "../graph/svg";
import { emptyReview, normalizeReviewState, summarize } from "../content/review-logic";
import demoData from "../demo/demo-plan.json";
import { diffAnchor } from "../shared/pr-url";
import { normalizeRiskPrefs, riskByFile, visibleFindings } from "../engine/risk";
import { normalizeDismissed, riskKey } from "../shared/risk-keys";
import { FONT_PREF_KEYS, fontFaceCss, fontVars, normalizeFontPrefs } from "../shared/fonts";

/** Code font for node labels (same setting as the panel). */
async function applyFont() {
  const raw: Record<string, unknown> = {};
  await Promise.all(FONT_PREF_KEYS.map(async (k) => (raw[k] = await rpc({ type: "prefs:get", key: k }).catch(() => null))));
  const p = normalizeFontPrefs(raw);
  const faces = document.createElement("style");
  faces.textContent = fontFaceCss((path) => chrome.runtime.getURL(path));
  document.head.append(faces);
  for (const [k, v] of Object.entries(fontVars(p))) document.documentElement.style.setProperty(k, v);
}

async function rpc<T>(req: Request): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as Response<T> | undefined;
  if (!res) throw new Error("Extension background not available.");
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

async function main() {
  const style = document.createElement("style");
  style.textContent = GRAPH_CSS + GRAPH_VIEW_CSS;
  document.head.append(style);
  void applyFont();
  const q = new URLSearchParams(location.search);
  const status = document.getElementById("status")!;
  const demo = q.get("demo") === "1";
  const pr = { owner: q.get("owner") ?? "", repo: q.get("repo") ?? "", number: Number(q.get("number")) };
  const tabId = q.get("tab") ? Number(q.get("tab")) : undefined;
  try {
    const res = demo ? (demoData as unknown as AnalyzeResult) : await rpc<AnalyzeResult>({ type: "graph:getPlan", pr, headSha: q.get("sha") ?? "" });
    const review = demo ? emptyReview() : normalizeReviewState(await rpc({ type: "reviewed:get", key: prKey(res.pr) }).catch(() => ({})));
    document.getElementById("title")!.textContent = `${res.pr.owner}/${res.pr.repo}#${res.pr.number} · ${res.meta.title}${demo ? " (demo)" : ""}`;
    document.title = `Graph · #${res.pr.number} ${res.meta.title}`;
    const view = new GraphView({
      onJump: async (path) => {
        if (demo || tabId === undefined) {
          window.open(`https://github.com/${res.pr.owner}/${res.pr.repo}/pull/${res.pr.number}/files#${await diffAnchor(path)}`, "_blank", "noopener");
        } else {
          await rpc({ type: "graph:jump", tabId, pr: res.pr, path });
        }
      },
    });
    status.remove();
    document.getElementById("app")!.append(view.el);
    const s = summarize(res.plan, review);
    // Same risky files as the panel: the user's sensitivity/categories minus "Not breaking" dismissals.
    const [sens, off, dis] = await Promise.all([rpc({ type: "prefs:get", key: "riskSensitivity" }).catch(() => null), rpc({ type: "prefs:get", key: "riskOff" }).catch(() => null), demo ? {} : rpc({ type: "reviewed:get", key: riskKey(res.pr) }).catch(() => ({}))]);
    const risk = new Map<string, "high" | "medium" | "low">();
    for (const [p, v] of riskByFile(visibleFindings(res.risk, normalizeRiskPrefs(sens, off), res.risk?.sensitivity), normalizeDismissed(dis))) if (v.findings.length) risk.set(p, v.severity);
    view.setData(res.plan, { reviewedLayers: s.reviewedLayers, reviewedPaths: s.reviewedPaths, changedPaths: s.changedPaths, risk });
  } catch (e) {
    status.textContent = (e as Error).message;
  }
}
void main();
