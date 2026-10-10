import type { Classification, Lang, PRFile } from "./types";
import { hasGeneratedMarker, isFormattingOnly } from "./patch";
import { matchGitAttributes, type GitAttributeRule } from "./glob";

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const lower = (s: string) => s.toLowerCase();

export function detectLang(path: string): Lang {
  const p = lower(path);
  if (/\.(m|c)?[jt]sx?$/.test(p)) return "js";
  if (p.endsWith(".vue")) return "vue";
  if (p.endsWith(".go")) return "go";
  if (p.endsWith(".py") || p.endsWith(".pyi")) return "python";
  return "other";
}

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "go.sum",
  "go.work.sum",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "pdm.lock",
  "cargo.lock",
  "gemfile.lock",
  "composer.lock",
]);

const GENERATED_PATTERNS: [RegExp, string][] = [
  [/\.min\.(js|css|mjs)$/, "minified asset"],
  [/\.map$/, "source map"],
  [/(^|\/)(dist|build|out|\.next|\.nuxt|coverage)\//, "build output directory"],
  [/(^|\/)(vendor|node_modules|third_party)\//, "vendored dependency directory"],
  [/\.pb\.go$|_pb2(_grpc)?\.pyi?$|\.pb\.(ts|js)$|_grpc\.pb\.go$/, "protobuf/gRPC generated code"],
  [/(^|[._-])generated\.[a-z]+$|\.gen\.[a-z]+$|_gen\.go$|(^|\/)__generated__\//, "generated file naming"],
  [/(^|\/)__snapshots__\/|\.snap$/, "test snapshot"],
  [/zz_generated[^/]*\.go$|mock_[^/]*\.go$|(^|\/)mocks?\/.*_mock\.go$/, "generated mocks/deepcopy"],
];

const TEST_PATTERNS: [RegExp, string][] = [
  [/\.(test|spec)\.[cm]?[jt]sx?$/, "Jest/Vitest test file (*.test / *.spec)"],
  [/\.(test|spec)\.vue$/, "Vue component test file"],
  [/\.cy\.[cm]?[jt]sx?$/, "Cypress test file"],
  [/_test\.go$/, "Go test file (*_test.go)"],
  [/(^|\/)test_[^/]*\.py$/, "Python test file (test_*.py)"],
  [/_test\.py$/, "Python test file (*_test.py)"],
  [/(^|\/)conftest\.py$/, "pytest conftest"],
  [/(^|\/)(__tests__|__mocks__)\//, "inside __tests__/__mocks__"],
  [/(^|\/)(tests?|spec|e2e|testdata|fixtures)\//, "inside a tests/ directory"],
];

const CONTRACT_PATTERNS: [RegExp, string][] = [
  [/\.proto$/, "protobuf schema"],
  [/\.(graphql|gql|graphqls)$/, "GraphQL schema/operation"],
  [/(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/, "OpenAPI/Swagger spec"],
  [/(^|\/)(alembic\/versions|db\/migrate)\/[^/]+$/, "database migration"],
  [/(^|\/)(migrations?|migrate)\/(.*\/)?(\d[^/]*|v\d[^/]*)\.[a-z]+$/, "database migration (versioned file in migrations/)"],
  [/\.sql$/, "SQL schema/query"],
  [/\.d\.[cm]?ts$/, "TypeScript declaration file"],
  [/(^|\/)(types|typings|interfaces|contracts)\/[^/]+\.[cm]?[jt]sx?$/, "inside a types/ directory"],
  [/(^|\/)types?\.[cm]?ts$|\.types\.[cm]?ts$/, "type definitions module"],
  [/(^|\/)schema(s)?(\.[a-z]+|\/)/, "schema definition"],
  [/\.(avsc|thrift)$|\.schema\.json$/, "data schema"],
];

const CONFIG_PATTERNS: [RegExp, string][] = [
  [/(^|\/)package\.json$/, "package manifest"],
  [/(^|\/)(go\.mod|go\.work)$/, "Go module manifest"],
  [/(^|\/)(requirements[^/]*\.txt|pyproject\.toml|setup\.(py|cfg)|pipfile|tox\.ini|\.python-version)$/, "Python packaging/config"],
  [/(^|\/)\.github\//, "GitHub workflow/config"],
  [/(^|\/)(dockerfile[^/]*|docker-compose[^/]*\.ya?ml|\.dockerignore)$/, "container config"],
  [/(^|\/)(makefile|justfile|procfile|\.editorconfig|\.nvmrc|\.npmrc|\.gitignore|\.gitattributes|codeowners)$/, "repo/tooling config"],
  [/(^|\/)(tsconfig|jsconfig)[^/]*\.json$/, "TypeScript/JS compiler config"],
  [/(^|\/)(vite|vitest|jest|webpack|rollup|babel|postcss|tailwind|eslint|prettier|nuxt|next|vue|svelte|playwright|cypress)\.config\.[a-z]+$/, "build/tool config"],
  [/(^|\/)\.(eslintrc|prettierrc|babelrc|stylelintrc|swcrc)[^/]*$/, "lint/format config"],
  [/(^|\/)(\.env[^/]*|.*\.env\.example)$/, "environment config"],
  [/\.(tf|tfvars|hcl)$/, "Terraform/infra"],
  [/(^|\/)(locales?|i18n|translations|lang)\/[^/]+\.(json|ya?ml|po|pot|properties|ini|toml|arb|xliff|xlf)$/, "localization strings"],
  [/\.(json|jsonc|json5)$/, "JSON data/config"],
  [/(^|\/)(helm|charts|k8s|kubernetes|deploy|deployment|infra|ops)\/(?!.*\.([cm]?[jt]sx?|vue|go|py)$)/, "deployment/infra config"],
  [/\.(ya?ml|toml|ini|cfg|conf)$/, "configuration file"],
];

const DOCS_STRONG: [RegExp, string][] = [
  [/\.(md|mdx|rst|adoc)$/, "documentation"],
  [/(^|\/)(license|licence|notice|authors|contributors)(\.[a-z]+)?$/, "license/notice"],
];
const DOCS_WEAK: [RegExp, string][] = [
  [/(^|\/)(docs?|documentation)\//, "inside docs/"],
  [/\.txt$/, "text document"],
  [/^(docs_src|examples?|samples?)\//, "example/documentation code (top-level examples dir)"],
];

const ASSET_RE = /\.(png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|otf|mp4|webm|mp3|wav|pdf)$/;

export interface ClassifyContext {
  gitattributes?: GitAttributeRule[];
  /** Head content (full or partial) for generated-marker detection. */
  content?: string;
}

export function classifyFile(f: PRFile, ctx: ClassifyContext = {}): Classification {
  const path = f.filename;
  const p = lower(path);
  const b = base(p);

  // 1) Mechanical
  if (f.status === "renamed" && f.changes === 0) {
    return { category: "mechanical", kind: "rename-only", reason: `pure rename from ${f.previous_filename ?? "?"} (no content change)` };
  }
  if (f.status === "copied" && f.changes === 0) {
    return { category: "mechanical", kind: "copy-only", reason: `pure copy of ${f.previous_filename ?? "?"}` };
  }

  // 2) Generated (gitattributes first: it is the repo's own declaration)
  if (ctx.gitattributes?.length) {
    const m = matchGitAttributes(ctx.gitattributes, path);
    if (m.generated) return { category: "generated", kind: "linguist-generated", reason: `.gitattributes marks "${m.generated.pattern}" as linguist-generated` };
    if (m.vendored) return { category: "generated", kind: "linguist-vendored", reason: `.gitattributes marks "${m.vendored.pattern}" as linguist-vendored` };
  }
  if (LOCKFILES.has(b)) return { category: "generated", kind: "lockfile", reason: `dependency lockfile (${base(path)})` };
  for (const [re, why] of GENERATED_PATTERNS) if (re.test(p)) return { category: "generated", kind: "pattern", reason: why };
  const marker = hasGeneratedMarker(ctx.content);
  if (marker) return { category: "generated", kind: "marker", reason: marker };

  // 3) Formatting-only (only meaningful for modified files)
  if (f.status === "modified" && f.patch && isFormattingOnly(f.patch)) {
    return { category: "mechanical", kind: "formatting-only", reason: "whitespace/formatting-only change (same tokens before and after)" };
  }

  // 4) Tests
  for (const [re, why] of TEST_PATTERNS) if (re.test(p)) return { category: "test", reason: why };

  // 5) Contracts
  for (const [re, why] of CONTRACT_PATTERNS) if (re.test(p)) return { category: "contract", reason: why };

  // 6) Docs (markdown first so README.md under deploy/ is docs), then config, then weak docs signals
  for (const [re, why] of DOCS_STRONG) if (re.test(p)) return { category: "docs", reason: why };

  // 7) Config
  for (const [re, why] of CONFIG_PATTERNS) if (re.test(p)) return { category: "config", reason: why };
  for (const [re, why] of DOCS_WEAK) if (re.test(p)) return { category: "docs", reason: why };

  if (ASSET_RE.test(p)) return { category: "docs", kind: "asset", reason: "static asset (image/font/media)" };

  // 8) Source
  return { category: "source", reason: "source code" };
}
