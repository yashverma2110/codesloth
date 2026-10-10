import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractJsImports, stripJsComments } from "../src/engine/imports/js";
import { extractVueImports, extractVueScripts } from "../src/engine/imports/vue";
import { extractGoImports, goPackageName, goTopLevelDecls } from "../src/engine/imports/go";
import { extractPythonImports } from "../src/engine/imports/python";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");

describe("JS/TS/React imports", () => {
  const imps = extractJsImports(fx("component.tsx"));
  it("finds ESM default, named, namespace, type and multi-line imports", () => {
    expect(imps).toEqual(expect.arrayContaining(["react", "../types/user", "@/utils/format", "./api", "./Button", "./styles.css"]));
  });
  it("finds re-exports, dynamic import and require", () => {
    expect(imps).toEqual(expect.arrayContaining(["./helper", "./reexport", "./LazyPanel", "../config.json"]));
  });
  it("ignores commented-out imports and strings", () => {
    expect(imps).not.toContain("./commented-out");
    expect(imps).not.toContain("./block-commented");
    expect(imps).not.toContain("nope");
  });
  it("handles CommonJS require + require.resolve (Node)", () => {
    expect(extractJsImports(fx("server.cjs")).sort()).toEqual(["./db", "./routes/index.js", "./worker", "express"].sort());
  });
  it("handles test mocks and side-effect imports", () => {
    const src = `import './setup';\nvi.mock('../api/client');\njest.mock("./store", () => ({}));\nimport type {A} from './a'`;
    expect(extractJsImports(src).sort()).toEqual(["../api/client", "./a", "./setup", "./store"]);
  });
  it("does not match member calls like foo.require('x') or import.meta", () => {
    expect(extractJsImports(`foo.require('x'); const u = import.meta.url;`)).toEqual([]);
  });
  it("strips comments but keeps strings with //", () => {
    expect(stripJsComments(`const a = "http://x"; // c\n/* b */ let z`)).toBe(`const a = "http://x"; \n let z`);
  });
});

describe("Vue SFC imports", () => {
  const sfc = fx("UserCard.vue");
  it("extracts both <script> and <script setup> blocks", () => {
    expect(extractVueScripts(sfc)).toHaveLength(2);
  });
  it("finds imports across script blocks plus async components and <style src>", () => {
    expect(extractVueImports(sfc).sort()).toEqual(["./Avatar.vue", "./Chart.vue", "./card.css", "../types", "@/stores/user", "vue"].sort());
  });
  it("ignores template content", () => {
    expect(extractVueImports(`<template><p>import x from './t'</p></template>`)).toEqual([]);
  });
  it("handles <script src>", () => {
    expect(extractVueImports(`<template/><script src="./logic.ts"></script>`)).toEqual(["./logic.ts"]);
  });
});

describe("Go imports", () => {
  const src = fx("handler.go");
  it("parses grouped, aliased, blank, dot and single imports; ignores comments", () => {
    expect(extractGoImports(src).sort()).toEqual(
      ["context", "encoding/json", "github.com/acme/shop/internal/store", "github.com/acme/shop/internal/testutil", "github.com/acme/shop/pkg/money", "github.com/lib/pq", "net/http"].sort(),
    );
  });
  it("reads package name and top-level declarations (not methods)", () => {
    expect(goPackageName(src)).toBe("api");
    expect(goTopLevelDecls(src).sort()).toEqual(["DefaultTimeout", "Handler", "MaxItems", "NewHandler", "minItems"].sort());
  });
});

describe("Python imports", () => {
  const imps = extractPythonImports(fx("service.py"));
  const mods = imps.map((i) => i.module);
  it("parses import / import-as / comma lists", () => {
    expect(mods).toEqual(expect.arrayContaining(["os", "sys", "app.models.user", "__future__", "typing", "json"]));
  });
  it("parses from-imports with names, relative dots and parenthesised multi-line lists", () => {
    expect(imps).toEqual(
      expect.arrayContaining([
        { module: "app.models", names: ["order", "invoice"] },
        { module: ".", names: ["utils"] },
        { module: ".helpers", names: ["slugify", "normalize"] },
        { module: "..core.base", names: ["Base"] },
        { module: "app.schemas.user", names: ["UserSchema"] },
      ]),
    );
  });
  it("ignores comments and strings", () => {
    expect(mods).not.toContain("not_real");
    expect(mods).not.toContain("fake");
  });
});
