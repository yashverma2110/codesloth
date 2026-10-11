/** The Review tab as a checklist of numbered steps with per-file review (see docs/images/review-demo.png). */
import type { Layer, LayerFile, LayerPlan } from "../engine/types";
import { authored, fileStory, relTime, stepCommits, storyActive, type CommitHistory } from "../shared/history";
import type { StaleSummary } from "./review-logic";
import { ctaTarget, currentStep, fileReview, groupByFolder, isLastUnreviewed, layerReview, summarize, type ReviewState } from "./review-logic";

export interface ReviewHandlers {
  /** Step ids the user has expanded. */
  open: ReadonlySet<string>;
  /** Selected file path (highlighted, aria-current). */
  selected: string | null;
  /** Files whose GitHub "Viewed" sync failed: path -> tooltip. */
  unsynced?: ReadonlyMap<string, string>;
  /** Commit story (null while loading / unavailable / demo without data). */
  history?: CommitHistory | null;
  /** Link for a commit on github.com. */
  commitUrl?: (sha: string) => string;
  now?: number;
  /** Selected file's commit timeline expanded (session pref, default closed). */
  storyOpen?: boolean;
  /** Show all of the selected file's commits instead of the latest 3. */
  storyAll?: boolean;
  onToggleStory?(open: boolean): void;
  onToggleStoryAll?(all: boolean): void;
  /** "N new commits changed M files you reviewed" banner (null = hidden). */
  stale?: StaleSummary | null;
  /** New commits that touched each stale file (tooltip), from the commit story. */
  staleCommits?: ReadonlyMap<string, string[]>;
  staleListOpen?: boolean;
  onUntickStale?(): void;
  onKeepStale?(): void;
  onDismissStale?(): void;
  onToggleStaleList?(open: boolean): void;
  onSelect(path: string): void;
  onToggleFile(file: LayerFile, reviewed: boolean): void;
  onToggleStep(layer: Layer, reviewed: boolean): void;
  onOpen(layer: Layer, open: boolean): void;
  onMarkNext(layer: Layer): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}

export const STATUS_LABEL: Record<string, string> = {
  added: "New file",
  removed: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  modified: "Modified",
  changed: "Modified",
  unchanged: "Unchanged",
};
const statusClass = (s: LayerFile["status"]) => (s === "added" ? "new" : s === "removed" ? "del" : s === "renamed" || s === "copied" ? "ren" : "mod");
const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

function chip(text: string, title: string, cls = "") {
  return el("span", { class: `chip ${cls}`.trim(), title }, text);
}

/** "Touched in X of Y commits" with one dot per commit. */
function stepStory(hist: CommitHistory, paths: string[]): HTMLElement {
  const own = authored(hist);
  const hit = new Set(stepCommits(hist, paths));
  const x = own.filter((i) => hit.has(i)).length;
  const capped = hist.commits.length < hist.totalCommits;
  const text = capped ? `Touched in ${x} of the latest ${own.length} commits (PR has ${hist.totalCommits})` : `Touched in ${x} of ${commits(own.length)}`;
  const line = el("p", { class: "story", title: hist.notes[0] ?? text }, el("span", { class: "ico", "aria-hidden": "true" }, "⎇"), text);
  if (own.length <= 20) {
    const dots = el("span", { class: "sdots", "aria-hidden": "true" });
    for (const i of own) dots.append(el("i", { class: hit.has(i) ? "on" : "", title: hist.commits[i].message }));
    line.append(dots);
  }
  return line;
}

/** Commits shown in the timeline before "Show all". */
export const TIMELINE_LIMIT = 3;

/** Collapsible mini timeline of one file's commits, oldest -> newest (latest 3 unless "Show all"). */
function timeline(hist: CommitHistory, f: LayerFile & { name: string }, h: ReviewHandlers): HTMLElement {
  const story = fileStory(hist, f.path);
  const n = story.touches.length;
  const open = !!h.storyOpen;
  const toggle = el(
    "button",
    { class: "tltog", type: "button", "aria-expanded": String(open), "aria-controls": "prl-tl", title: open ? "Hide commit history" : "Show commit history" },
    el("span", { class: "tlchev", "aria-hidden": "true" }),
    `Commit history · ${n}`,
  );
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    h.onToggleStory?.(!open);
  });
  const wrap = el("div", { class: "tlwrap" + (open ? " open" : "") }, toggle);
  const ol = el("ol", { class: "tl", id: "prl-tl", "aria-label": `Commits that changed ${f.name}, oldest first` });
  if (!open) {
    ol.hidden = true;
    wrap.append(ol);
    return wrap;
  }
  const all = !!h.storyAll || n <= TIMELINE_LIMIT;
  const shown = all ? story.touches : story.touches.slice(n - TIMELINE_LIMIT);
  if (n > TIMELINE_LIMIT) {
    const k = n - TIMELINE_LIMIT;
    const more = el("button", { class: "tlmore", type: "button", "aria-controls": "prl-tl", "aria-expanded": String(all) }, all ? "Show fewer" : `+ ${k} earlier commit${k === 1 ? "" : "s"} · Show all ${n}`);
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      h.onToggleStoryAll?.(!all);
    });
    wrap.append(more);
  }
  for (const t of shown) {
    const c = t.commit;
    const who = c.name ?? c.login ?? "unknown author";
    const meta = el(
      "div",
      { class: "tm" },
      el("span", { class: "av", title: c.login && c.name ? `${c.name} (@${c.login})` : who, "aria-label": who }, c.initials),
      el("span", {}, relTime(c.date, h.now)),
      el("span", { class: "add" }, `+${t.additions}`),
      el("span", { class: "del" }, `−${t.deletions}`),
    );
    if (h.commitUrl) meta.append(el("a", { class: "sha", href: h.commitUrl(c.sha), target: "_blank", rel: "noopener", title: "Open this commit on GitHub" }, c.sha.slice(0, 7)));
    else meta.append(el("span", { class: "sha" }, c.sha.slice(0, 7)));
    if (t.newest) meta.append(chip("newest", "The PR's newest commit", "plain"));
    if (t.afterReview) meta.append(chip("After review", "This commit message looks like a review follow-up (fixup!, address comments, review feedback, nit…)"));
    if (t.as) meta.append(chip(`as ${t.as.slice(t.as.lastIndexOf("/") + 1)}`, `This file was ${t.as} in this commit`, "plain"));
    ol.append(el("li", { class: "tc" + (t.newest ? " newest" : "") }, el("div", { class: "tmsg", title: c.message }, c.message), meta));
  }
  wrap.append(ol);
  return wrap;
}

/** "3 new commits changed 2 files you reviewed." + Untick / Keep / Show files / dismiss. */
function staleBanner(st: StaleSummary, h: ReviewHandlers): HTMLElement {
  const open = !!h.staleListOpen;
  const untick = el("button", { type: "button", class: "btn primary sm", "data-act": "untick", title: "Remove the ticks of the changed files and go to the first one" }, "Untick changed files");
  untick.addEventListener("click", () => h.onUntickStale?.());
  const keep = el("button", { type: "button", class: "btn sm", "data-act": "keep", title: "Accept the new versions as reviewed" }, "Keep my ticks");
  keep.addEventListener("click", () => h.onKeepStale?.());
  const show = el("button", { type: "button", class: "linkbtn", "data-act": "show", "aria-expanded": String(open), "aria-controls": "prl-stale-list" }, open ? "Hide files" : "Show files");
  show.addEventListener("click", () => h.onToggleStaleList?.(!open));
  const x = el("button", { type: "button", class: "x", "data-act": "dismiss", title: "Dismiss (comes back only after a new push)", "aria-label": "Dismiss" }, "✕");
  x.addEventListener("click", () => h.onDismissStale?.());
  const list = el("ul", { class: "stale-list", id: "prl-stale-list" });
  list.hidden = !open;
  for (const f of st.files) {
    const name = f.path.slice(f.path.lastIndexOf("/") + 1);
    list.append(el("li", { title: f.commits.length ? `${f.path}\nChanged in: ${f.commits.join(" · ")}` : f.path }, el("span", { class: "fname" }, name), f.commits.length ? el("span", { class: "muted" }, ` · ${f.commits.length} new commit${f.commits.length === 1 ? "" : "s"}`) : ""));
  }
  return el(
    "div",
    { class: "stalebar", role: "status", "data-tour": "changed" },
    el("div", { class: "stx" }, el("span", { class: "ico", "aria-hidden": "true" }, "⚠"), el("span", { class: "msg" }, st.text), x),
    el("div", { class: "sacts" }, untick, keep, show),
    list,
  );
}

export function renderReview(plan: LayerPlan, state: ReviewState, h: ReviewHandlers): HTMLElement {
  const root = el("div", { class: "review" });
  const hist = storyActive(h.history) ? h.history : null;
  const sum = summarize(plan, state);
  if (h.stale) root.append(staleBanner(h.stale, h));
  if (sum.totalFiles && sum.reviewedFiles === sum.totalFiles) {
    root.append(el("div", { class: "alldone", role: "status" }, el("span", { class: "ok", "aria-hidden": "true" }, "✓"), `All ${files(sum.totalFiles)} reviewed`));
  }
  const wrap = el("ol", { class: "steps", "aria-label": "Review steps" });
  const cur = currentStep(plan, state);
  plan.layers.forEach((l, i) => {
    const lr = layerReview(l, state);
    const done = lr.state === "done";
    const isOpen = h.open.has(l.id);
    const bodyId = `prl-step-${i}`;
    const li = el("li", { class: ["step", done ? "done" : "", lr.state === "partial" ? "partial" : "", i === cur ? "current" : "", isOpen ? "open" : "", lr.changed.length ? "changed" : ""].filter(Boolean).join(" "), "data-layer": l.id });
    if (i === 0) li.setAttribute("data-tour", "step");

    const num = el("span", { class: "num", "aria-hidden": "true" }, done ? "✓" : String(i + 1));
    const count = lr.state === "partial" ? `${lr.reviewed}/${l.files.length}` : files(l.files.length);
    const head = el(
      "button",
      { type: "button", class: "sh", "aria-expanded": String(isOpen), "aria-controls": bodyId, title: `${l.title}: ${l.description}` },
      num,
      el("span", { class: "h" }, el("span", { class: "sr" }, `Step ${i + 1}${done ? ", reviewed" : lr.state === "partial" ? `, ${lr.reviewed} of ${files(l.files.length)} reviewed` : ""}${lr.changed.length ? ", changed since reviewed" : ""}: `), l.title),
      lr.changed.length ? el("span", { class: "chg-ico", title: "Changed since you reviewed it", "aria-hidden": "true" }, "⚠") : "",
      el("span", { class: "cnt" }, count),
      el("span", { class: "chev", "aria-hidden": "true" }, "›"),
    );
    head.addEventListener("click", () => h.onOpen(l, !isOpen));
    const cb = el("input", { type: "checkbox", class: "tick", title: done ? "Unmark all files in this step" : "Mark all files in this step reviewed", "aria-label": `Mark all files in step ${i + 1} reviewed` }) as HTMLInputElement;
    cb.checked = done;
    cb.indeterminate = lr.state === "partial";
    if (lr.state === "partial") cb.setAttribute("aria-checked", "mixed");
    if (!done && !wrap.querySelector('[data-tour="check"]')) cb.setAttribute("data-tour", "check");
    cb.addEventListener("change", () => h.onToggleStep(l, !done));
    li.append(el("div", { class: "srow" }, head, cb));

    if (isOpen) {
      const body = el("div", { class: "sbody", id: bodyId });
      body.append(el("p", { class: "why", ...(!root.querySelector('[data-tour="why"]') ? { "data-tour": "why" } : {}) }, l.description));
      if (lr.changed.length) {
        body.append(el("p", { class: "flag", role: "status", "data-tour": "changed" }, `⚠ ${lr.changed.length === 1 ? "1 file changed" : `${lr.changed.length} files changed`} since you reviewed it.`));
      }
      if (hist) body.append(stepStory(hist, l.files.map((f) => f.path)));
      const max = Math.max(1, ...l.files.map((f) => f.additions));
      for (const g of groupByFolder(l.files)) {
        if (g.dir) body.append(el("div", { class: "folder", title: g.dir }, g.dir));
        const ul = el("ul", { class: "files" });
        for (const f of g.files) {
          const fr = fileReview(state, f);
          const sel = h.selected === f.path;
          const unsync = h.unsynced?.get(f.path);
          const story = hist ? fileStory(hist, f.path) : null;
          const n = story?.touches.length ?? 0;
          const latest = n ? story!.touches[n - 1].commit : null;
          const st = STATUS_LABEL[f.status] ?? "Modified";
          const stTitle = f.previousPath ? `${st} from ${f.previousPath}` : st;
          const bar = el("span", { class: "bar", "aria-hidden": "true" });
          bar.style.width = `${Math.max(2, Math.round((f.additions / max) * 40))}px`;
          const staleMsgs = fr === "changed" ? (h.staleCommits?.get(f.path) ?? []) : [];
          const staleTitle = `Changed since you reviewed${staleMsgs.length ? ` · new commits: ${staleMsgs.join(" · ")}` : ""}`;
          const icon =
            fr === "reviewed"
              ? el("span", { class: "rev-ico", title: `Reviewed · ${stTitle}`, "aria-hidden": "true" }, "✓")
              : fr === "changed"
                ? el("span", { class: "stale-ico", title: staleTitle, "aria-hidden": "true" }, "⚠")
                : el("span", { class: `dot ${statusClass(f.status)}`, title: stTitle, "aria-hidden": "true" });
          const btn = el(
            "button",
            {
              type: "button",
              class: "fbtn",
              "data-path": f.path,
              "aria-label": `${f.path}, ${st.toLowerCase()}${fr === "reviewed" ? ", reviewed" : fr === "changed" ? `, reviewed but stale: ${staleTitle.toLowerCase()}` : ""}${unsync ? ", not synced with GitHub Viewed" : ""}${n ? `, ${commits(n)}` : ""}${story?.afterReview ? ", after review" : ""}${story?.lateChange ? ", late change" : ""}, ${f.additions} added, ${f.deletions} removed. ${f.reason}${latest ? `. Latest commit: ${latest.message}, ${relTime(latest.date, h.now)}` : ""}`,
              ...(sel ? { "aria-current": "true" } : {}),
            },
            icon,
            el("span", { class: "fname", title: f.path }, f.name),
            unsync ? el("span", { class: "unsync", title: unsync, "aria-hidden": "true" }, "⊘") : "",
            n ? el("span", { class: "cm", title: story!.touches.map((t) => t.commit.message).join("\n") }, commits(n)) : "",
            story?.afterReview ? chip("After review", "A commit that changed this file looks like a review follow-up") : "",
            story?.lateChange ? chip("Late change", "Only changed in the PR's newest commit", "dash") : "",
            el("span", { class: "nums" }, bar, el("span", { class: "add" }, `+${f.additions}`), f.deletions > 0 ? el("span", { class: "del" }, `−${f.deletions}`) : ""),
            el("span", { class: "reason" }, el("span", { class: "rtext" }, f.reason), latest ? el("span", { class: "latest", title: `Latest: ${latest.message} · ${relTime(latest.date, h.now)}` }, el("i", {}, "Latest: "), `${latest.message} · ${relTime(latest.date, h.now)}`) : ""),
          );
          btn.addEventListener("click", () => h.onSelect(f.path));
          const ft = el("input", { type: "checkbox", class: "ftick" + (fr === "changed" ? " stale" : ""), "data-path": f.path, title: fr === "reviewed" ? "Unmark reviewed" : fr === "changed" ? `${staleTitle}. Uncheck to remove the tick` : "Mark reviewed", "aria-label": `Mark ${f.name} reviewed` }) as HTMLInputElement;
          ft.checked = fr !== "none"; // stale ticks stay ticked (amber) until you decide
          ft.addEventListener("change", () => h.onToggleFile(f, ft.checked));
          const row = el("li", { class: ["file", sel ? "sel" : "", fr === "reviewed" ? "rev" : "", fr === "changed" ? "chg" : ""].filter(Boolean).join(" ") }, btn, ft);
          if (sel && hist && n) row.append(timeline(hist, f, h));
          if (!root.querySelector('[data-tour="file"]') && !body.querySelector('[data-tour="file"]')) row.setAttribute("data-tour", "file");
          ul.append(row);
        }
        body.append(ul);
      }
      const target = ctaTarget(plan, state, i, h.selected);
      if (target) {
        const last = isLastUnreviewed(plan, state, target.path);
        const name = target.path.slice(target.path.lastIndexOf("/") + 1);
        const btn = el("button", { type: "button", class: "btn primary next", "data-tour": "next", title: `Marks ${name} reviewed (shortcut: n)` }, last ? "Mark file as reviewed ✓" : "Mark file as reviewed & next →");
        btn.addEventListener("click", () => h.onMarkNext(l));
        body.append(el("div", { class: "sfoot" }, btn, el("div", { class: "hint" }, `For ${name} · n mark & next · j/k move`)));
      }
      li.append(body);
    }
    wrap.append(li);
  });
  root.append(wrap);
  return root;
}
