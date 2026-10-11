/**
 * Content script on github.com. Mounts the floating CodeSloth widget (shadow DOM) on PR pages only,
 * following GitHub's soft (Turbo) navigation, and removes it elsewhere. It never touches the token
 * or chrome.storage; all data comes from the background worker via messages.
 */
import { parsePrUrl } from "../shared/pr-url";
import type { TabMessage } from "../shared/messages";
import { HOST_ID, jumpTo, Widget } from "./widget";
import { settleInitialHash } from "./scroll";

declare global {
  interface Window {
    __codeslothLoaded?: boolean;
  }
}

if (!window.__codeslothLoaded) {
  window.__codeslothLoaded = true;
  let widget: Widget | null = null;
  let mounting: Promise<void> | null = null;
  let lastUrl = "";

  const sync = async () => {
    const pr = parsePrUrl(location.href);
    if (!pr) {
      if (widget) {
        widget.toggle("leave-pr");
        widget.unmount();
        widget = null;
      }
      document.getElementById(HOST_ID)?.remove();
      return;
    }
    if (!widget) {
      widget = new Widget();
      mounting = widget.mount();
      await mounting;
    } else if (!widget.isMounted()) {
      widget.remount();
    }
    widget.setPr(pr);
  };

  const check = () => {
    if (location.href !== lastUrl || (widget && !widget.isMounted())) {
      lastUrl = location.href;
      void sync();
    }
  };

  chrome.runtime.onMessage.addListener((msg: TabMessage, _sender, sendResponse) => {
    if (msg?.type === "widget:toggle") {
      void (async () => {
        await sync();
        await mounting;
        widget?.toggle(msg.source);
      })();
      sendResponse(true);
      return false;
    }
    if (msg?.type === "progress") widget?.progress(msg.pr, msg.text);
    if (msg?.type === "auth:changed") widget?.onAuthChanged();
    if (msg?.type === "jump") void jumpTo(msg.path);
    if (msg?.type === "prefs:changed") {
      void widget?.loadFontPrefs();
      void widget?.loadRiskPrefs();
    }
    if (msg?.type === "ping") sendResponse(true);
    return false;
  });

  document.addEventListener("turbo:load", check);
  document.addEventListener("turbo:render", check);
  window.addEventListener("popstate", check);
  setInterval(check, 800);
  check();
  // Arrived on Files changed with a file anchor (e.g. from the full-tab graph): settle below the sticky bars.
  void settleInitialHash({ doc: document, win: window });
}
