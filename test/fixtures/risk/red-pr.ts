/**
 * ILLUSTRATIVE fixture (not a real PR): what "Likely breaking" looks like on a quota-service-shaped repo.
 * Someone edits an already-merged migration to drop a column, renames a JSON field, removes a route,
 * removes a config key the code still reads, and deletes a proto field without reserving its number.
 */
import type { PRFile } from "../../../src/engine/types";
import { pf } from "./helpers";

export const RED_PR: PRFile[] = [
  pf("repository/migrations/002_create_quota_budgets.sql", "modified", [
    ' CREATE TABLE "quotaBudgets" (',
    "   budget_id UUID PRIMARY KEY,",
    "   consumed BIGINT NOT NULL DEFAULT 0",
    " );",
    '+ALTER TABLE "quotaBudgets" DROP COLUMN consumed;',
  ], { start: 1 }),
  pf("repository/migrations/004_quota_limits.sql", "added", [
    '+ALTER TABLE "quotaBudgets" ADD COLUMN hard_limit BIGINT NOT NULL;',
  ]),
  pf("domain/quota.go", "modified", [
    "@@ type Budget struct {",
    " type Budget struct {",
    '   ID       string `json:"id"`',
    '-  Consumed int64  `json:"consumed"`',
    '+  Consumed int64  `json:"used"`',
    " }",
  ], { start: 12 }),
  pf("app/http.go", "modified", [
    '   private := router.Group("/v1/private")',
    '   private.POST("/validation", controllers.HTTPController(&app.controllers.validation))',
    '-  private.DELETE("/allocation/:allocationId", controllers.HTTPController(&app.controllers.allocationDelete))',
  ], { start: 118 }),
  pf("config/app.yaml", "modified", [
    " database:",
    "   host: localhost",
    "-  queryTimeout: 5s",
    "   pool: 10",
  ], { start: 3 }),
  pf("config/config.go", "modified", [
    " func Load() *Config {",
    '   timeout := viper.GetDuration("database.queryTimeout")',
    '+  log.Printf("loading config")',
  ], { start: 20 }),
  pf("api/quota.proto", "modified", [
    " message Budget {",
    "   string id = 1;",
    "-  int64 consumed = 2;",
    "   int64 limit = 3;",
    " }",
  ], { start: 8 }),
  pf("repository/sql/queries.sql", "modified", [
    " -- name: GetBudget :one",
    '-SELECT budget_id, consumed FROM "quotaBudgets" WHERE budget_id = $1;',
    '+SELECT budget_id FROM "quotaBudgets" WHERE budget_id = $1;',
  ], { start: 40 }),
];
