import { describe, expect, it } from "vitest";
import { buildResolveContext, normalize, resolveGo, resolveJs, resolvePython } from "../src/engine/resolve";

describe("resolution", () => {
  const ctx = buildResolveContext(
    ["src/utils/format.ts", "src/components/Button/index.tsx", "src/api.ts", "src/stores/user.ts", "src/views/Home.vue", "packages/ui/src/theme.ts", "packages/ui/src/Card.vue", "lib/esm.ts",
     "internal/store/store.go", "internal/store/cache.go", "internal/store/store_test.go", "pkg/money/money.go", "cmd/api/main.go",
     "app/models/user.py", "app/models/__init__.py", "app/services/utils.py", "app/services/helpers.py", "src/pkg/core/base.py"],
    { "go.mod": "module github.com/acme/shop\n\ngo 1.22\n" },
  );
  it("normalizes paths", () => {
    expect(normalize("a/b/../c/./d")).toBe("a/c/d");
    expect(normalize("../x")).toBeNull();
  });
  it("resolves relative JS imports with extensions and index files", () => {
    expect(resolveJs("src/views/Home.vue", "../utils/format", ctx)).toBe("src/utils/format.ts");
    expect(resolveJs("src/views/Home.vue", "../components/Button", ctx)).toBe("src/components/Button/index.tsx");
    expect(resolveJs("lib/x.ts", "./esm.js", ctx)).toBe("lib/esm.ts");
  });
  it("resolves @/ alias to src/, including inside monorepo packages", () => {
    expect(resolveJs("src/views/Home.vue", "@/stores/user", ctx)).toBe("src/stores/user.ts");
    expect(resolveJs("packages/ui/src/Card.vue", "@/theme", ctx)).toBe("packages/ui/src/theme.ts");
  });
  it("leaves bare packages unresolved", () => {
    expect(resolveJs("src/api.ts", "react", ctx)).toBeUndefined();
  });
  it("resolves Go imports via go.mod to package files (excluding tests)", () => {
    expect(resolveGo("cmd/api/main.go", "github.com/acme/shop/internal/store", ctx).sort()).toEqual(["internal/store/cache.go", "internal/store/store.go"]);
    expect(resolveGo("cmd/api/main.go", "net/http", ctx)).toEqual([]);
  });
  it("resolves Go imports by path suffix when go.mod is unknown", () => {
    const c2 = buildResolveContext(["internal/store/store.go", "cmd/main.go"]);
    expect(resolveGo("cmd/main.go", "example.com/x/internal/store", c2)).toEqual(["internal/store/store.go"]);
  });
  it("resolves Python absolute, relative and from-package-import-module", () => {
    expect(resolvePython("app/services/user.py", { module: "app.models.user", names: [] }, ctx)).toEqual(["app/models/user.py"]);
    expect(resolvePython("app/services/user.py", { module: "app.models", names: ["user"] }, ctx).sort()).toEqual(["app/models/__init__.py", "app/models/user.py"]);
    expect(resolvePython("app/services/user.py", { module: ".", names: ["utils"] }, ctx)).toEqual(["app/services/utils.py"]);
    expect(resolvePython("app/services/user.py", { module: ".helpers", names: ["slugify"] }, ctx)).toEqual(["app/services/helpers.py"]);
    expect(resolvePython("src/pkg/api/views.py", { module: "pkg.core.base", names: ["Base"] }, ctx)).toEqual(["src/pkg/core/base.py"]);
    expect(resolvePython("app/x.py", { module: "os", names: [] }, ctx)).toEqual([]);
  });
});
