/**
 * Session visibility through the self-host SERVICE's real assembly (lambda.ts readApiDepsFromSecret,
 * entry "service"; server.ts over loopback HTTP) on PGlite with every migration applied and every
 * statement run AS bulls96_read_api: the Postgres search index, the directory, briefs, the Postgres
 * Output/digest/coordination facts and the 062141 functions are all the real SQL.
 *
 * The secret session is uploaded under the physical id "s1" and known everywhere else as "s1-canonical"
 * (the output facts fixture's aliased session); "child-1" is a session it spawned. The marker marks the
 * PHYSICAL id through the HTTP route; every read route then hides all three from a non-member and still
 * serves them to a member. pg.Pool is a PGlite-backed pool (one client at a time); only the bearer
 * verifier is a test double (user id by token). Every id and secret here is synthetic.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { btree_gin } from "@electric-sql/pglite/contrib/btree_gin";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import type { SqlExecutor } from "@rhc/lib/pipeline/queue.ts";
import { createPostgresSearchIndex, type SqlClient } from "@rhc/search-index/postgres.ts";
import { syntheticDoc } from "../../../packages/pipeline/src/search-index/conformance.ts";
import { applySupabaseSchema, REPO_ROOT } from "../../session-ingest/__tests__/pglite-schema.ts";
import { outputFactsFromScope } from "../../session-pipeline/output-facts.ts";
import { postgresOutputFactsStore } from "../../session-pipeline/output-facts-store.ts";
import { OUTPUT_FIXTURE_SCOPE, outputFixture } from "../../session-pipeline/__tests__/output-facts-fixture.ts";
import { postgresSearchState } from "../../session-pipeline/postgres-search-state.ts";
import { createReadApi } from "../app.ts";
import { computeStatsHash } from "../digest-query.ts";
import { narrativeScopeKey } from "../digest-narrative.ts";
import { readApiDepsFromSecret } from "../lambda.ts";
import { selfhostSearchComposition, startReadApiService, type ReadApiService, type ReadAppBuilder } from "../server.ts";
import { readerLoginAnswer } from "./reader-login-support.ts";

const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");
const psql = (path: string) => read(path).split("\n").filter((l) => !l.startsWith("\\")).join("\n");

const ORG = OUTPUT_FIXTURE_SCOPE.orgId, WS = OUTPUT_FIXTURE_SCOPE.workspaceId;
const SECRET_PHYS = "s1", SECRET = "s1-canonical", CHILD = "child-1", OPEN = "open-1";
const MEMBER = "00000000-0000-4000-8000-000000000001";
const MARKER = "00000000-0000-4000-8000-000000000002";
const OUTSIDER = "00000000-0000-4000-8000-000000000003";
const USERS: Record<string, { userId: string; workspaceId: string }> = {
  member: { userId: MEMBER, workspaceId: WS }, marker: { userId: MARKER, workspaceId: WS }, outsider: { userId: OUTSIDER, workspaceId: WS },
  service: { userId: "read-api-service", workspaceId: WS },
  // The same people in another workspace of the org.
  "member-elsewhere": { userId: MEMBER, workspaceId: "ws-other" }, "marker-elsewhere": { userId: MARKER, workspaceId: "ws-other" },
};
const GROUPS = JSON.stringify({ leadership: { members: [MEMBER], markers: [MARKER] } });
const DAY = "2026-11-05";
const WINDOW = "since=2026-11-05T00:00:00Z&until=2026-11-05T23:59:59Z";
const SECRETS = ["Acquisition plan", "private summary of the plan", "needle in the secret upload", "needle under the canonical id", "needle from the subagent", "Subagent of the plan"];

let db: PGlite;
let lock: Promise<void> = Promise.resolve();
/** Every statement the read pool ran, for the "no marks query" assertions. */
let statements: string[] = [];
async function exclusive(): Promise<() => void> {
  let unlock!: () => void;
  const prev = lock;
  lock = new Promise<void>((r) => (unlock = r));
  await prev;
  return unlock;
}
/** One PGlite session, so one client at a time: a pool whose clients run AS bulls96_read_api. */
class PglitePool {
  on() { return this; }
  async query(text: string, params?: unknown[]) {
    const admission = readerLoginAnswer(text);
    if (admission) return { rows: admission };
    const unlock = await exclusive();
    try {
      await db.exec("SET ROLE bulls96_read_api");
      statements.push(text);
      return await db.query(text, params as unknown[]);
    } finally {
      await db.exec("RESET ROLE");
      unlock();
    }
  }
  async connect() {
    const unlock = await exclusive();
    await db.exec("SET ROLE bulls96_read_api");
    return {
      query: (text: string, params?: unknown[]) => { statements.push(text); return db.query(text, params as unknown[]) as Promise<{ rows: unknown[] }>; },
      release: () => void db.exec("RESET ROLE").finally(unlock),
    };
  }
  async end() {}
}

/** As the owner, with the tenant bound (the search tables force row-level security on the owner too). */
async function ownerTenant<T>(work: (q: SqlClient) => Promise<T>, ws = WS): Promise<T> {
  const unlock = await exclusive();
  try {
    await db.exec("BEGIN");
    try {
      await db.query("SELECT set_config('bulls96_read.org_id',$1,true),set_config('bulls96_read.workspace_id',$2,true)", [ORG, ws]);
      const out = await work(db as unknown as SqlClient);
      await db.exec("COMMIT");
      return out;
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
  } finally { unlock(); }
}

const RealPool = pg.Pool;
const running: ReadApiService[] = [];

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    RELAYHISTORY_SELFHOST_READ_API: "true",
    RELAYHISTORY_READ_API_SECRET: JSON.stringify({ supabase_url: "postgresql://bulls96_read_api:synthetic@db.selfhost.invalid:5432/postgres" }),
    SEARCH_INDEX_POSTGRES_BACKEND_ID: "selfhost-pg",
    SESSION_POSTGRES_TLS_PROFILE: "supabase",
    READ_API_COMPLETE_SINCE: "epoch",
    READ_API_ORIGIN: "https://read.selfhost.test",
    READ_API_DIRECTORY_WORKSPACES: "*",
    READ_API_BRIEF_TITLES_WORKSPACES: "*",
    READ_API_SESSION_QUERY: "true",
    READ_API_SESSION_SOURCES_ENABLED: "true",
    READ_API_OUTPUT_ENABLED: "1", READ_API_OUTPUT_BACKEND: "postgres",
    READ_API_DIGEST_ENABLED: "1", READ_API_DIGEST_BACKEND: "postgres",
    READ_API_COORDINATION_OVERLAPS_ENABLED: "true", READ_API_COORDINATION_OVERLAPS_BACKEND: "postgres",
    READ_API_SESSION_VISIBILITY_GROUPS: GROUPS,
    ...over,
  };
}

/** The production dependency assembly; only the bearer verifier is replaced (the token names the user). */
const build: ReadAppBuilder = async (secret, e) => {
  const built = await readApiDepsFromSecret(secret, e, selfhostSearchComposition(e), { entry: "service" });
  const verify = async (bearer: string) => {
    const user = USERS[bearer];
    if (!user) throw new Error("unknown token");
    return { orgId: ORG, ...user, scopes: ["rth:read"] };
  };
  return { app: createReadApi({ ...built.deps, verify }), close: built.close };
};

async function start(over: Record<string, string | undefined> = {}) {
  const service = await startReadApiService(env(over), { host: "127.0.0.1", port: 0, build });
  running.push(service);
  const call = (who: string, path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${service.port}${path}`, { ...init, headers: { authorization: `Bearer ${who}`, ...(init.headers as Record<string, string> | undefined) } });
  const mark = (who: string, sessionId: string, visibility: string, ws = WS) =>
    call(who, `/v1/sessions/${sessionId}/visibility?workspace=${ws}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility }) });
  return { call, mark };
}

type Body = Record<string, any>;

beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gin, pg_trgm } });
  await applySupabaseSchema(db, { until: null });
  await db.exec(psql("supabase/bootstrap/session_read_api_role.sql"));
  await db.exec("GRANT USAGE ON SCHEMA sessions TO search_consumer_runtime");

  // The Postgres search index and its completeness state, created by the owner as the consumer does.
  const tenantRunner = (_o: string, _w: string, work: (q: SqlClient) => Promise<unknown>) => ownerTenant(work);
  const index = createPostgresSearchIndex({ client: db as unknown as SqlClient, tenantRunner: tenantRunner as never });
  await index.ensureSchema();
  const state = postgresSearchState({ backendId: "selfhost-pg", fromMs: 0 });
  await state.ensureSchema(db as unknown as SqlExecutor);

  // Pointers: the secret session's physical upload id and its logical id; a child it spawned; an open session.
  for (const [id, canonical] of [[SECRET_PHYS, SECRET], [CHILD, null], [OPEN, null]] as const) {
    await db.query(
      `INSERT INTO sessions.session_index (org_id, workspace_id, harness, session_id, canonical_session_id, machine_id, user_id, created_at, last_activity_at,
         storage_provider, bucket, manifest_key, content_sha256, raw_format, trace_id, revision)
       VALUES ($1, $2, 'codex', $3, $4, 'm1', 'u1', '2026-11-05T09:00:00Z', '2026-11-05T11:00:00Z', 's3', 'bucket', 'k/' || $3, decode(repeat('ab', 32), 'hex'), 'ndjson', gen_random_uuid(), 1)`,
      [ORG, WS, id, canonical]);
  }
  // The directory knows the logical ids, with titles and a searchable text; all three are fully projected.
  for (const [id, title, minute] of [[SECRET, "Acquisition plan", 3], [CHILD, "Subagent of the plan", 2], [OPEN, "Public cleanup", 1]] as const) {
    await db.query(
      `INSERT INTO sessions.session_directory (org_id, workspace_id, harness, session_id, created_at, last_activity_at, title, state, search_text, event_count, projected_at, user_ids,
         event_projection_epoch, event_projection_ready, event_projection_version, event_projected_at, event_projection_sources)
       VALUES ($1, $2, 'codex', $3, '2026-11-05T09:00:00Z', $4::timestamptz, $5::text, 'active', sessions.session_directory_search_text($5::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL), 1, now(), ARRAY['u1'],
         3, true, 1, now(), jsonb_build_object('fixture', 1))`,
      [ORG, WS, id, `2026-11-05T11:0${minute}:00Z`, title]);
  }
  await db.query("INSERT INTO sessions.session_directory_relationships (org_id, workspace_id, harness, parent_session_id, relationship_uid, child_session_id) VALUES ($1, $2, 'codex', $3, 'rel-1', $4)", [ORG, WS, SECRET, CHILD]);
  // Native briefs (title and summary), keyed by the physical id as the brief worker writes them.
  for (const [id, title, description] of [[SECRET_PHYS, "Acquisition plan", "private summary of the plan"], [OPEN, "Public cleanup", "public summary of the cleanup"]] as const) {
    await db.query(
      `INSERT INTO sessions.session_briefs (org_id, workspace_id, harness, session_id, status, revision, title, description, model, generated_at, brief_revision, brief_source_revisions,
         brief_fingerprint, scrub_ruleset, scrub_version, prompt_version, engine_version)
       VALUES ($1, $2, 'codex', $3, 'ready', 1, $4, $5, 'fixture-model', now(), 1, '{"m1": 1}'::jsonb, repeat('a', 64), 'relayhistory-scrub', 2, 'session-summary-v2', 'fixture')`,
      [ORG, WS, id, title, description]);
  }
  // Search rows under both forms of the secret id, the child and the open session, all complete.
  const doc = (sessionId: string, n: number, content: string) => syntheticDoc({ orgId: ORG, workspaceId: WS, source: "codex", sessionId, machineId: "m1", eventId: `ev-${n}`, tsMs: Date.parse("2026-11-05T10:00:00Z") + n, content });
  await index.upsert([doc(SECRET_PHYS, 1, "needle in the secret upload"), doc(SECRET, 2, "needle under the canonical id"), doc(CHILD, 3, "needle from the subagent"), doc(OPEN, 4, "needle in the open"), doc(OPEN, 5, "second needle in the open")]);
  for (const [id, canonical] of [[SECRET_PHYS, SECRET], [CHILD, CHILD], [OPEN, OPEN]] as const)
    await ownerTenant((tx) => state.record(tx as never, { orgId: ORG, workspaceId: WS, harness: "codex", sessionId: id }, { revision: 1, rows: 1, complete: true, at: new Date(), canonicalSessionId: canonical }));
  // Facts: the fixture session (15 events, 3 agent messages, 3 commits, all under "s1-canonical") and one event of the open session.
  const facts = outputFactsFromScope(OUTPUT_FIXTURE_SCOPE, outputFixture(), 1);
  await db.exec("SET ROLE search_consumer_runtime");
  try {
    const store = postgresOutputFactsStore(db as unknown as SqlExecutor);
    await store.reconcile(OUTPUT_FIXTURE_SCOPE, { eventFacts: facts.events, outputFacts: facts.facts, complete: facts.complete, reasons: facts.reasons }, 1);
    await store.recordState(OUTPUT_FIXTURE_SCOPE, { complete: true, at: new Date("2026-11-09T12:00:00Z"), range: facts.range ?? null, sourceVersion: 1 });
  } finally { await db.exec("RESET ROLE"); }
  await db.query(`INSERT INTO sessions.session_event_facts
      (org_id, workspace_id, ts, session_id, source, machine_id, kind, event_id, project_id, task_ref_id, task_ref_empty, task_ref_json, task_title, user_id, branch,
       model, provider, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_create_tokens, cache_create_5m_tokens, cache_create_1h_tokens, cost_usd_micros,
       files_touched, retention_days, row_id, fingerprint, source_version)
      VALUES ($1, $2, '2026-11-05T10:30:00Z', $3, 'codex', 'm1', 'tool', 'open-event', 'open-project', NULL, 0, '{}', NULL, 'u1', 'main', NULL, NULL, 0, 0, 0, 0, 0,
       NULL, NULL, 0, ARRAY['src/open.ts'], 0, repeat('a', 64), repeat('c', 64), 1)`, [ORG, WS, OPEN]);
  await db.query(`INSERT INTO sessions.output_facts_session_state (org_id, workspace_id, source, session_id, complete, synced_at, min_ts, max_ts, source_version)
      VALUES ($1, $2, 'codex', $3, true, now(), '2026-11-05T10:30:00Z', '2026-11-05T10:30:00Z', 1)`, [ORG, WS, OPEN]);
  await db.query("INSERT INTO sessions.output_facts_workspace_state (org_id, workspace_id, complete_since, marked_by) VALUES ($1, $2, '2026-11-01T00:00:00Z', 'test')", [ORG, WS]);

  pg.Pool = PglitePool as unknown as typeof pg.Pool;
}, 300_000);

afterAll(async () => {
  for (const s of running.splice(0)) await s.close();
  pg.Pool = RealPool;
  await db?.close();
});

/** What one caller gets from every read route, as comparable values. */
async function everything(call: (who: string, path: string, init?: RequestInit) => Promise<Response>, who: string) {
  const get = async (path: string) => {
    const r = await call(who, path);
    const text = await r.text();
    let body: Body = {};
    try { body = JSON.parse(text) as Body; } catch { /* not JSON */ }
    return { status: r.status, text, body };
  };
  const perSession: Record<string, number | string> = {};
  for (const id of [SECRET, SECRET_PHYS, CHILD, OPEN]) {
    for (const [name, path] of [
      ["events", `/v1/sessions/${id}/events?workspace=${WS}`], ["events+source", `/v1/sessions/${id}/events?workspace=${WS}&source=codex`],
      ["events?session", `/v1/events?workspace=${WS}&session=${id}`], ["summary", `/v1/sessions/${id}/summary?workspace=${WS}&source=codex`],
      ["sources", `/v1/sessions/${id}/sources?workspace=${WS}`], ["timing", `/v1/sessions/${id}/timing?workspace=${WS}&source=codex`],
      ["turns", `/v1/sessions/${id}/turns?workspace=${WS}`], ["metadata", `/v1/sessions/${id}/metadata?workspace=${WS}`],
      ["catalog", `/v1/sessions/${id}/catalog?workspace=${WS}&source=codex`], ["analysis", `/v1/sessions/${id}/analysis?workspace=${WS}`],
    ] as const) {
      const r = await get(path);
      perSession[`${id} ${name}`] = r.status === 404 ? `404 ${r.body.error?.message}` : r.status;
    }
  }
  const list = await get(`/v1/sessions?workspace=${WS}`);
  const listQ = await get(`/v1/sessions?workspace=${WS}&q=${encodeURIComponent("plan")}`);
  const search = await get(`/v1/events?workspace=${WS}&q=needle&limit=50`);
  const titles = await get(`/v1/sessions/titles?workspace=${WS}&key=codex:${SECRET}&key=codex:${SECRET_PHYS}&key=codex:${OPEN}`);
  const output = await get(`/v1/sessions/output?workspace=${WS}&${WINDOW}`);
  const digest = await get(`/v1/digest/daily?workspace=${WS}&date=${DAY}&tz=UTC`);
  const overlaps = await get(`/v1/coordination/overlaps?workspace=${WS}&since=2026-11-05T00:00:00Z&until=2026-11-06T00:00:00Z`);
  const activity = await get(`/v1/sessions/activity?workspace=${WS}&since=2026-11-05T00:00:00Z&until=2026-11-05T23:59:59Z`);
  const users = await get(`/v1/sessions/users?workspace=${WS}&lastTsAfter=2026-11-05T00:00:00Z&lastTsBefore=2026-11-06T00:00:00Z`);
  for (const r of [list, listQ, search, titles, output, digest, overlaps, activity, users]) expect([r.status, r.status === 200 ? "" : r.text]).toEqual([200, ""]);
  const all = [list, listQ, search, titles, output, digest, overlaps].map((r) => r.text).join("\n");
  return {
    perSession,
    list: list.body.sessions.map((s: Body) => s.sessionId),
    listQ: listQ.body.sessions.map((s: Body) => s.sessionId),
    search: search.body.events.map((e: Body) => `${e.sessionId}: ${e.content}`).sort(),
    titles: titles.body.titles.map((t: Body) => `${t.sessionId}: ${t.title}`).sort(),
    output: output.body.output,
    digestEvents: digest.body.stats.eventCount,
    digestSessions: digest.body.sessions.map((s: Body) => s.sessionId).sort(),
    digest: digest.body,
    overlapSessions: overlaps.body.coverage.sessionsConsidered,
    activity: activity.body.days.map((d: Body) => d.total),
    users: users.body.users.map((u: Body) => [u.userId, u.sessions]),
    leaked: SECRETS.filter((s) => all.includes(s)),
    namesSecretId: all.includes(SECRET) || all.includes(`"${SECRET_PHYS}"`) || all.includes(CHILD),
  };
}

describe("session visibility on the self-host service (real assembly, real SQL)", () => {
  test("unset: no marks statement is ever run and the visibility route does not exist, even with a mark in the table", async () => {
    await db.query("INSERT INTO sessions.session_visibility (organization_id, workspace_id, session_id, visibility, marked_by) VALUES ($1, $2, $3, 'leadership', $4)", [ORG, WS, SECRET_PHYS, MARKER]);
    try {
      const { call, mark } = await start({ READ_API_SESSION_VISIBILITY_GROUPS: undefined });
      statements = [];
      const seen = await everything(call, "outsider");
      expect(seen.list).toEqual([SECRET, CHILD, OPEN]);
      expect(seen.search).toHaveLength(5);
      expect(seen.digestSessions).toEqual([OPEN, SECRET]);
      expect(seen.leaked.length).toBeGreaterThan(3);
      expect(statements.length).toBeGreaterThan(20);
      expect(statements.filter((s) => s.includes("session_visibility"))).toEqual([]);
      expect((await mark("member", SECRET_PHYS, "workspace")).status).toBe(405);
      expect((await call("member", `/v1/sessions/${SECRET_PHYS}/visibility?workspace=${WS}`)).status).toBe(501);
    } finally {
      for (const s of running.splice(0)) await s.close();
      await db.exec("DELETE FROM sessions.session_visibility");
    }
    await expect(startReadApiService(env({ READ_API_SESSION_VISIBILITY_GROUPS: '{"leadership":{"members":"everyone"}}' }), { host: "127.0.0.1", port: 0, build })).rejects.toThrow("READ_API_SESSION_VISIBILITY_GROUPS");
  }, 120_000);

  test("the marker marks the physical id over HTTP; every read route then hides the session, its other id form and its child from non-members only", async () => {
    const { call, mark } = await start();
    // Before the mark everyone sees everything, and the two callers get identical answers.
    const before = await everything(call, "outsider");
    expect(before.list).toEqual([SECRET, CHILD, OPEN]);
    expect(before.search).toHaveLength(5);
    expect(before.output).toMatchObject({ agentMessages: 3, commits: 3 });
    expect(before.digestEvents).toBe(16);
    expect({ ...(await everything(call, "member")), digest: 0 }).toEqual({ ...before, digest: 0 });

    // Roles are per workspace token and per group: none of these may mark it.
    expect((await mark("outsider", SECRET_PHYS, "leadership")).status).toBe(403);
    expect((await mark("service", SECRET_PHYS, "leadership")).status).toBe(403);
    expect((await mark("marker-elsewhere", SECRET_PHYS, "leadership")).status).toBe(403); // another workspace's token naming this workspace
    expect((await db.query("SELECT 1 FROM sessions.session_visibility")).rows).toEqual([]);

    const set = await mark("marker", SECRET_PHYS, "leadership");
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ sessionId: SECRET_PHYS, visibility: "leadership", markedBy: MARKER });
    expect((await db.query("SELECT organization_id, workspace_id, session_id, visibility, marked_by FROM sessions.session_visibility")).rows)
      .toEqual([{ organization_id: ORG, workspace_id: WS, session_id: SECRET_PHYS, visibility: "leadership", marked_by: MARKER }]);

    // The member: nothing changed.
    const member = await everything(call, "member");
    expect({ ...member, digest: 0 }).toEqual({ ...before, digest: 0 });

    // Everyone else, the marker and a service token included: gone from every route.
    for (const who of ["outsider", "marker", "service"]) {
      const seen = await everything(call, who);
      for (const id of [SECRET, SECRET_PHYS, CHILD])
        for (const [key, value] of Object.entries(seen.perSession).filter(([k]) => k.startsWith(`${id} `)))
          expect([who, key, value]).toEqual([who, key, "404 Session not found"]);
      for (const [key, value] of Object.entries(seen.perSession).filter(([k]) => k.startsWith(`${OPEN} `)))
        expect([who, key, value]).toEqual([who, key, before.perSession[key]!]);
      expect(seen.list).toEqual([OPEN]);
      expect(seen.listQ).toEqual([]);
      expect(seen.search).toEqual([`${OPEN}: needle in the open`, `${OPEN}: second needle in the open`]);
      expect(seen.titles).toEqual([`${OPEN}: Public cleanup`]);
      expect(seen.output).toEqual({ agentMessages: 0, commits: 0, linesAdded: 0, linesRemoved: 0, commitsWithoutLineCounts: 0 });
      expect(seen.digestEvents).toBe(1);
      expect(seen.digestSessions).toEqual([OPEN]);
      expect(seen.overlapSessions).toBe(1);
      expect([who, seen.leaked, seen.namesSecretId]).toEqual([who, [], false]);
      // Documented limit: the per-day and per-user COUNTS still include hidden sessions.
      expect(seen.activity).toEqual(before.activity);
      expect(seen.users).toEqual(before.users);
    }
    // Activity counts of a text query (real directory SQL): the member's count, and a refusal for everyone else.
    const queried = (who: string) => call(who, `/v1/sessions/activity?workspace=${WS}&since=2026-11-05T00:00:00Z&until=2026-11-05T23:59:59Z&q=Acquisition`);
    expect(((await (await queried("member")).json()) as Body).days.map((d: Body) => d.total)).toEqual([1]);
    for (const who of ["outsider", "marker", "service"]) expect([who, (await queried(who)).status]).toEqual([who, 501]);
    // Requests of different callers interleave on the one pool: each keeps its own view to the end.
    const mixed = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const who = i % 2 ? "member" : "outsider";
      const [output, search] = await Promise.all([call(who, `/v1/sessions/output?workspace=${WS}&${WINDOW}`), call(who, `/v1/events?workspace=${WS}&q=needle&limit=50`)]);
      return [who, ((await output.json()) as Body).output.agentMessages, ((await search.json()) as Body).events.length];
    }));
    expect(mixed).toEqual(Array.from({ length: 12 }, (_, i) => (i % 2 ? ["member", 3, 5] : ["outsider", 0, 2])));
    expect(member.perSession[`${SECRET} events`]).toBe(200);
    expect(member.perSession[`${SECRET} summary`]).toBe(200);
    expect(member.perSession[`${SECRET} sources`]).toBe(200);

    // The digest narrative cache: a narrative written from the member's digest is served to the member only.
    const insertNarrative = async (digest: Body, text: string) => db.query(
      `INSERT INTO sessions.daily_digest_narratives (org_id, workspace_id, day, tz, scope_key, stats_hash, narrative_text, narrative_model, narrative_generated_at)
       VALUES ($1, $2, $3::date, 'UTC', $4, $5, $6, 'fixture-model', now())
       ON CONFLICT (org_id, day, tz, scope_key) DO UPDATE SET stats_hash = excluded.stats_hash, narrative_text = excluded.narrative_text`,
      [ORG, WS, DAY, narrativeScopeKey(WS, null), await computeStatsHash(digest as never, WS), text]);
    const narrative = async (who: string) => ((await (await call(who, `/v1/digest/daily?workspace=${WS}&date=${DAY}&tz=UTC`)).json()) as Body).narrative;
    await insertNarrative(member.digest, "The team finalised the acquisition plan.");
    expect(await narrative("member")).toMatchObject({ text: "The team finalised the acquisition plan.", cached: true });
    for (const who of ["outsider", "marker", "service"]) expect([who, await narrative(who)]).toEqual([who, { text: null, model: null, generatedAt: null, cached: false, unavailable: "provider_not_configured" }]);
    // And the other way round: the outsider's own narrative is not the member's.
    const outsiderDigest = ((await (await call("outsider", `/v1/digest/daily?workspace=${WS}&date=${DAY}&tz=UTC`)).json()) as Body);
    await insertNarrative(outsiderDigest, "One open cleanup session.");
    expect((await narrative("outsider")).text).toBe("One open cleanup session.");
    expect((await narrative("member")).text).toBeNull();

    // The marker can verify its mark under either id form, but not clear it; a non-member learns nothing.
    for (const id of [SECRET_PHYS, SECRET, CHILD]) {
      const r = await call("marker", `/v1/sessions/${id}/visibility?workspace=${WS}`);
      expect([id, r.status, ((await r.json()) as Body).visibility]).toEqual([id, 200, "leadership"]);
      expect((await call("outsider", `/v1/sessions/${id}/visibility?workspace=${WS}`)).status).toBe(404);
    }
    expect((await mark("marker", SECRET_PHYS, "workspace")).status).toBe(403);
    // Another workspace's reader and writer are pinned to their own workspace: no read, no clear, and their own marks are theirs.
    expect((await call("member-elsewhere", `/v1/sessions/${SECRET_PHYS}/visibility?workspace=${WS}`)).status).toBe(403);
    expect((await mark("member-elsewhere", SECRET_PHYS, "workspace")).status).toBe(403);
    expect(await (await call("member-elsewhere", `/v1/sessions/${SECRET_PHYS}/visibility?workspace=ws-other`)).json()).toMatchObject({ visibility: "workspace" });
    expect((await mark("marker-elsewhere", OPEN, "leadership", "ws-other")).status).toBe(200);
    expect((await call("outsider", `/v1/sessions/${OPEN}/events?workspace=${WS}`)).status).toBe(200);
    expect((await db.query("SELECT workspace_id, session_id FROM sessions.session_visibility ORDER BY 1")).rows).toEqual([{ workspace_id: WS, session_id: SECRET_PHYS }, { workspace_id: "ws-other", session_id: OPEN }]);

    // A group the configuration no longer names: hidden from the former member too, on a service restarted without it.
    for (const s of running.splice(0)) await s.close();
    const renamed = await start({ READ_API_SESSION_VISIBILITY_GROUPS: JSON.stringify({ board: { members: [MEMBER] } }) });
    const orphaned = await everything(renamed.call, "member");
    expect([orphaned.list, orphaned.digestSessions, orphaned.leaked]).toEqual([[OPEN], [OPEN], []]);
    expect((await renamed.mark("member", SECRET_PHYS, "workspace")).status).toBe(403);
    for (const s of running.splice(0)) await s.close();

    // A member clears it: the next request of anyone sees the session again.
    const again = await start();
    const cleared = await again.mark("member", SECRET_PHYS, "workspace");
    expect([cleared.status, await cleared.json()]).toEqual([200, expect.objectContaining({ sessionId: SECRET_PHYS, visibility: "workspace", markedBy: null, markedAt: null })]);
    const after = await everything(again.call, "outsider");
    expect({ ...after, digest: 0 }).toEqual({ ...before, digest: 0 });
  }, 300_000);
});
