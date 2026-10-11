import { normalizeRiskPrefs } from "../engine/risk/prefs";
import { FONT_PREF_KEYS, FONTS, ligaturesOn, normalizeFontPrefs } from "../shared/fonts";
import type { AuthStatus, TokenValidationResponse } from "../shared/messages";
import { send } from "../shared/messages";
import { ORG_TOKEN_URL, tokenCreationUrl } from "../shared/token-validation";
import config from "../../config/extension.config.json";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const MODE_KEY = "onboarding.mode";
const OWNER_KEY = "onboarding.owner"; // pre-v0.6.5: a saved org name means the org path
const REPO_KEY = "onboarding.testRepo";

function h(tag: string, cls: string, text: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.textContent = text;
  return e;
}

type Mode = "personal" | "org";

/** Personal / Organisation tabs (ARIA tabs, arrow keys, remembered). */
function setMode(mode: Mode, focus = false, persist = true) {
  for (const m of ["personal", "org"] as Mode[]) {
    const tab = $(`tab-${m}`);
    const on = m === mode;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`panel-${m}`).hidden = !on;
    if (on && focus) tab.focus();
  }
  if (persist) void chrome.storage.local.set({ [MODE_KEY]: mode });
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
        ? "✓ Token saved. Open any pull request on github.com and click the CodeSloth bubble (or press Alt+Shift+L)."
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
  const saved = await chrome.storage.local.get([MODE_KEY, OWNER_KEY, REPO_KEY]);
  $<HTMLInputElement>("testRepo").value = (saved[REPO_KEY] as string | undefined) ?? "";
  const personalUrl = tokenCreationUrl({ expiresInDays: config.tokenExpiresInDays });
  $("createUrl").textContent = personalUrl;
  $("createOrgUrl").textContent = ORG_TOKEN_URL;
  $("create").addEventListener("click", () => chrome.tabs.create({ url: personalUrl }));
  $("createOrg").addEventListener("click", () => chrome.tabs.create({ url: ORG_TOKEN_URL }));
  const savedMode = saved[MODE_KEY] as Mode | undefined;
  setMode(savedMode ?? (saved[OWNER_KEY] || config.defaultTokenOwner ? "org" : "personal"), false, false);
  for (const m of ["personal", "org"] as Mode[]) $(`tab-${m}`).addEventListener("click", () => setMode(m));
  document.querySelector(".modes")!.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(k)) return;
    e.preventDefault();
    const cur: Mode = $("tab-org").getAttribute("aria-selected") === "true" ? "org" : "personal";
    setMode(k === "Home" ? "personal" : k === "End" ? "org" : cur === "org" ? "personal" : "org", true);
  });
  const sync = $<HTMLInputElement>("syncViewed");
  sync.checked = (await chrome.storage.local.get("pref.syncViewed"))["pref.syncViewed"] === true;
  sync.addEventListener("change", () => void chrome.storage.local.set({ "pref.syncViewed": sync.checked }));
  // Code font settings (same pref.* keys the panel uses; the worker tells open tabs to re-apply).
  const fp = normalizeFontPrefs(Object.fromEntries(Object.entries(await chrome.storage.local.get(FONT_PREF_KEYS.map((k) => `pref.${k}`))).map(([k, v]) => [k.slice(5), v])));
  const fontSel = $<HTMLSelectElement>("codeFont");
  const sizeSel = $<HTMLSelectElement>("fontSize");
  const lig = $<HTMLInputElement>("ligatures");
  const diff = $<HTMLInputElement>("diffFont");
  const uiFont = $<HTMLInputElement>("uiFont");
  uiFont.checked = fp.uiFont;
  uiFont.addEventListener("change", () => void chrome.storage.local.set({ "pref.uiFont": uiFont.checked }));
  // Same rules as the panel's Aa picker: no ligature toggle for fonts without ligatures, no "all text" for the system font.
  const syncRows = () => {
    $("ligRow").hidden = !FONTS[fp.codeFont].hasLigatures;
    $("uiRow").hidden = fp.codeFont === "default";
  };
  fontSel.value = fp.codeFont;
  sizeSel.value = fp.fontSize;
  lig.checked = ligaturesOn(fp);
  diff.checked = fp.diffFont;
  syncRows();
  fontSel.addEventListener("change", () => {
    void chrome.storage.local.set({ "pref.codeFont": fontSel.value });
    fp.codeFont = fontSel.value as typeof fp.codeFont;
    lig.checked = ligaturesOn(fp);
    syncRows();
  });
  sizeSel.addEventListener("change", () => void chrome.storage.local.set({ "pref.fontSize": sizeSel.value }));
  lig.addEventListener("change", () => {
    fp.ligatures = lig.checked;
    void chrome.storage.local.set({ "pref.ligatures": lig.checked });
  });
  diff.addEventListener("change", () => void chrome.storage.local.set({ "pref.diffFont": diff.checked }));
  // Risky changes: sensitivity + category toggles (pref.riskSensitivity, pref.riskOff = disabled categories).
  const rs = await chrome.storage.local.get(["pref.riskSensitivity", "pref.riskOff"]);
  const rp = normalizeRiskPrefs(rs["pref.riskSensitivity"], rs["pref.riskOff"]);
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="riskSensitivity"]')) {
    r.checked = r.value === rp.sensitivity;
    r.addEventListener("change", () => r.checked && void chrome.storage.local.set({ "pref.riskSensitivity": r.value }));
  }
  const cats = [...document.querySelectorAll<HTMLInputElement>("input[data-cat]")];
  for (const c of cats) {
    c.checked = !rp.off.includes(c.dataset.cat as never);
    c.addEventListener("change", () => void chrome.storage.local.set({ "pref.riskOff": cats.filter((x) => !x.checked).map((x) => x.dataset.cat) }));
  }
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
