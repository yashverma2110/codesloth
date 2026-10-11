/** Path classes used by the risk rules. Pure. */

const MIGRATION_DIR = /(^|\/)(migrations?|migrate|db\/migrate|alembic\/versions|versions)(\/|$)/i;

const MIGRATION_TEXT = /\+goose\s+(Up|Down)|^\s*(down_)?revision\s*=|def\s+(upgrade|downgrade)\s*\(|migrations\.Migration\b|MigrationInterface|exports\.(up|down)\s*=|export\s+(async\s+)?function\s+(up|down)\b|class\s+\w+\s*<\s*ActiveRecord::Migration|gormigrate|golang-migrate/;

/**
 * Database migration file? SQL in a migrations dir counts; code files there need a numbered/timestamped
 * name or migration markers in `text` (so e.g. a "services/migrations" feature package doesn't).
 */
export function isMigration(path: string, text?: string): boolean {
  if (/(^|\/)prisma\/migrations\/[^/]+\/migration\.sql$/.test(path)) return true;
  if (/\.(up|down)\.sql$/i.test(path)) return true;
  if (!MIGRATION_DIR.test(path)) return false;
  if (/\.sql$/i.test(path)) return true;
  if (!/\.(py|js|ts|go|rb)$/i.test(path) || /(^|\/)(__init__|env)\.py$/.test(path)) return false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/^(\d{3,}|v\d+|[0-9a-f]{12}_)/i.test(name)) return true;
  return !!text && MIGRATION_TEXT.test(text);
}

export function isSqlFile(path: string): boolean {
  return /\.sql$/i.test(path);
}

export function isSchemaFile(path: string): boolean {
  return /(^|\/)(schema|structure)[^/]*\.sql$/i.test(path) || /(^|\/)schema\/[^/]+\.sql$/i.test(path);
}

/** sqlc / hand-written query files: .sql that isn't a migration or a schema. */
export function isQueryFile(path: string): boolean {
  return isSqlFile(path) && !isMigration(path) && !isSchemaFile(path);
}

export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|testdata|fixtures?|spec|e2e|mocks?)(\/|$)/i.test(path) || /(_test\.go|\.(test|spec)\.[cm]?[jt]sx?|(^|\/)test_[^/]+\.py|_test\.py)$/i.test(path);
}

export function isDocsPath(path: string): boolean {
  if (/(^|\/)(requirements|constraints)[^/]*\.txt$/i.test(path)) return false;
  return /\.(md|mdx|rst|txt|adoc)$/i.test(path) || /(^|\/)(docs?|docs_src|examples?|samples?)\//i.test(path);
}

/** Packages consumed outside this repo, by convention. Exported changes there get +1. */
export function isSharedPath(path: string, extra: string[] = []): boolean {
  return /(^|\/)(pkg|shared|libs?|packages\/[^/]+\/src|sdk|client)\//.test(path) || extra.some((p) => globMatch(p, path));
}

export function isConfigFile(path: string): boolean {
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|poetry\.lock|Cargo\.lock|composer\.lock|Pipfile\.lock|uv\.lock)$/.test(path)) return false;
  if (/(^|\/)(package\.json|tsconfig[^/]*\.json|openapi[^/]*|swagger[^/]*)$/i.test(path)) return false;
  return /\.(ya?ml|toml|ini|cfg|conf|properties|env)$/i.test(path) || /(^|\/)\.env(\.[\w-]+)?$/.test(path) || /(^|\/)(config|settings)[^/]*\.json$/i.test(path);
}

export function isK8s(path: string, text: string): boolean {
  return /\.(ya?ml)$/i.test(path) && (/(^|\/)(k8s|kube|kubernetes|helm|charts?|deploy(ment)?s?|manifests?)\//i.test(path) || /^\s*apiVersion:\s*\S+[\s\S]*^\s*kind:\s*\w+/m.test(text));
}

export function isLockfile(path: string): boolean {
  return /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|poetry\.lock|Pipfile\.lock|uv\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock)$/.test(path);
}

/** Minimal glob: ** = any dirs, * = any chars except /, ? = one char. */
export function globMatch(glob: string, path: string): boolean {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?");
  return new RegExp(`^${re}$`).test(path) || new RegExp(`^${re.replace(/\(\?:\.\*\/\)\?$/, ".*")}$`).test(path);
}
