// Non-production historical-status reconciliation PREVIEW (ST-1..ST-6).
// Usage: node scripts/reconcile-preview.mjs rows.json > report.json
// Input: JSON array of exported legacy rows (camelCase fields of LegacyRow).
// Read-only: never connects to any database and never applies changes.
import { readFileSync } from "node:fs";
import { previewReconciliation } from "../src/domain/legacy-status.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: reconcile-preview.mjs <rows.json>");
  process.exit(2);
}
const rows = JSON.parse(readFileSync(file, "utf8"));
if (!Array.isArray(rows)) {
  console.error("input must be a JSON array");
  process.exit(2);
}
const report = previewReconciliation(rows);
console.log(JSON.stringify(report, null, 2));
process.exit(report.reconciled ? 0 : 1);
