/** 062141 session visibility: role grants, the tenant pin, set/clear semantics, the id closure and rollback. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type Transaction } from "../../../packages/pipeline/node_modules/@electric-sql/pglite/dist/index.js";
import { btree_gin } from "../../../packages/pipeline/node_modules/@electric-sql/pglite/dist/contrib/btree_gin.js";
import { pg_trgm } from "../../../packages/pipeline/node_modules/@electric-sql/pglite/dist/contrib/pg_trgm.js";
import { inventoryOf, RUNTIME_APPLICATION_FUNCTIONS } from "../migrate-guards.ts";
import { MIGRATION_SENTINELS } from "../migration-sentinels.ts";
import { plan, runMigrations, type MigrationClient, type MigrationProfile } from "../migrate.ts";

setDefaultTimeout(300_000);
const root = join(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
/** psql meta-commands (\set) are not SQL. */
const sqlFile = (path: string) => read(path).split("\n").filter((l) => !l.startsWith("\\")).join("\n");
const FILE = "20261105062141_session_visibility.sql";
const STEP = `upstream:${FILE}`;
const SQL = read(`supabase/migrations/${FILE}`);
const DOWN = read("supabase/rollbacks/20261105062141_session_visibility.down.sql");
const LOCAL: MigrationProfile = { mode: "local", shim: true, bootstrap: true, verify: false, runtimeRole: "postgres" };
const MARKS = "sessions.session_visibility_marks_v1(text)";
const SET = "sessions.session_visibility_set_v1(text,text,text,text)";
const MARKER = "00000000-0000-4000-8000-0000000000a1";

function client(db: PGlite): MigrationClient {
  return { async query<R>(text: string, params?: unknown[]) {
    if (params?.length) return (await db.query<R>(text, params)) as { rows: R[] };
    const results = await db.exec(text);
    return { rows: (results.at(-1)?.rows ?? []) as R[] };
  } };
}
const code = async (p: Promise<unknown>) =>
  ((await p.then(() => null, (e: unknown) => e)) as { code?: string } | null)?.code ?? null;
async function migrated() {
  const db = new PGlite({ extensions: { btree_gin, pg_trgm } });
  await runMigrations(client(db), { profile: LOCAL });
  return db;
}

describe("20261105062141 session visibility", () => {
  let db: PGlite;
  const as = async <R,>(role: string, run: (tx: Transaction) => Promise<R>, scope?: [string, string]) =>
    db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL ROLE ${role}`);
      if (scope) await tx.query("SELECT set_config('bulls96_read.org_id',$1,true), set_config('bulls96_read.workspace_id',$2,true)", scope);
      return run(tx);
    });
  /** As the read API: the tenant binding is [org, ws] unless `scope` says otherwise. */
  const marks = (org: string, ws: string, scope: [string, string] = [org, ws]) =>
    as("bulls96_read_api", async (tx) => (await tx.query<{ session_id: string; visibility: string; marked_by: string; direct: boolean }>(
      "SELECT session_id, visibility, marked_by, direct FROM sessions.session_visibility_marks_v1($1) ORDER BY session_id, direct DESC, visibility", [ws])).rows, scope);
  const set = (org: string, ws: string, id: string | null, visibility: string | null, by: string | null = MARKER, scope: [string, string] = [org, ws]) =>
    as("bulls96_read_api", async (tx) => (await tx.query<{ previous: string | null }>(
      "SELECT sessions.session_visibility_set_v1($1,$2,$3,$4) AS previous", [ws, id, visibility, by])).rows[0]!.previous, scope);
  const pointer = (org: string, ws: string, id: string, canonical: string | null, deleted = false) => db.query(
    `INSERT INTO sessions.session_index (org_id, workspace_id, harness, session_id, canonical_session_id, machine_id, user_id, created_at, last_activity_at,
       storage_provider, bucket, manifest_key, content_sha256, raw_format, trace_id, revision, deleted_at)
     VALUES ($1, $2, 'codex', $3, $4, 'm1', 'u1', now(), now(), 's3', 'bucket', 'k/' || $3, decode(repeat('ab', 32), 'hex'), 'ndjson', gen_random_uuid(), 1,
             CASE WHEN $5 THEN now() END)`, [org, ws, id, canonical, deleted]);
  const child = async (org: string, ws: string, parent: string, uid: string, childId: string | null) => {
    await db.query("INSERT INTO sessions.session_directory(org_id,workspace_id,harness,session_id,created_at,last_activity_at) VALUES($1,$2,'codex',$3,now(),now()) ON CONFLICT DO NOTHING", [org, ws, parent]);
    await db.query("INSERT INTO sessions.session_directory_relationships(org_id,workspace_id,harness,parent_session_id,relationship_uid,child_session_id) VALUES($1,$2,'codex',$3,$4,$5)", [org, ws, parent, uid, childId]);
  };
  const reset = () => db.exec("DELETE FROM sessions.session_visibility; DELETE FROM sessions.session_directory_relationships; DELETE FROM sessions.session_directory; DELETE FROM sessions.session_index");

  beforeAll(async () => {
    db = await migrated();
    await db.exec(sqlFile("supabase/bootstrap/session_read_api_role.sql"));
  });
  afterAll(async () => { await db?.close(); });

  test("inventory, sentinel and allowlists: one table, two functions, nothing for the runtime role", async () => {
    expect(inventoryOf(SQL).map((i) => `${i.kind}:${i.name}`).sort()).toEqual([
      "function:sessions.session_visibility_marks_v1", "function:sessions.session_visibility_set_v1", "relation:sessions.session_visibility",
    ]);
    expect((await db.query<{ applied: boolean }>(MIGRATION_SENTINELS[STEP]!.sql)).rows[0]!.applied).toBe(true);
    expect(RUNTIME_APPLICATION_FUNCTIONS.filter((f) => f.startsWith("sessions.session_visibility_"))).toEqual([]);
    const cols = (await db.query<{ column_name: string; is_nullable: string }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema='sessions' AND table_name='session_visibility' ORDER BY ordinal_position")).rows;
    expect(cols.map((c) => c.column_name)).toEqual(["organization_id", "workspace_id", "session_id", "visibility", "marked_by", "marked_at"]);
    expect(cols.filter((c) => c.is_nullable === "YES")).toEqual([]);
  });

  test("grants: SECURITY DEFINER with a pinned search_path, EXECUTE for the read API only, no table privilege for anyone", async () => {
    for (const fn of [MARKS, SET]) {
      const r = (await db.query<{ secdef: boolean; cfg: string[]; public_exec: boolean }>(
        "SELECT p.prosecdef secdef, p.proconfig cfg, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public_exec FROM pg_proc p WHERE p.oid=$1::regprocedure", [fn])).rows[0]!;
      expect(r).toEqual({ secdef: true, cfg: ["search_path=pg_catalog, sessions, pg_temp"], public_exec: false });
      const can = async (role: string) => (await db.query<{ ok: boolean }>("SELECT has_function_privilege($1, $2, 'EXECUTE') ok", [role, fn])).rows[0]!.ok;
      for (const role of ["anon", "authenticated", "service_role", "search_consumer_runtime", "bulls96_session_ingest"]) expect([role, await can(role)]).toEqual([role, false]);
      expect(await can("bulls96_read_api")).toBe(true);
    }
    for (const role of ["service_role", "bulls96_read_api", "anon", "authenticated"])
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"])
        expect((await db.query<{ ok: boolean }>("SELECT has_table_privilege($1, 'sessions.session_visibility', $2) ok", [role, priv])).rows[0]!.ok).toBe(false);
    expect((await db.query<{ rls: boolean }>("SELECT relrowsecurity rls FROM pg_class WHERE oid='sessions.session_visibility'::regclass")).rows[0]!.rls).toBe(true);
    expect(await code(as("bulls96_read_api", (tx) => tx.query("SELECT 1 FROM sessions.session_visibility"), ["org-a", "ws-a"]))).toBe("42501");
    expect(await code(as("bulls96_read_api", (tx) => tx.query("DELETE FROM sessions.session_visibility"), ["org-a", "ws-a"]))).toBe("42501");
    expect(await code(as("service_role", (tx) => tx.query("SELECT * FROM sessions.session_visibility_marks_v1('ws-a')")))).toBe("42501");
    expect(await code(as("service_role", (tx) => tx.query("SELECT sessions.session_visibility_set_v1('ws-a','s','leadership','u')")))).toBe("42501");
    // The read-API role verifier still passes with the two new grants.
    expect(await code(db.exec(sqlFile("supabase/bootstrap/session_read_api_role_verify.sql")))).toBeNull();
  });

  test("set, clear and idempotency: insert only where no mark stands, and always say what stood there", async () => {
    await reset();
    expect(await marks("org-a", "ws-a")).toEqual([]);
    expect(await set("org-a", "ws-a", "sess-1", "leadership")).toBeNull();
    expect(await marks("org-a", "ws-a")).toEqual([{ session_id: "sess-1", visibility: "leadership", marked_by: MARKER, direct: true }]);
    const first = (await db.query<{ marked_at: Date }>("SELECT marked_at FROM sessions.session_visibility")).rows[0]!.marked_at;
    // Again, by someone else, and with another label: nothing changes, and the standing label is reported.
    expect(await set("org-a", "ws-a", "sess-1", "leadership", "someone-else")).toBe("leadership");
    expect(await set("org-a", "ws-a", "sess-1", "finance", "someone-else")).toBe("leadership");
    expect(await marks("org-a", "ws-a")).toEqual([{ session_id: "sess-1", visibility: "leadership", marked_by: MARKER, direct: true }]);
    expect((await db.query<{ marked_at: Date }>("SELECT marked_at FROM sessions.session_visibility")).rows[0]!.marked_at).toEqual(first);
    // Clear ('workspace' or NULL) removes it and reports it; clearing nothing reports nothing.
    expect(await set("org-a", "ws-a", "sess-1", "workspace")).toBe("leadership");
    expect(await set("org-a", "ws-a", "sess-1", null)).toBeNull();
    expect(await marks("org-a", "ws-a")).toEqual([]);
    // A session that does not exist anywhere can be marked.
    expect(await set("org-a", "ws-a", "not-yet-uploaded", "finance")).toBeNull();
    // Bounds.
    for (const [id, label, by] of [["", "leadership", MARKER], [null, "leadership", MARKER], ["x".repeat(513), "leadership", MARKER], ["a\nb", "leadership", MARKER],
      ["s", "Leadership", MARKER], ["s", "has space", MARKER], ["s", "", MARKER], ["s", "x".repeat(65), MARKER], ["s", "leadership", null], ["s", "leadership", ""]] as const)
      expect([id, label, by, await code(set("org-a", "ws-a", id, label, by))]).toEqual([id, label, by, "22023"]);
    expect(await code(db.query("INSERT INTO sessions.session_visibility(organization_id,workspace_id,session_id,visibility,marked_by) VALUES('o','w','s','workspace','u')"))).toBe("23514");
    // A read-only transaction (the role's default) cannot write.
    expect(await code(db.transaction(async (tx) => {
      await tx.exec("SET TRANSACTION READ ONLY; SET LOCAL ROLE bulls96_read_api");
      await tx.query("SELECT set_config('bulls96_read.org_id','org-a',true), set_config('bulls96_read.workspace_id','ws-a',true)");
      await tx.query("SELECT sessions.session_visibility_set_v1('ws-a','sess-ro','leadership','u')");
    }))).toBe("25006");
  });

  test("tenant pin: another workspace's or org's caller can neither read nor set, and no binding means no call", async () => {
    await reset();
    await set("org-a", "ws-a", "sess-1", "leadership");
    await set("org-a", "ws-b", "sess-1", "finance");
    await set("org-b", "ws-a", "sess-1", "legal");
    expect((await marks("org-a", "ws-a")).map((m) => m.visibility)).toEqual(["leadership"]);
    expect((await marks("org-a", "ws-b")).map((m) => m.visibility)).toEqual(["finance"]);
    expect((await marks("org-b", "ws-a")).map((m) => m.visibility)).toEqual(["legal"]);
    expect(await marks("org-c", "ws-a")).toEqual([]);
    // Naming a workspace other than the bound one is refused; the org is never an argument at all.
    expect(await code(marks("org-a", "ws-b", ["org-a", "ws-a"]))).toBe("42501");
    expect(await code(set("org-a", "ws-b", "sess-1", "workspace", MARKER, ["org-a", "ws-a"]))).toBe("42501");
    expect(await code(set("org-a", "ws-b", "sess-9", "leadership", MARKER, ["org-a", "ws-a"]))).toBe("42501");
    expect(await code(as("bulls96_read_api", (tx) => tx.query("SELECT * FROM sessions.session_visibility_marks_v1('ws-a')")))).toBe("42501");
    expect(await code(as("bulls96_read_api", (tx) => tx.query("SELECT sessions.session_visibility_set_v1('ws-a','sess-1','workspace','u')")))).toBe("42501");
    // The other tenants' marks are untouched by a clear in this one.
    expect(await set("org-a", "ws-a", "sess-1", "workspace")).toBe("leadership");
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM sessions.session_visibility")).rows[0]!.n).toBe(2);
  });

  test("the closure: both id forms, sibling aliases and spawned sessions carry the mark; other tenants' rows never do", async () => {
    await reset();
    // Physical phys-1 and phys-2 are two live uploads of the logical session logical-1, phys-gone an erased
    // (tombstoned) third; solo has no alias.
    await pointer("org-a", "ws-a", "phys-1", "logical-1");
    await pointer("org-a", "ws-a", "phys-2", "logical-1");
    await pointer("org-a", "ws-a", "phys-gone", "logical-1", true);
    await pointer("org-a", "ws-a", "solo", null);
    // The same ids in another workspace and org.
    await pointer("org-a", "ws-b", "phys-1", "other-ws-logical");
    await pointer("org-b", "ws-a", "phys-1", "other-org-logical");
    // logical-1 spawned child-1, which spawned grandchild-1 (physical alias grand-phys); an unlinked edge has no child.
    await child("org-a", "ws-a", "logical-1", "r1", "child-1");
    await child("org-a", "ws-a", "logical-1", "r2", null);
    await child("org-a", "ws-a", "child-1", "r3", "grandchild-1");
    await pointer("org-a", "ws-a", "grand-phys", "grandchild-1");
    await child("org-b", "ws-a", "logical-1", "r1", "other-org-child");
    const ids = async () => (await marks("org-a", "ws-a")).map((m) => `${m.session_id}:${m.visibility}:${m.direct ? "direct" : "inherited"}`);
    // Marked by the physical id.
    await set("org-a", "ws-a", "phys-1", "leadership");
    const all = ["child-1:leadership:inherited", "grand-phys:leadership:inherited", "grandchild-1:leadership:inherited", "logical-1:leadership:inherited", "phys-1:leadership:direct", "phys-1:leadership:inherited", "phys-2:leadership:inherited"];
    expect(await ids()).toEqual(all);
    // Marked by the logical id instead: the same set, with the mark on the other form.
    await set("org-a", "ws-a", "phys-1", "workspace");
    await set("org-a", "ws-a", "logical-1", "leadership");
    expect((await ids()).map((i) => i.split(":")[0]).filter((v, i, a) => a.indexOf(v) === i)).toEqual(["child-1", "grand-phys", "grandchild-1", "logical-1", "phys-1", "phys-2"]);
    // An erased upload is not reached from the logical id (it is served to nobody), but its own mark still reaches the session.
    await set("org-a", "ws-a", "logical-1", "workspace");
    await set("org-a", "ws-a", "phys-gone", "leadership");
    expect((await ids()).map((i) => i.split(":")[0]).filter((v, i, a) => a.indexOf(v) === i)).toEqual(["child-1", "grand-phys", "grandchild-1", "logical-1", "phys-1", "phys-2", "phys-gone"]);
    await set("org-a", "ws-a", "phys-gone", "workspace");
    await set("org-a", "ws-a", "logical-1", "leadership");
    // A child's mark does not reach its parent; two labels on one id are both reported.
    await set("org-a", "ws-a", "logical-1", "workspace");
    await set("org-a", "ws-a", "child-1", "finance");
    expect(await ids()).toEqual(["child-1:finance:direct", "grand-phys:finance:inherited", "grandchild-1:finance:inherited"]);
    await set("org-a", "ws-a", "grandchild-1", "leadership");
    expect(await ids()).toEqual(["child-1:finance:direct", "grand-phys:finance:inherited", "grand-phys:leadership:inherited", "grandchild-1:leadership:direct", "grandchild-1:finance:inherited", "grandchild-1:leadership:inherited"]);
    // A pointer that arrives after the mark is covered by the next read.
    await pointer("org-a", "ws-a", "late-phys", "child-1");
    expect(await ids()).toContain("late-phys:finance:inherited");
    // Nothing of this tenant's marks shows in the neighbours.
    expect(await marks("org-a", "ws-b")).toEqual([]);
    expect(await marks("org-b", "ws-a")).toEqual([]);
  });
});

describe("20261105062141 rollback", () => {
  test("the checksum-pinned down refuses under a later step and while marks exist, then leaves no table, function or ledger row", async () => {
    expect(DOWN).toContain(createHash("sha256").update(SQL).digest("hex"));
    const db = await migrated();
    try {
      const later = (await plan(LOCAL)).filter((s) => s.name.startsWith("upstream:") && s.name > STEP).reverse();
      for (const step of later)
        await db.exec(read(`supabase/rollbacks/${step.name.slice("upstream:".length).replace(/\.sql$/, ".down.sql")}`));
      // A later ledgered step refuses it.
      await db.query("INSERT INTO sessions.__96bulls_migrations SELECT (jsonb_populate_record(NULL::sessions.__96bulls_migrations, to_jsonb(m) || jsonb_build_object('name', 'upstream:20261105099000_rollback_guard_probe.sql'))).* FROM sessions.__96bulls_migrations m WHERE m.name = $1", [STEP]);
      expect(await code(db.exec(DOWN))).toBe("55000");
      await db.exec("ROLLBACK");
      await db.exec("DELETE FROM sessions.__96bulls_migrations WHERE name = 'upstream:20261105099000_rollback_guard_probe.sql'");
      // Marks exist: refused unless the operator says to drop them.
      await db.exec("INSERT INTO sessions.session_visibility(organization_id,workspace_id,session_id,visibility,marked_by) VALUES('org-a','ws-a','sess-1','leadership','u')");
      expect(await code(db.exec(DOWN))).toBe("55000");
      await db.exec("ROLLBACK");
      expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM sessions.session_visibility")).rows[0]!.n).toBe(1);
      await db.exec("SET session_visibility.rollback_drop_marks = 'yes'");
      expect(await code(db.exec(DOWN))).toBe("55000");
      await db.exec("ROLLBACK");
      await db.exec("SET session_visibility.rollback_drop_marks = 'true'");
      await db.exec(DOWN);
      expect((await db.query<{ r: string | null }>("SELECT to_regclass('sessions.session_visibility')::text r")).rows[0]!.r).toBeNull();
      expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM pg_proc WHERE pronamespace='sessions'::regnamespace AND proname LIKE 'session\\_visibility\\_%'")).rows[0]!.n).toBe(0);
      expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM sessions.__96bulls_migrations WHERE name=$1", [STEP])).rows[0]!.n).toBe(0);
      expect((await db.query<{ applied: boolean }>(MIGRATION_SENTINELS[STEP]!.sql)).rows[0]!.applied).toBe(false);
      // Its ledger row is gone, so a rerun refuses; the previous step's down now runs.
      expect(await code(db.exec(DOWN))).toBe("55000");
      await db.exec("ROLLBACK");
      await db.exec(read("supabase/rollbacks/20261105062140_staged_output_facts.down.sql"));
    } finally { await db.close(); }
  });
});
