import type { AuthStatus, TokenValidationResponse } from "../shared/messages";
import { send } from "../shared/messages";
import { tokenCreationUrl } from "../shared/token-validation";
import config from "../../config/extension.config.json";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const OWNER_KEY = "onboarding.owner";
const REPO_KEY = "onboarding.testRepo";

function h(tag: string, cls: string, text: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.textContent = text;
  return e;
}

function updateUrl() {
  $("createUrl").textContent = tokenCreationUrl({ owner: $<HTMLInputElement>("owner").value, expiresInDays: config.tokenExpiresInDays });
}

async function showCurrent() {
  const s = await send<AuthStatus>({ type: "auth:status" });
  $("current").hidden = s.method === "none";
  if (s.method === "pat") $("currentText").textContent = `Using ${s.tokenHint} for @${s.login ?? "?"} (saved ${s.savedAt?.slice(0, 10)}).`;
}

function renderResult(r: TokenValidationResponse, saving: boolean) {
  const out = $("result");
  const ok = r.result.ok && (r.repoCheck?.ok ?? true);
  const box = h("div", `box ${ok ? "ok" : "bad"}`, "");
  const title = r.result.ok
    ? saving
      ? r.saved
        ? "✓ Token saved. Open any pull request on github.com and click the PR Layers bubble (or press Alt+Shift+L)."
        : "Token not saved."
      : "✓ Token looks good."
    : "✗ Token rejected";
  box.append(h("strong", r.result.ok ? "ok" : "bad", title));
  const ul = document.createElement("ul");
  for (const e of r.result.errors) {
    const li = h("li", "bad", e.message + " ");
    li.append(h("div", "", "How to fix: " + e.fix));
    ul.append(li);
  }
  for (const w of r.result.warnings) ul.append(h("li", "warn", "⚠ " + w));
  for (const c of r.result.checks) ul.append(h("li", "ok", "✓ " + c));
  if (r.repoCheck) {
    ul.append(h("li", "", `Repository check: ${r.repoCheck.repo}`));
    for (const l of r.repoCheck.lines) ul.append(h("li", l.ok ? "ok" : "bad", `${l.ok ? "✓" : "✗"} ${l.label}: ${l.detail}`));
  }
  box.append(ul);
  out.replaceChildren(box);
}

async function go(save: boolean) {
  const token = $<HTMLInputElement>("token").value;
  const testRepo = $<HTMLInputElement>("testRepo").value.trim() || undefined;
  await chrome.storage.local.set({ [REPO_KEY]: testRepo ?? "" });
  $("result").replaceChildren(h("p", "muted", "Checking with GitHub (read-only GET requests)…"));
  try {
    const r = save
      ? await send<TokenValidationResponse>({ type: "auth:save", token, testRepo, attested: $<HTMLInputElement>("attest").checked })
      : await send<TokenValidationResponse>({ type: "auth:validate", token, testRepo });
    renderResult(r, save);
    if (r.saved) {
      $<HTMLInputElement>("token").value = "";
      await showCurrent();
    }
  } catch (e) {
    $("result").replaceChildren(h("div", "box bad", `Couldn't reach GitHub: ${(e as Error).message}`));
  }
}

async function init() {
  const saved = await chrome.storage.local.get([OWNER_KEY, REPO_KEY]);
  $<HTMLInputElement>("owner").value = (saved[OWNER_KEY] as string | undefined) ?? config.defaultTokenOwner ?? "";
  $<HTMLInputElement>("testRepo").value = (saved[REPO_KEY] as string | undefined) ?? "";
  updateUrl();
  $("owner").addEventListener("input", () => {
    updateUrl();
    chrome.storage.local.set({ [OWNER_KEY]: $<HTMLInputElement>("owner").value.trim() });
  });
  $("create").addEventListener("click", () => chrome.tabs.create({ url: tokenCreationUrl({ owner: $<HTMLInputElement>("owner").value, expiresInDays: config.tokenExpiresInDays }) }));
  $("validate").addEventListener("click", () => go(false));
  $("save").addEventListener("click", () => go(true));
  $("clear").addEventListener("click", async () => {
    await send({ type: "auth:clear" });
    await showCurrent();
    $("result").replaceChildren(h("p", "muted", "Token removed from this browser. You can also delete it on GitHub."));
  });
  await showCurrent();
}
void init();
