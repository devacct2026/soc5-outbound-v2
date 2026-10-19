// Disposable-database harness: initdb in a temp dir, replay ALL migrations in
// order, then run supabase/tests/*.sql (excluding 00_stub). Never touches any
// existing database. Requires PostgreSQL binaries (initdb/pg_ctl/psql) on PATH
// or PG_BIN. Exit 0 = all pass, 1 = failure, 2 = prerequisites unavailable.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const bin = (n) => (process.env.PG_BIN ? join(process.env.PG_BIN, n) : n);
const run = (cmd, args, opts = {}) =>
  spawnSync(bin(cmd), args, { encoding: "utf8", ...opts });
if (run("initdb", ["--version"]).error) {
  console.error("SKIP: PostgreSQL binaries not found (set PG_BIN).");
  process.exit(2);
}
const root = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "soc5-pg-"));
const port = process.env.DB_TEST_PORT ?? "54411";
let started = false;
const cleanup = () => {
  if (started) run("pg_ctl", ["-D", join(dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" });
  rmSync(dir, { recursive: true, force: true });
};
const fail = (msg) => { console.error("FAIL:", msg); cleanup(); process.exit(1); };

let r = run("initdb", ["-D", join(dir, "data"), "-U", "postgres", "-A", "trust", "-E", "UTF8"]);
if (r.status !== 0) fail("initdb\n" + r.stderr);
// stdio must be ignored: the postmaster inherits pipes and would block spawnSync.
r = run("pg_ctl", ["-D", join(dir, "data"), "-o", `-p ${port} -c listen_addresses=127.0.0.1`, "-l", join(dir, "log"), "-w", "start"], { stdio: "ignore" });
if (r.status !== 0) fail("pg_ctl start\n" + r.stderr);
started = true;
const psql = (args) => run("psql", ["-h", "127.0.0.1", "-p", port, "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-X", "-q", ...args]);
psql(["-d", "postgres", "-c", "create database soc5_test"]);
const db = ["-d", "soc5_test"];

const apply = (file) => {
  const x = psql([...db, "-f", file]);
  if (x.status !== 0) fail(`${file}\n${x.stderr}`);
};
apply(join(root, "supabase/tests/00_stub.sql"));
const migDir = join(root, "supabase/migrations");
const migrations = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
for (const m of migrations) { apply(join(migDir, m)); console.log("MIGRATED", m); }

const testDir = join(root, "supabase/tests");
const tests = readdirSync(testDir).filter((f) => /^\d+_.*\.sql$/.test(f) && !f.startsWith("00_")).sort();
let failed = 0;
for (const t of tests) {
  const x = psql([...db, "-f", join(testDir, t)]);
  if (x.status === 0) console.log("PASS", t);
  else { failed++; console.log("FAIL", t, "\n" + x.stderr); }
}
cleanup();
console.log(failed ? `${failed} DB test file(s) failed` : `All ${tests.length} DB test files passed (${migrations.length} migrations replayed)`);
process.exit(failed ? 1 : 0);
