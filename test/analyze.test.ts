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

  it("gives per-file reasons in review language", () => {
    const r = (p: string) => layerOf(p).files.find((f) => f.path === p)!.reason;
    expect(r("src/services/user.ts")).toBe("Uses db.ts; imported by UserCard.vue");
    expect(r("src/lib/db.ts")).toMatch(/^Imported by /);
    expect(r("src/types/user.ts")).toBe("Type · Imported by services/user.ts");
    expect(r("src/services/user.test.ts")).toBe("Tests for services/user.ts");
    expect(r("package-lock.json")).toBe("Lockfile for the package.json change");
    expect(r("src/misc/standalone.ts")).toBe("No imports to or from other changed code");
    expect(r("src/moved.ts")).toMatch(/src\/old\.ts/);
  });

  it("tells the reviewer the order and why for each layer, from real counts", () => {
    const copy = plan.layers.map((l) => [l.label, l.title, l.description]);
    expect(copy).toEqual([
      ["Mechanical", "Skim the rename", "1 pure rename; nothing else changed."],
      ["Contracts", "Start with the types", "1 other changed file builds on this."],
      ["Core", "Then the core code", "2 other changed files import this."],
      ["Callers 1", "Then the code that uses it", "This uses the changes you just reviewed."],
      ["Callers 2", "Then UserCard.vue", "This uses user.ts from step 4."],
      ["Callers 3", "Then Profile.tsx", "This uses UserCard.vue from step 5."],
      ["Standalone", "Then the standalone changes", "No imports to or from other changed code."],
      ["Tests", "Now the tests", "These cover 2 files above."],
      ["Config & docs", "Then config and docs", "Settings and docs for this change."],
      ["Generated", "Skim the lockfile last", "A lockfile; skim only."],
    ]);
  });

  it("only says nothing depends on deleted code when the graph agrees", () => {
    const del = (filename: string): PRFile => ({ filename, status: "removed", additions: 0, deletions: 3, changes: 3, sha: filename, patch: "@@ -1,3 +0,0 @@\n-a\n-b\n-c" });
    const clean = analyze({ files: [del("src/old.ts"), added("src/a.ts", "export const a = 1")] });
    const d1 = clean.layers.find((l) => l.id === "removed")!;
    expect(d1.title).toBe("Check what was removed");
    expect(d1.description).toBe("Nothing changed still imports this code.");
    expect(d1.files[0].reason).toBe("Deleted; no changed file imports it");
    const dirty = analyze({ files: [del("src/old.ts"), added("src/a.ts", "import { x } from './old'\nexport const a = x")] });
    const d2 = dirty.layers.find((l) => l.id === "removed")!;
    expect(d2.description).toBe("Still imported by a.ts; check it.");
    expect(d2.files[0].reason).toBe("Deleted, but still imported by a.ts");
    const go = analyze({ goMods: { "go.mod": "module m" }, files: [del("pkg/old.go"), added("pkg/new.go", "package pkg\nfunc New() {}")] });
    expect(go.layers.find((l) => l.id === "removed")!.description).toBe("Its Go package still exists, so check nothing still uses it.");
  });

  it("adapts contract wording to what changed", () => {
    const p = analyze({ files: [added("db/schema.sql", "create table t(id int);"), added("api/queries/get.graphql", "query { a }"), added("db/migrations/0001_init.sql", "x")] });
    expect(p.layers[0].title).toBe("Start with the contracts");
    expect(p.layers[0].description).toBe("Schemas, queries and migrations. The rest of the change builds on these.");
    const two = analyze({ files: [added("db/schema.sql", "create table t(id int);"), added("api/queries/get.graphql", "query { a }")] });
    expect(two.layers[0].title).toBe("Start with the schemas and queries");
    const one = analyze({ files: [added("db/schema.sql", "create table t(id int);"), added("src/x.ts", "export const x = 1")] });
    expect(one.layers[0].title).toBe("Start with the schema");
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
    expect(L("api/h_test.go").files.find((f) => f.path === "api/h_test.go")!.reason).toBe("Tests for h.go (matched by name)");
    expect(L("store/a.go").description).toBe("1 other changed file imports these.");
  });

  it("splits oversized layers by package directory", () => {
    const fs: PRFile[] = [];
    for (const pkg of ["packages/a", "packages/b"]) for (let i = 0; i < 15; i++) fs.push(added(`${pkg}/f${i}.ts`, "export const v = 1"));
    const p = analyze({ files: fs });
    expect(p.layers.map((l) => [l.label, l.title, l.description])).toEqual([
      ["Standalone · packages/a", "Start with the standalone changes", "In packages/a/. No imports to or from other changed code."],
      ["Standalone · packages/b", "Then the standalone changes", "In packages/b/. No imports to or from other changed code."],
    ]);
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

import { fileLabel, joinWords, namesList, plural } from "../src/engine/copy";
describe("copy helpers", () => {
  it("pluralizes and lists names naturally", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(3, "file")).toBe("3 files");
    expect(namesList(["a/x.py"])).toBe("x.py");
    expect(namesList(["a/x.py", "b/y.py"])).toBe("x.py and y.py");
    expect(namesList(["a/x.py", "b/y.py", "c/z.py", "d/w.py"])).toBe("x.py and 3 others");
    expect(namesList(["a/x.py", "b/y.py", "c/z.py"])).toBe("x.py and 2 others");
    expect(joinWords(["schema", "query", "type"])).toBe("schema, query and type");
    expect(fileLabel("pkg/telemetry/__init__.py")).toBe("telemetry/__init__.py");
    expect(fileLabel("a/util.ts", ["a/util.ts", "b/util.ts"])).toBe("a/util.ts");
  });
});
