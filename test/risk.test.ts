import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { analyzeRisk, dismissKey, parseRiskConfig, riskByFile, visibleFindings, DEFAULT_RISK_PREFS, normalizeRiskPrefs } from "../src/engine/risk";
import type { Finding, RiskInput } from "../src/engine/risk/types";
import { parseHunks } from "../src/engine/risk/hunks";
import { globMatch, isMigration } from "../src/engine/risk/paths";
import { goParamTypes } from "../src/engine/risk/code";
import { parseYaml } from "../src/engine/risk/yaml";
import { uniqueMatching } from "../src/engine/risk/sql";
import { analyze } from "../src/engine/analyze";
import type { PRFile } from "../src/engine/types";
import { pf, plus } from "./fixtures/risk/helpers";
import { RED_PR } from "./fixtures/risk/red-pr";

const run = (files: PRFile[], extra: Partial<RiskInput> = {}) => analyzeRisk({ files, ...extra });
const rules = (files: PRFile[], extra: Partial<RiskInput> = {}) => run(files, extra).findings;
const has = (fs: Finding[], rule: string, sev?: Finding["severity"]) => fs.filter((f) => f.rule === rule && (!sev || f.severity === sev));
const one = (fs: Finding[], rule: string) => {
  const m = fs.filter((f) => f.rule === rule);
  expect(m, `${rule} in ${JSON.stringify(fs.map((f) => f.rule))}`).toHaveLength(1);
  return m[0];
};
const MIG = "db/migrations/005_change.sql";
const baseSchema = { "db/schema.sql": 'CREATE TABLE users (id BIGINT PRIMARY KEY, email TEXT);\nCREATE TABLE "quotaBudgets" (budget_id UUID PRIMARY KEY, user_id TEXT, CONSTRAINT quota_budgets_identity UNIQUE (user_id));' };

describe("hunks", () => {
  it("numbers lines on both sides and keeps the hunk section", () => {
    const [h] = parseHunks("@@ -10,3 +10,4 @@ func X() {\n a\n-b\n+c\n+d\n e");
    expect(h.section).toBe("func X() {");
    expect(h.lines.map((l) => [l.kind, l.old, l.new])).toEqual([[" ", 10, 10], ["-", 11, undefined], ["+", undefined, 11], ["+", undefined, 12], [" ", 12, 13]]);
  });
});

describe("paths", () => {
  it("migration detection needs a numbered name or markers for code files", () => {
    expect(isMigration("db/migrations/001_init.sql")).toBe(true);
    expect(isMigration("x/001.up.sql")).toBe(true);
    expect(isMigration("models/migrations/v1_22/v283.go")).toBe(true);
    expect(isMigration("services/migrations/github.go")).toBe(false);
    expect(isMigration("alembic/versions/abc.py", "revision = 'abc'\ndef upgrade():")).toBe(true);
    expect(isMigration("src/migrations/index.ts")).toBe(false);
  });
  it("globs", () => {
    expect(globMatch("repository/**", "repository/db/x.go")).toBe(true);
    expect(globMatch("**/testdata/**", "a/b/testdata/c.sql")).toBe(true);
    expect(globMatch("mocks/*.go", "mocks/a.go")).toBe(true);
    expect(globMatch("mocks/*.go", "mocks/x/a.go")).toBe(false);
  });
});

describe("SQL and migrations", () => {
  it("sql.drop-table / drop-column / rename are red; additive DDL isn't", () => {
    const fs = rules([pf(MIG, "added", plus('DROP TABLE legacy;\nALTER TABLE users DROP COLUMN email;\nALTER TABLE users RENAME COLUMN name TO full_name;\nALTER TABLE users ADD COLUMN nick TEXT;'))]);
    expect(one(fs, "sql.drop-table").severity).toBe("high");
    expect(one(fs, "sql.drop-column")).toMatchObject({ severity: "high", line: { side: "R", n: 2 } });
    expect(one(fs, "sql.rename").severity).toBe("high");
    expect(rules([pf(MIG, "added", plus("ALTER TABLE users ADD COLUMN nick TEXT;\nALTER TABLE users DROP CONSTRAINT IF EXISTS x;"))]).filter((f) => f.severity === "high")).toEqual([]);
  });
  it("sql.alter-type: narrowing red, widening amber", () => {
    expect(one(rules([pf(MIG, "added", plus("ALTER TABLE users ALTER COLUMN age TYPE SMALLINT;"))]), "sql.alter-type").severity).toBe("high");
    expect(one(rules([pf(MIG, "added", plus("ALTER TABLE users ALTER COLUMN id TYPE BIGINT;"))]), "sql.alter-type").severity).toBe("medium");
  });
  it("sql.not-null-no-default: red on existing tables, not with a default or on a new table", () => {
    expect(one(rules([pf(MIG, "added", plus("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL;"))], { baseContents: baseSchema }), "sql.not-null-no-default").severity).toBe("high");
    expect(has(rules([pf(MIG, "added", plus("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';"))]), "sql.not-null-no-default")).toEqual([]);
    expect(has(rules([pf(MIG, "added", plus("CREATE TABLE t (id INT);\nALTER TABLE t ADD COLUMN plan TEXT NOT NULL;"))]), "sql.not-null-no-default")).toEqual([]);
  });
  it("sql.unique-added / index-dropped / index-blocking", () => {
    const fs = rules([pf(MIG, "added", plus("CREATE UNIQUE INDEX u ON users (email);\nDROP INDEX old_idx;\nCREATE INDEX i ON users (email);"))]);
    expect(one(fs, "sql.unique-added").severity).toBe("medium");
    expect(one(fs, "sql.index-dropped").severity).toBe("medium");
    expect(one(fs, "sql.index-blocking").severity).toBe("medium");
    expect(has(rules([pf(MIG, "added", plus("CREATE INDEX CONCURRENTLY i ON users (email);\nCREATE TABLE n (id INT);\nCREATE INDEX j ON n (id);"))]), "sql.index-blocking")).toEqual([]);
  });
  it("sql.fk-added: amber on existing tables, low for a new table, none with NOT VALID", () => {
    expect(one(rules([pf(MIG, "added", plus("ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users (id);"))]), "sql.fk-added").severity).toBe("medium");
    expect(one(rules([pf(MIG, "added", plus('CREATE TABLE "quotaTransactions" (id UUID, budget_id UUID REFERENCES "quotaBudgets" (budget_id));'))]), "sql.fk-added")).toMatchObject({ severity: "low", title: "New table references existing quotaBudgets" });
    expect(has(rules([pf(MIG, "added", plus("ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users (id) NOT VALID;"))]), "sql.fk-added")).toEqual([]);
  });
  it("sql.unsafe-dml vs a guarded write (sql.data-write-existing)", () => {
    expect(one(rules([pf("db/queries.sql", "added", plus("-- name: Wipe :exec\nDELETE FROM users;"))]), "sql.unsafe-dml").severity).toBe("high");
    const g = rules([pf("db/queries.sql", "modified", plus('-- name: Use :exec\nUPDATE "quotaBudgets" SET consumed = consumed + $2 WHERE budget_id = $1 AND consumed + $2 <= limit;'))]);
    expect(has(g, "sql.unsafe-dml")).toEqual([]);
    expect(one(g, "sql.data-write-existing").severity).toBe("medium");
    expect(has(rules([pf("db/queries.sql", "modified", plus("CREATE TABLE t (id INT);\nUPDATE t SET id = 2 WHERE id = 1;"))]), "sql.data-write-existing")).toEqual([]);
  });
  it("sql.on-conflict-target: passes against the schema, flags a missing unique", () => {
    const ok = run([pf("db/queries.sql", "modified", plus('INSERT INTO "quotaBudgets" (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id;'))], { baseContents: baseSchema });
    expect(ok.passed.map((p) => p.text)).toContain("ON CONFLICT target matches quota_budgets_identity on quotaBudgets");
    expect(one(ok.findings, "sql.data-write-existing").title).toBe("Upsert into an existing table");
    const bad = rules([pf("db/queries.sql", "modified", plus("INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING;"))], { baseContents: baseSchema });
    expect(one(bad, "sql.on-conflict-target").severity).toBe("medium");
    expect(uniqueMatching("CREATE TABLE a (x INT, y INT, PRIMARY KEY (y, x));", "a", ["x", "y"])).toBe(true);
    expect(uniqueMatching("", "a", ["x"])).toBeNull();
  });
  it("sql.query-changed: result kind or body changes, not untouched queries", () => {
    const f = rules([pf("db/queries.sql", "modified", [" -- name: GetUser :one", "-SELECT id, email FROM users WHERE id = $1;", "+SELECT id FROM users WHERE id = $1;", " ", " -- name: Other :many", " SELECT 1;"])]);
    expect(one(f, "sql.query-changed").title).toBe("Changes query GetUser");
    const k = rules([pf("db/queries.sql", "modified", ["--- name: GetUser :one", "+-- name: GetUser :many", " SELECT id FROM users WHERE id = $1;"])]);
    expect(one(k, "sql.query-changed").why).toMatch(/:one → :many/);
    expect(has(rules([pf("db/queries.sql", "modified", [" -- name: GetUser :one", " SELECT id FROM users;", "+-- name: New :one", "+SELECT 1;"])]), "sql.query-changed")).toEqual([]);
  });
  it("sql.migration-edited: red for modified/removed/renamed migrations, not new ones", () => {
    expect(one(rules([pf("db/migrations/001_init.sql", "modified", [" CREATE TABLE a (id INT);", "+CREATE INDEX i ON a (id);"])]), "sql.migration-edited").severity).toBe("high");
    expect(one(rules([pf("db/migrations/001_init.sql", "removed", ["-CREATE TABLE a (id INT);"])]), "sql.migration-edited").title).toMatch(/Deletes/);
    expect(has(rules([pf("db/migrations/009_new.sql", "added", plus("CREATE TABLE a (id INT);"))]), "sql.migration-edited")).toEqual([]);
  });
  it("sql.migration-order against the base listing", () => {
    const f = rules([pf("db/migrations/003_x.sql", "added", plus("SELECT 1;"))], { baseDirs: { "db/migrations": ["001_a.sql", "004_b.sql"] } });
    expect(one(f, "sql.migration-order").severity).toBe("medium");
    expect(has(rules([pf("db/migrations/005_x.sql", "added", plus("SELECT 1;"))], { baseDirs: { "db/migrations": ["001_a.sql", "004_b.sql"] } }), "sql.migration-order")).toEqual([]);
  });
  it("sql.down-missing: goose, .up.sql and alembic", () => {
    expect(has(rules([pf("db/migrations/006_x.sql", "added", plus("-- +goose Up\nCREATE TABLE t (id INT);"))]), "sql.down-missing")).toHaveLength(1);
    expect(has(rules([pf("db/migrations/006_x.sql", "added", plus("-- +goose Up\nCREATE TABLE t (id INT);\n-- +goose Down\nDROP TABLE t;"))]), "sql.down-missing")).toEqual([]);
    expect(has(rules([pf("db/migrations/006_x.up.sql", "added", plus("CREATE TABLE t (id INT);"))]), "sql.down-missing")).toHaveLength(1);
    expect(has(rules([pf("db/migrations/006_x.up.sql", "added", plus("CREATE TABLE t (id INT);")), pf("db/migrations/006_x.down.sql", "added", plus("DROP TABLE t;"))]), "sql.down-missing")).toEqual([]);
    expect(has(rules([pf("alembic/versions/1a2b3c4d5e6f_x.py", "added", plus("revision = '1a2b'\ndef upgrade():\n    op.add_column('t', sa.Column('x', sa.Text()))\n\ndef downgrade():\n    pass\n"))]), "sql.down-missing")).toHaveLength(1);
  });
  it("schema.sql DDL is checked in the migrations when the PR has both", () => {
    const r = run([pf("db/schema.sql", "modified", plus("ALTER TABLE users DROP COLUMN email;")), pf("db/migrations/007_x.sql", "added", plus("SELECT 1;"))]);
    expect(has(r.findings, "sql.drop-column")).toEqual([]);
    expect(r.passed.map((p) => p.rule)).toContain("sql.schema-mirror");
    expect(has(rules([pf("db/schema.sql", "modified", plus("ALTER TABLE users DROP COLUMN email;"))]), "sql.drop-column")).toHaveLength(1);
  });
  it("destructive SQL inside code strings", () => {
    expect(has(rules([pf("svc/cleanup.go", "modified", ['+  _, err := db.Exec(ctx, `DELETE FROM sessions`)'])]), "sql.unsafe-dml", "high")).toHaveLength(1);
    expect(has(rules([pf("svc/cleanup.go", "modified", ['+  _, err := db.Exec(ctx, "SELECT * FROM sessions")'])]), "sql.unsafe-dml")).toEqual([]);
  });
});

describe("config, env, infra, deps", () => {
  it("cfg.key-removed / renamed / default-changed / flag-changed", () => {
    const f = rules([pf("config/app.yaml", "modified", [" server:", "-  timeout: 5s", "+  timeout: 30s", "-  colour: red", "+  color: red", "-  legacyMode: true", " features:", "-  newCheckout: false", "+  newCheckout: true", "-  banner: hi", "+  banner: hello"])]);
    expect(one(f, "cfg.key-removed").title).toBe("Removes server.legacyMode");
    expect(one(f, "cfg.key-renamed").title).toBe("Renames server.colour → color");
    expect(has(f, "cfg.default-changed", "medium")[0].title).toBe("Changes server.timeout");
    expect(has(f, "cfg.default-changed", "low")[0].title).toBe("Changes features.banner");
    expect(one(f, "cfg.flag-changed").severity).toBe("medium");
    expect(rules([pf("config/app.yaml", "modified", [" server:", "+  extra: 1"])])).toEqual([]);
  });
  it("a removed key still read by code in the PR is red", () => {
    const f = rules([pf("config/app.yaml", "modified", [" db:", "-  queryTimeout: 5s"]), pf("cfg.go", "modified", ['  t := viper.GetDuration("db.queryTimeout")', "+ x()"])]);
    expect(one(f, "cfg.key-removed").severity).toBe("high");
  });
  it(".env, TOML and JSON config", () => {
    expect(one(rules([pf(".env.example", "modified", ["-API_URL=http://x", "+API_BASE=http://x"])]), "cfg.key-renamed").title).toContain("API_BASE");
    expect(one(rules([pf("settings.toml", "modified", [" [db]", "-pool = 5", "+pool = 50"])]), "cfg.default-changed").title).toBe("Changes db.pool");
    expect(one(rules([pf("config/settings.json", "modified", ['   "retries": 3,', '-  "maxBatch": 10', '+  "maxBatch": 100'])]), "cfg.default-changed").severity).toBe("medium");
  });
  it("cfg.env-renamed / env-added / env-removed", () => {
    expect(one(rules([pf("main.go", "modified", ['-  u := os.Getenv("DB_URL")', '+  u := os.Getenv("DATABASE_URL")'])]), "cfg.env-renamed").severity).toBe("medium");
    expect(one(rules([pf("app.py", "modified", ['+key = os.environ["STRIPE_KEY"]'])]), "cfg.env-added").severity).toBe("medium");
    expect(one(rules([pf("app.py", "modified", ['+key = os.getenv("FEATURE_X")'])]), "cfg.env-added").severity).toBe("low");
    expect(one(rules([pf("app.ts", "modified", ['+const p = process.env.PORT ?? "3000"'])]), "cfg.env-added").why).toMatch(/default/);
    expect(one(rules([pf("main.go", "modified", ['-  x := os.Getenv("OLD_FLAG")', "+  x := true"])]), "cfg.env-removed").severity).toBe("low");
    expect(rules([pf("main.go", "modified", ['-  private.Use(Auth(common.GetConfigEnv("AUTH_SERVER")))', '+  auth := Auth(common.GetConfigEnv("AUTH_SERVER"))'])]).filter((f) => f.rule.startsWith("cfg.env"))).toEqual([]);
  });
  it("infra: k8s, Dockerfile, terraform, CI", () => {
    const k = rules([pf("deploy/app.yaml", "modified", [" spec:", "   template:", "     containers:", "-      image: app:1.2", "+      image: app:2.0"])]);
    expect(one(k, "infra.k8s").severity).toBe("medium");
    expect(one(rules([pf("Dockerfile", "modified", ["-FROM node:18", "+FROM node:22"])]), "infra.docker").title).toBe("Changes FROM");
    expect(rules([pf("Dockerfile", "modified", [" FROM node:18", "+RUN npm ci"])])).toEqual([]);
    expect(one(rules([pf("infra/main.tf", "modified", ['-resource "aws_s3_bucket" "logs" {', "-  bucket = \"x\"", "-}"])]), "infra.terraform").severity).toBe("high");
    expect(rules([pf("infra/main.tf", "modified", ['-resource "aws_s3_bucket" "logs" {', '+resource "aws_s3_bucket" "audit" {', "+moved {"])])).toEqual([]);
    expect(one(rules([pf(".github/workflows/ci.yml", "modified", [" permissions:", "-  contents: read", "+  contents: write"])]), "infra.ci").severity).toBe("medium");
  });
  it("deps.major / removed / engine / lockfile-only", () => {
    const f = rules([pf("package.json", "modified", ['   "dependencies": {', '-    "express": "^4.18.2",', '+    "express": "^5.0.0",', '-    "lodash": "^4.17.0",', '+    "lodash": "^4.18.0",', '-    "left-pad": "1.0.0"', '   "engines": {', '-    "node": ">=18"', '+    "node": ">=20"'])]);
    expect(one(f, "deps.major").title).toBe("Major upgrade: express 4 → 5");
    expect(one(f, "deps.removed").severity).toBe("low");
    expect(one(f, "deps.engine").severity).toBe("medium");
    expect(one(rules([pf("go.mod", "modified", ["-\tgithub.com/redis/go-redis/v8 v8.11.5", "+\tgithub.com/redis/go-redis/v9 v9.5.1"])]), "deps.major").title).toContain("8 → 9");
    expect(one(rules([pf("requirements.txt", "modified", ["-pydantic==1.10.2", "+pydantic==2.6.0"])]), "deps.major").severity).toBe("medium");
    expect(one(rules([pf("package-lock.json", "modified", ["-x", "+y"])]), "deps.lockfile-only").severity).toBe("low");
    expect(has(rules([pf("package-lock.json", "modified", ["-x", "+y"]), pf("package.json", "modified", ['+    "a": "1.0.0"'])]), "deps.lockfile-only")).toEqual([]);
  });
});

describe("data layer", () => {
  it("goParamTypes drops names and expands grouped params", () => {
    expect(goParamTypes("primaryConn, secondaryConn *sql.DB, queryTimeout time.Duration")).toEqual(["*sql.DB", "*sql.DB", "time.Duration"]);
    expect(goParamTypes("context.Context, string")).toEqual(["context.Context", "string"]);
    expect(goParamTypes("ctx context.Context, fn func(a, b int) error")).toEqual(["context.Context", "func(a,bint)error"]);
  });
  it("dal.sig-changed (Go): amber in the data layer, low elsewhere, nothing for a param rename", () => {
    const p = (path: string, a: string, b: string) => pf(path, "modified", [`-func NewDatabase(${a}) Database {`, `+func NewDatabase(${b}) Database {`, "   return nil"]);
    expect(one(rules([p("repository/database.go", "conn *sql.DB", "pg *resources.Postgres")]), "dal.sig-changed").severity).toBe("medium");
    expect(one(rules([p("app/app.go", "conn *sql.DB", "pg *resources.Postgres")]), "dal.sig-changed").severity).toBe("low");
    expect(has(rules([p("repository/database.go", "conn *sql.DB", "db *sql.DB")]), "dal.sig-changed")).toEqual([]);
    expect(one(rules([p("pkg/store/database.go", "conn *sql.DB", "pg *resources.Postgres")]), "dal.sig-changed").severity).toBe("high");
  });
  it("dal.sig-changed across a multi-line signature", () => {
    const f = rules([pf("repository/repo.go", "modified", [" func (r *Repo) Get(", "   ctx context.Context,", "-  id int64,", "+  id string,", " ) (*User, error) {"])]);
    expect(one(f, "dal.sig-changed").excerpt).toContain("→");
  });
  it("dal.removed, unless moved to another file in the PR", () => {
    expect(one(rules([pf("repository/a.go", "modified", ["-func Delete(id string) error {", "-  return nil", "-}"])]), "dal.removed").severity).toBe("medium");
    expect(has(rules([pf("repository/a.go", "modified", ["-func Delete(id string) error {", "-}"]), pf("repository/b.go", "modified", ["+func Delete(id string) error {", "+}"])]), "dal.removed")).toEqual([]);
  });
  it("dal.interface: gains/loses methods (header in the hunk section or in the hunk)", () => {
    const f = rules([pf("repository/database.go", "modified", ["@@ type Database interface {", "   Querier() db.Querier", "+  WriteTransaction(context.Context, func(context.Context, db.Querier) error) error", " }"])]);
    expect(one(f, "dal.interface").title).toBe("Interface Database gains WriteTransaction");
    expect(one(rules([pf("repository/database.go", "modified", [" type Store interface {", "-  Close() error", " }"])]), "dal.interface").title).toBe("Interface Store loses Close");
    expect(has(rules([pf("repository/database.go", "modified", [" type Store interface {", "-  Ping(context.Context) error", "+  Ping(ctx context.Context) error", " }"])]), "dal.interface")).toEqual([]);
  });
  it("dal.field-changed and dal.tag-changed", () => {
    const f = rules([pf("domain/user.go", "modified", [" type User struct {", '-  Email string `json:"email"`', '-  Name  string `json:"name"`', '+  Name  string `json:"fullName"`', '-  Age   int    `json:"age"`', '+  Age   int    `json:"age,omitempty"`', " }"])]);
    expect(one(f, "dal.field-changed").title).toBe("Removes field User.Email");
    expect(has(f, "dal.tag-changed", "high")[0].title).toBe('json tag on User.Name: "name" → "fullName"');
    expect(has(f, "dal.tag-changed", "medium")).toHaveLength(1);
    expect(rules([pf("svc/a.go", "modified", ["@@ type CodebaseDownloader struct {", '   if username != "" {', "-    return proxy.Proxy()(req)", "+    return transport.RoundTrip(req)", "   }"])])).toEqual([]);
  });
  it("Python: removed public def and new required params; defaults are fine", () => {
    expect(one(rules([pf("app/repository/users.py", "modified", ["-def get_user(user_id):", "+def get_user(user_id, tenant):", "     pass"])]), "dal.sig-changed").severity).toBe("medium");
    expect(has(rules([pf("app/repository/users.py", "modified", ["-def get_user(user_id):", "+def get_user(user_id, tenant=None):"])]), "dal.sig-changed")).toEqual([]);
    expect(one(rules([pf("app/repository/users.py", "modified", ["-def delete_user(user_id):", "-    pass"])]), "dal.removed").severity).toBe("medium");
  });
  it("Python blast radius: 3+ importers raises amber to red", () => {
    const files = [pf("app/repository/users.py", "modified", ["-def get_user(user_id):", "+def get_user(user_id, tenant):"])];
    const f = rules(files, { importers: { "app/repository/users.py": 3 } });
    expect(one(f, "dal.sig-changed")).toMatchObject({ severity: "high" });
    expect(one(f, "dal.sig-changed").adjust?.[0]).toMatch(/3 changed files import it/);
  });
  it("SQLAlchemy / Django / Pydantic", () => {
    expect(one(rules([pf("app/models.py", "modified", ["-    email = Column(String)"])]), "orm.sqlalchemy").severity).toBe("high");
    expect(one(rules([pf("app/models.py", "modified", ["-    email = Column(String)", "+    email = Column(String, nullable=False)"])]), "orm.sqlalchemy").severity).toBe("medium");
    expect(one(rules([pf("shop/models.py", "modified", ["-    sku = models.CharField(max_length=20)"])]), "orm.django").severity).toBe("high");
    expect(one(rules([pf("api/schemas.py", "modified", [" class Item(BaseModel):", "     id: int", "-    price: float"])]), "orm.pydantic").severity).toBe("medium");
    expect(rules([pf("app/models.py", "modified", ["+    nick = Column(String)"])])).toEqual([]);
  });
  it("JS/TS: removed exports (shared red, TS low), moves ignored, data-layer signature change", () => {
    expect(one(rules([pf("packages/sdk/src/client.ts", "modified", ["-export function fetchUser(id: string) {"])]), "api.export").severity).toBe("high");
    expect(one(rules([pf("src/utils/a.ts", "modified", ["-export const X = 1;"])]), "api.export").severity).toBe("low");
    expect(has(rules([pf("src/utils/a.ts", "modified", ["-export const X = 1;"]), pf("src/utils/b.ts", "modified", ["+export const X = 1;"])]), "api.export")).toEqual([]);
    expect(one(rules([pf("src/repositories/user.repository.ts", "modified", ["-export async function findUser(id: string) {", "+export async function findUser(id: string, tenant: string) {"])]), "dal.sig-changed").severity).toBe("medium");
  });
  it("Prisma / TypeORM / Mongoose / Sequelize", () => {
    const p = rules([pf("prisma/schema.prisma", "modified", [" model User {", "   id    Int     @id", "-  email String?", "+  email String", "-  name  String", "-  nick  String", '+  nick  String  @unique', " }"])]);
    expect(has(p, "orm.prisma", "high").map((f) => f.title)).toEqual(["User.email becomes required", "Removes User.name"]);
    expect(has(p, "orm.prisma", "medium")[0].title).toBe("User.nick becomes unique");
    expect(one(rules([pf("src/entities/user.entity.ts", "modified", [" @Entity()", " export class User {", "   @Column()", "-  email: string;", " }"])]), "orm.typeorm").severity).toBe("high");
    expect(has(rules([pf("src/models/user.js", "modified", [" const s = new Schema({", "-  name: String,", "+  email: { type: String, required: true },"])]), "orm.mongoose").map((f) => f.title)).toEqual(["Field becomes required", "Removes model field name"]);
    expect(has(rules([pf("src/models/user.js", "modified", [" const User = sequelize.define('User', {", "-  email: { type: DataTypes.STRING },", "+  email: { type: DataTypes.STRING, allowNull: false },"])]), "orm.sequelize", "medium")).toHaveLength(1);
  });
});

describe("API contracts", () => {
  const http = (lines: string[]) => pf("app/http.go", "modified", lines, { start: 118 });
  it("api.route: removed red, new public amber, other new routes low", () => {
    const f = rules([http(['   public := router.Group("/v1/public")', '-  public.DELETE("/allocation/:id", h)', '+  public.POST("/reserve", h)', '+  private.GET("/status", h)'])]);
    expect(has(f, "api.route", "high")[0].title).toBe("Removes route DELETE /v1/public/allocation/:id");
    expect(has(f, "api.route", "medium")[0].title).toBe("New public route POST /v1/public/reserve");
    expect(has(f, "api.route", "low")[0].title).toBe("New route GET /status");
    expect(has(rules([http(['-  private.GET("/status", h)', '+  private.GET("/status", h2)'])]), "api.route")).toEqual([]);
  });
  it("resolves group prefixes from the file's head contents", () => {
    const f = rules([http(['+  public.POST("/commit", h)'])], { contents: { "app/http.go": 'public := router.Group("/v1/public")\npublic.POST("/commit", h)' } });
    expect(one(f, "api.route").title).toBe("New public route POST /v1/public/commit");
  });
  it("api.middleware: added amber; an inlined variable isn't a change; removing auth is red", () => {
    const f = rules([http(["-  private.Use(middlewares.Auth(cfg))", "+  auth := middlewares.Auth(cfg)", "+  private.Use(auth)", '+  public := router.Group("/v1/public")', "+  public.Use(auth)"])]);
    expect(one(f, "api.middleware").title).toBe("Adds middleware to /v1/public group");
    expect(one(rules([http(["-  private.Use(middlewares.Auth(cfg))"])]), "api.middleware").severity).toBe("high");
  });
  it("FastAPI / Flask / Express / Nest routes", () => {
    expect(one(rules([pf("app/main.py", "modified", ['-@app.get("/items/{id}")', "-def read(id): ..."])]), "api.route").title).toBe("Removes route GET /items/{id}");
    expect(one(rules([pf("app/views.py", "modified", ['-@app.route("/login", methods=["POST"])'])]), "api.route").title).toBe("Removes route POST /login");
    expect(one(rules([pf("src/routes.js", "modified", ["-router.delete('/users/:id', del)"])]), "api.route").severity).toBe("high");
    expect(one(rules([pf("src/users.controller.ts", "modified", ["-  @Get(':id')"])]), "api.route").title).toBe("Removes route GET /:id");
  });
  it("api.proto: removed field (reserved or not), number change, rpc removal", () => {
    const f = rules([pf("api/quota.proto", "modified", [" message Budget {", "   string id = 1;", "-  int64 consumed = 2;", " }", " service Quota {", "-  rpc Delete(DeleteReq) returns (DeleteRes);", " }"])]);
    expect(has(f, "api.proto", "high").map((x) => x.title)).toEqual(["Removes Budget.consumed (= 2)", "Removes rpc Delete"]);
    expect(one(rules([pf("api/quota.proto", "modified", [" message Budget {", "-  int64 consumed = 2;", "+  reserved 2;", " }"])]), "api.proto").severity).toBe("medium");
    expect(one(rules([pf("api/quota.proto", "modified", [" message Budget {", "-  int64 consumed = 2;", "+  int64 consumed = 5;", " }"])]), "api.proto").title).toContain("field number 2 → 5");
    expect(rules([pf("api/quota.proto", "modified", [" message Budget {", "+  int64 extra = 9;", " }"])])).toEqual([]);
  });
  it("api.graphql: removed field red; input made required red", () => {
    expect(one(rules([pf("schema.graphql", "modified", [" type User {", "   id: ID!", "-  email: String", " }"])]), "api.graphql").severity).toBe("high");
    expect(one(rules([pf("schema.graphql", "modified", [" input NewUser {", "-  email: String", "+  email: String!", " }"])]), "api.graphql").severity).toBe("high");
    expect(rules([pf("schema.graphql", "modified", [" type User {", "+  nick: String", " }"])])).toEqual([]);
  });
  it("api.openapi: removed path and newly required field", () => {
    const f = rules([pf("api/openapi.yaml", "modified", [" openapi: 3.0.0", " paths:", "-  /users/{id}:", "-    get:", "@@", "     User:", "       required:", "         - id", "+        - email"])]);
    expect(has(f, "api.openapi", "high").map((x) => x.title)).toEqual(expect.arrayContaining(["Removes path /users/{id}", "Makes email required"]));
  });
  it("api.export: package.json main/exports change", () => {
    expect(one(rules([pf("package.json", "modified", ['-  "main": "dist/index.js",', '+  "main": "dist/index.cjs",'])]), "api.export").severity).toBe("medium");
  });
});

describe("adjustments and config", () => {
  it("generated files drop to low and point at their source", () => {
    const files = [
      pf("repository/db/querier.go", "modified", [" // Code generated by sqlc. DO NOT EDIT.", " type Querier interface {", "+  NewQuery(ctx context.Context) error", " }"], { start: 1 }),
      pf("repository/sql/queries.sql", "modified", [" -- name: X :one", " SELECT 1;"]),
    ];
    const f = one(rules(files), "dal.interface");
    expect(f.severity).toBe("low");
    expect(f.adjust).toEqual(["Generated file: review queries.sql instead."]);
  });
  it("tests and docs are skipped", () => {
    expect(rules([pf("repository/db_test.go", "modified", ["-func Delete(id string) error {"]), pf("docs/api.md", "modified", ["-DROP TABLE x;"])])).toEqual([]);
  });
  it(".codesloth.yml: rule off/severity, ignore, sensitivity; a PR changing it is flagged", () => {
    const cfg = `risk:\n  sensitivity: strict\n  paths:\n    ignore: ["legacy/**"]\n  rules:\n    sql.index-blocking: off\n    sql.unique-added: { severity: high }\n`;
    const r = run([pf(MIG, "added", plus("CREATE INDEX i ON users (email);\nCREATE UNIQUE INDEX u ON users (email);")), pf("legacy/m/001.sql", "modified", plus("DROP TABLE x;"))], { configText: cfg });
    expect(has(r.findings, "sql.index-blocking")).toEqual([]);
    expect(one(r.findings, "sql.unique-added")).toMatchObject({ severity: "high", adjust: [".codesloth.yml sets sql.unique-added to high."] });
    expect(r.findings.some((f) => f.path.startsWith("legacy/"))).toBe(false);
    expect(r.sensitivity).toBe("strict");
    expect(r.config).toBe(".codesloth.yml loaded from the base branch (2 rule overrides, 1 ignored path, sensitivity strict)");
    expect(one(rules([pf(".codesloth.yml", "modified", ["+risk: {}"])]), "cfg.codesloth").severity).toBe("medium");
    expect(parseRiskConfig("risk:\n  rules\n    x").note).toMatch(/^\.codesloth\.yml ignored: line/);
    expect(parseRiskConfig(undefined).note).toBe(".codesloth.yml: not found on the base branch");
  });
  it("public_api paths raise data-layer findings; env_readers add helpers", () => {
    const cfg = "risk:\n  paths:\n    public_api: [\"internal/api/**\"]\n  env_readers: [\"cfg.Must\"]\n";
    expect(one(rules([pf("internal/api/store.go", "modified", ["-func Get(id int) error {", "+func Get(id string) error {"])], { configText: cfg }), "dal.sig-changed").severity).toBe("high");
    expect(one(rules([pf("main.go", "modified", ['+  x := cfg.Must("NEW_VAR")'])], { configText: cfg }), "cfg.env-added").excerpt).toContain("NEW_VAR");
  });
  it("YAML subset parser", () => {
    expect(parseYaml("a:\n  b: [x, 'y z']\n  c: { severity: high }\n  d:\n    - one\n    - two # comment\n  e: off\n")).toEqual({ a: { b: ["x", "y z"], c: { severity: "high" }, d: ["one", "two"], e: "off" } });
    expect(() => parseYaml("a:\n  b: 1\n    c: 2")).toThrow(/line 3/);
  });
});

describe("what the UI shows", () => {
  const r = run(RED_PR.concat([pf("db/migrations/009_x.sql", "added", plus("CREATE INDEX i ON users (email);"))]));
  it("sensitivity and categories filter findings; the repo's stricter setting wins", () => {
    const all = r.findings.length;
    expect(visibleFindings(r, { sensitivity: "relaxed", off: [] }).every((f) => f.severity === "high")).toBe(true);
    expect(visibleFindings(r, { sensitivity: "strict", off: [] })).toHaveLength(all);
    expect(visibleFindings(r, { sensitivity: "strict", off: ["sql"] }).some((f) => f.category === "sql")).toBe(false);
    expect(visibleFindings({ ...r, sensitivity: "strict" }, DEFAULT_RISK_PREFS)).toHaveLength(all);
    expect(normalizeRiskPrefs("loud", ["sql", "nope"])).toEqual({ sensitivity: "normal", off: ["sql"] });
  });
  it("dismissals hide a finding per file + rule + matched text and recompute the file's severity", () => {
    const vis = visibleFindings(r, DEFAULT_RISK_PREFS);
    const mig = vis.filter((f) => f.path === "repository/migrations/002_create_quota_budgets.sql");
    expect(mig.map((f) => f.rule).sort()).toEqual(["sql.drop-column", "sql.migration-edited"]);
    const dismissed = Object.fromEntries(mig.map((f) => [dismissKey(f), "t"]));
    const by = riskByFile(vis, dismissed).get("repository/migrations/002_create_quota_budgets.sql")!;
    expect(by.findings).toEqual([]);
    expect(by.dismissed).toHaveLength(2);
    expect(dismissKey(mig[0])).toMatch(/^repository\/migrations\/002_create_quota_budgets\.sql\|sql\.\S+\|[0-9a-z]+$/);
    expect(dismissKey({ ...mig[0], excerpt: "changed" })).not.toBe(dismissKey(mig[0]));
  });
});

describe("illustrative red fixture", () => {
  it("flags the uncatchable breaks red", () => {
    const f = run(RED_PR).findings;
    const red = f.filter((x) => x.severity === "high").map((x) => `${x.path} ${x.rule}`);
    expect(red).toEqual(
      expect.arrayContaining([
        "repository/migrations/002_create_quota_budgets.sql sql.migration-edited",
        "repository/migrations/002_create_quota_budgets.sql sql.drop-column",
        "repository/migrations/004_quota_limits.sql sql.not-null-no-default",
        "domain/quota.go dal.tag-changed",
        "app/http.go api.route",
        "config/app.yaml cfg.key-removed",
        "api/quota.proto api.proto",
      ]),
    );
    expect(one(f, "sql.query-changed").severity).toBe("medium");
    expect(f.find((x) => x.rule === "sql.drop-column")!.line).toEqual({ side: "R", n: 5 });
  });
});

// Yash's real PRs (read-only gh GETs cached under .tmp/, not committed: private repo). Skipped when absent.
const real = (n: number) => `.tmp/quizizz_quota-service_${n}`;
describe.skipIf(!existsSync(real(4)) || !existsSync(real(2)))("real PRs quizizz/quota-service #2 and #4", () => {
  const load = (n: number) => {
    const dir = real(n);
    const files: PRFile[] = JSON.parse(readFileSync(`${dir}/files.json`, "utf8"));
    const contents: Record<string, string> = {};
    for (const name of readdirSync(dir).filter((x) => x.startsWith("raw_"))) {
      const f = files.find((x) => `raw_${x.filename.replace(/[^\w.-]/g, "_")}` === name);
      if (f) contents[f.filename] = readFileSync(`${dir}/${name}`, "utf8");
    }
    const baseContents: Record<string, string> = {};
    const b = `${dir}/risk_base_repository_sql_schema.sql`;
    if (existsSync(b) && !readFileSync(b, "utf8").startsWith("\u0000")) baseContents["repository/sql/schema.sql"] = readFileSync(b, "utf8");
    return analyzeRisk({ files, contents, baseContents }, analyze({ files, contents }));
  };
  const amber = (n: number) => {
    const by = riskByFile(visibleFindings(load(n), DEFAULT_RISK_PREFS), {});
    return { red: [...by].filter(([, v]) => v.severity === "high").map(([p]) => p), amber: [...by].filter(([, v]) => v.severity === "medium").map(([p]) => p).sort() };
  };
  it("#4: 2 amber, 0 red", () => expect(amber(4)).toEqual({ red: [], amber: ["app/http.go", "repository/sql/queries.sql"] }));
  it("#2: 2 amber, 0 red", () => expect(amber(2)).toEqual({ red: [], amber: ["app/http.go", "repository/database.go"] }));
});
