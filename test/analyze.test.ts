import { describe, expect, it } from "vitest";
import { analyze, sourceStem, testStem } from "../src/engine/analyze";
import { isFormattingOnly, parsePatch } from "../src/engine/patch";
import { tarjan } from "../src/engine/graph";
import { parsePrUrl } from "../src/shared/pr-url";
import type { PRFile } from "../src/engine/types";

const added = (filename: string, content: string): PRFile => ({
  filename, status: "added", additions: content.split("\n").length, deletions: 0, changes: content.split("\n").length, sha: filename,
  patch: "@@ -0,0 +1 @@\n" + content.split("\n").map((l) => "+" + l).join("\n"),
});

describe("layer assembly", () => {
  const files: PRFile[] = [
    added("src/types/user.ts", "export interface User { id: string }"),
    added("src/lib/db.ts", "export const db = {}"),
    added("src/services/user.ts", "import { db } from '../lib/db'\nimport type { User } from '../types/user'\nexport const getUser = () => db"),
    added("src/components/UserCard.vue", "<script setup lang=\"ts\">\nimport { getUser } from '@/services/user'\n</script>"),
    added("src/pages/Profile.tsx", "import UserCard from '../components/UserCard.vue'\nexport default () => null"),
    added("src/services/user.test.ts", "import { getUser } from './user'"),
    added("src/lib/__tests__/db.spec.ts", "import { db } from '../db'"),
    added("src/misc/standalone.ts", "export const x = 1"),
    added("package.json", "{}"),
    added("package-lock.json", "{}"),
    added("README.md", "# hi"),
    { filename: "src/moved.ts", previous_filename: "src/old.ts", status: "renamed", additions: 0, deletions: 0, changes: 0, sha: "m" },
  ];
  const plan = analyze({ files });
  const layerOf = (p: string) => plan.layers.find((l) => l.files.some((f) => f.path === p))!;
  const order = (p: string) => layerOf(p).index;

  it("orders mechanical -> contracts -> core -> callers -> standalone -> tests -> config/docs -> generated", () => {
    expect(layerOf("src/moved.ts").id).toBe("mechanical");
    expect(layerOf("src/types/user.ts").id).toBe("contract");
    expect(layerOf("src/lib/db.ts").id).toBe("core");
    expect(order("src/lib/db.ts")).toBeLessThan(order("src/services/user.ts"));
    expect(order("src/services/user.ts")).toBeLessThan(order("src/components/UserCard.vue"));
    expect(order("src/components/UserCard.vue")).toBeLessThan(order("src/pages/Profile.tsx"));
    expect(layerOf("src/misc/standalone.ts").id).toBe("standalone");
    expect(layerOf("src/services/user.test.ts").id).toBe("test");
    expect(layerOf("package.json").id).toBe("configdocs");
    expect(layerOf("README.md").id).toBe("configdocs");
    expect(layerOf("package-lock.json").id).toBe("generated");
    expect(plan.layers.map((l) => l.index)).toEqual(plan.layers.map((_, i) => i));
  });

  it("gives human-readable reasons", () => {
    const r = (p: string) => layerOf(p).files.find((f) => f.path === p)!.reason;
    expect(r("src/services/user.ts")).toMatch(/imports lib\/db\.ts \[Core\]/);
    expect(r("src/lib/db.ts")).toMatch(/used by/);
    expect(r("src/types/user.ts")).toMatch(/used by services\/user\.ts/);
    expect(r("src/services/user.test.ts")).toMatch(/tests services\/user\.ts/);
    expect(r("package-lock.json")).toMatch(/goes with the package\.json change/);
    expect(r("src/moved.ts")).toMatch(/src\/old\.ts/);
  });

  it("orders tests by their subject's layer", () => {
    const tests = layerOf("src/services/user.test.ts").files.map((f) => f.path);
    expect(tests.indexOf("src/lib/__tests__/db.spec.ts")).toBeLessThan(tests.indexOf("src/services/user.test.ts"));
  });

  it("keeps import cycles together", () => {
    const p = analyze({
      files: [added("a/x.ts", "import './y'\nexport const x=1"), added("a/y.ts", "import './x'\nexport const y=1"), added("a/z.ts", "import './x'")],
    });
    const lx = p.layers.find((l) => l.files.some((f) => f.path === "a/x.ts"))!;
    expect(lx.files.map((f) => f.path)).toContain("a/y.ts");
    expect(lx.files.find((f) => f.path === "a/x.ts")!.reason).toMatch(/cycle/);
  });

  it("keeps a Go package in one layer and orders packages by imports", () => {
    const goMods = { "go.mod": "module example.com/m" };
    const p = analyze({
      goMods,
      files: [
        added("store/a.go", "package store\nfunc Get() {}"),
        added("store/b.go", "package store\nfunc Put() { Get() }"),
        added("api/h.go", 'package api\nimport "example.com/m/store"\nfunc H() { store.Get() }'),
        added("api/h_test.go", 'package api\nimport "testing"\nfunc TestH(t *testing.T) { H() }'),
      ],
    });
    const L = (x: string) => p.layers.find((l) => l.files.some((f) => f.path === x))!;
    expect(L("store/a.go").id).toBe(L("store/b.go").id);
    expect(L("store/a.go").index).toBeLessThan(L("api/h.go").index);
    expect(L("api/h_test.go").files.find((f) => f.path === "api/h_test.go")!.reason).toMatch(/api\/h\.go/);
  });

  it("splits oversized layers by package directory", () => {
    const fs: PRFile[] = [];
    for (const pkg of ["packages/a", "packages/b"]) for (let i = 0; i < 15; i++) fs.push(added(`${pkg}/f${i}.ts`, "export const v = 1"));
    const p = analyze({ files: fs });
    expect(p.layers.map((l) => l.title)).toEqual(["Standalone changes · packages/a", "Standalone changes · packages/b"]);
  });

  it("warns when modified files were analysed from the diff only", () => {
    const p = analyze({ files: [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, changes: 2, sha: "1", patch: "@@ -1 +1 @@\n-a()\n+b()" }] });
    expect(p.warnings.join(" ")).toMatch(/diff only/);
  });
});

describe("helpers", () => {
  it("stems test and source names for pairing", () => {
    expect(["Button.test.tsx", "user.spec.ts", "store_test.go", "test_user.py", "user_test.py"].map(testStem)).toEqual(["button", "user", "store", "user", "user"]);
    expect(sourceStem("src/Button/index.tsx")).toBe("button");
    expect(sourceStem("app/_runtime.py")).toBe("runtime");
  });
  it("parses patches and detects formatting-only", () => {
    expect(parsePatch("@@ -1,2 +1,2 @@\n ctx\n-old\n+new").headView).toBe("\nctx\nnew");
    expect(isFormattingOnly("@@ -1 +1,2 @@\n-a(b, c)\n+a(b,\n+  c)")).toBe(true);
    expect(isFormattingOnly(undefined)).toBe(false);
  });
  it("finds SCCs", () => {
    const e = new Map([["a", new Set(["b"])], ["b", new Set(["a"])], ["c", new Set(["a"])]]);
    expect(tarjan(["a", "b", "c"], e).map((c) => c.join())).toEqual(["a,b", "c"]);
  });
  it("parses PR URLs", () => {
    expect(parsePrUrl("https://github.com/o/r/pull/12/files#diff-1")).toEqual({ owner: "o", repo: "r", number: 12 });
    expect(parsePrUrl("https://github.com/o/r/pulls")).toBeNull();
    expect(parsePrUrl("https://gitlab.com/o/r/pull/1")).toBeNull();
    expect(parsePrUrl("https://github.com/orgs/x/pull/1")).toBeNull();
  });
});
