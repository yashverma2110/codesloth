import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WIDGET_CSS as A, WIDGET_CSS_V3 as B } from "../src/content/widget.css";
const WIDGET_CSS = A + B;

const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";

describe("panel never overflows horizontally (v0.5.1 regression)", () => {
  it("CSS keeps rows inside the panel: no horizontal scroll, min-width:0, clamped messages", () => {
    expect(WIDGET_CSS).toMatch(/\.body \{ overflow-x:hidden; overflow-y:auto; \}/);
    expect(WIDGET_CSS).toMatch(/\.tmsg \{[^}]*-webkit-line-clamp:2/);
    expect(WIDGET_CSS).toMatch(/\.tmsg \{[^}]*overflow-wrap:anywhere/);
    expect(WIDGET_CSS).toMatch(/\.reason \.latest \{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; \}/);
    expect(WIDGET_CSS).toMatch(/\.tlwrap \{[^}]*overflow:hidden/);
    expect(WIDGET_CSS).toMatch(/\.panel, \.panel \* \{ box-sizing:border-box; \}/);
  });

  it.skipIf(!existsSync(CHROME))(
    "headless Chrome: scrollWidth <= clientWidth and every element inside the panel, with very long commit messages and file names, at 288/400/640px",
    () => {
      const out = execFileSync("node", ["scripts/dev/check-overflow.mjs"], { encoding: "utf8", timeout: 230_000 });
      expect(out).toContain("no horizontal overflow");
      expect(out).not.toContain("FAIL");
    },
    240_000,
  );
});
