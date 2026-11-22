/**
 * Session visibility (session-visibility.ts, docs/session-visibility.md) on the read API's routes, with
 * in-memory dependencies: for every read route a marked session is invisible to a caller outside its group
 * and unchanged for a member; unmarked sessions and the unconfigured app are unchanged. Every id is synthetic.
 * The real SQL, the real service assembly and the facts routes are in session-visibility.pglite.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import type { SearchHit, SearchIndexAdapter, SearchQuery } from "@rhc/search-index/contracts.ts";
import { createReadApi, type ReadApiDeps, type VerifiedIdentity } from "../app.ts";
import type { AdvisoryRow } from "../coordination-advisories.ts";
import type { Directory, DirectoryListArgs, DirectoryListRow } from "../directory.ts";
import { readApiDepsFromSecret } from "../lambda.ts";
import type { RelayfactsRecordRow } from "../relayfacts.ts";
import { readApiServiceApp } from "../server.ts";
import {
  READ_API_SESSION_VISIBILITY_GROUPS_VAR, parseSessionVisibilityGroups, sessionVisibility, visibilityLiveness,
  type VisibilityMark, type VisibilityStore, type VisibilityView,
} from "../session-visibility.ts";
import { memoryLiveness } from "./support.ts";

const ORG = "org-a", WS = "ws-a";
const MEMBER = "00000000-0000-4000-8000-000000000001";
const MARKER = "00000000-0000-4000-8000-000000000002";
const OUTSIDER = "00000000-0000-4000-8000-000000000003";
const FINANCE = "00000000-0000-4000-8000-000000000004";
const BOTH = "00000000-0000-4000-8000-000000000005";
const GROUPS = JSON.stringify({ leadership: { members: [MEMBER, BOTH], markers: [MARKER] }, finance: { members: [FINANCE, BOTH] } });
/** The secret session: uploaded as SECRET_PHYS, known to the directory and search as SECRET; SECRET_CHILD is a session it spawned. */
const SECRET = "11111111-1111-4111-8111-111111111111", SECRET_PHYS = "upload-0001", SECRET_CHILD = "22222222-2222-4222-8222-222222222222";
const OPEN = "33333333-3333-4333-8333-333333333333";
const PARENT = "88888888-8888-4888-8888-888888888888";
const NOT_FOUND = { code: "not_found", message: "Session not found" };

const USERS: Record<string, string> = { member: MEMBER, marker: MARKER, outsider: OUTSIDER, finance: FINANCE, both: BOTH, service: "read-api-service", nouser: "" };

/** An in-memory VisibilityStore with the SQL functions' semantics; `inherits` maps a marked id to the ids its mark reaches. */
function memoryStore(inherits: Record<string, string[]> = { [SECRET]: [SECRET_PHYS, SECRET_CHILD], [SECRET_PHYS]: [SECRET, SECRET_CHILD] }) {
  const rows = new Map<string, { visibility: string; markedBy: string; markedAt: string }>();
  const state = { marksReads: 0, writes: 0, fail: false, beforeSet: undefined as undefined | (() => void) };
  const marks = (): VisibilityMark[] => [...rows].flatMap(([sessionId, m]) => [
    { sessionId, ...m, direct: true },
    ...(inherits[sessionId] ?? []).map((id) => ({ sessionId: id, ...m, direct: false })),
  ]);
  const store: VisibilityStore = {
    async marks() {
      state.marksReads++;
      if (state.fail) throw new Error("db text that must not leak");
      return marks();
    },
    async write(_org, _ws, work) {
      let snapshot = new Map(rows);
      try {
        return await work({
          marks: async () => marks(),
          async set(sessionId, visibility, markedBy) {
            // Another transaction commits between this caller's read and its write: a rollback keeps that commit.
            if (state.beforeSet) {
              state.beforeSet();
              state.beforeSet = undefined;
              snapshot = new Map(rows);
            }
            const previous = rows.get(sessionId)?.visibility ?? null;
            if (visibility === null) rows.delete(sessionId);
            else if (previous === null) { rows.set(sessionId, { visibility, markedBy, markedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, state.writes)).toISOString() }); }
            state.writes++;
            return previous;
          },
        });
      } catch (error) {
        rows.clear();
        for (const [k, v] of snapshot) rows.set(k, v);
        throw error;
      }
    },
  };
  return { store, rows, state, mark: (sessionId: string, visibility: string) => rows.set(sessionId, { visibility, markedBy: MARKER, markedAt: "2026-11-01T00:00:00.000Z" }) };
}

const hit = (sessionId: string, n: number, content: string): SearchHit => ({
  orgId: ORG, workspaceId: WS, tsMs: 1_800_000_000_000 + n, sessionId, source: "codex", machineId: "m-1", kind: "message", eventId: `e-${n}`,
  type: "assistant", userId: "u", actorName: "", actorRole: "assistant", subagentId: "", projectId: "", taskTitle: "", taskRef: "", tags: [], filesTouched: [],
  toolName: "", toolStatus: "", content,
});
const HITS = [hit(OPEN, 1, "needle in the open"), hit(SECRET, 2, "needle and the acquisition plan"), hit(SECRET_PHYS, 3, "needle under the upload id"), hit(SECRET_CHILD, 4, "needle from the subagent"), hit(OPEN, 5, "needle again")];

const dirRow = (sessionId: string, minute: number, title = `title of ${sessionId}`): DirectoryListRow & { cursor_ts: string } => {
  const at = new Date(Date.UTC(2026, 10, 1, 12, minute));
  return {
    org_id: ORG, workspace_id: WS, harness: "codex", session_id: sessionId, created_at: at, last_activity_at: at, cursor_ts: at.toISOString().replace("Z", "000Z"),
    title, task_title: null, agent_names: null, project_id: null, project_key: null, project_key_method: null, git_repo: null, git_branch: null, initial_commit: null,
    originator: null, agent_version: null, models: null, state: null, event_count: 1, input_tokens: 0, output_tokens: 0, cost_usd_micros: null, machine_ids: null,
    user_ids: null, parent_session_ids: null, child_session_count: 0, short_summary: `summary of ${sessionId}`, short_summary_generated_at: at, catalog_projected_at: null, projected_at: at,
  };
};

function fixture(opts: { groups?: string | null; rows?: Array<DirectoryListRow & { cursor_ts: string }>; partials?: string[]; searchSkipsPartialSessions?: boolean; hits?: SearchHit[]; cors?: boolean } = {}) {
  const m = memoryStore();
  const io = { n: 0, queries: [] as SearchQuery[], titleKeys: [] as string[], listCursors: [] as Array<DirectoryListArgs["cursor"]>, advisoryReads: 0, acks: 0 };
  const groups = opts.groups === null ? undefined : parseSessionVisibilityGroups({ [READ_API_SESSION_VISIBILITY_GROUPS_VAR]: opts.groups ?? GROUPS });
  const scope = new AsyncLocalStorage<VisibilityView>();
  const base = memoryLiveness().liveness;
  const index = {
    id: "memory", backend: "postgres",
    capabilities: () => ({ backend: "postgres", filters: ["session", "source", "kind", "project", "since", "until", "exclude_session", "actor"], minIndexedQueryChars: 3, readAfterWrite: "immediate", synchronousErasure: true, versionedUpserts: true }),
    async query(q: SearchQuery) {
      io.n++;
      io.queries.push(q);
      const matching = (opts.hits ?? HITS)
        .filter((h) => (q.sessionId === undefined || h.sessionId === q.sessionId) && !(q.excludeSessionIds ?? []).includes(h.sessionId) && (q.q === undefined || h.content.includes(q.q)))
        .filter((h) => !q.cursor || (q.order === "asc" ? h.tsMs > q.cursor.tsMs : h.tsMs < q.cursor.tsMs))
        .sort((a, b) => (q.order === "asc" ? a.tsMs - b.tsMs : b.tsMs - a.tsMs));
      const page = matching.slice(0, q.limit);
      return { hits: page, ...(matching.length > page.length ? { next: page[page.length - 1] } : {}) };
    },
  } as unknown as SearchIndexAdapter;
  const rows = opts.rows ?? [dirRow(OPEN, 5), dirRow(SECRET, 4, "Acquisition plan"), dirRow("44444444-4444-4444-8444-444444444444", 3), dirRow(SECRET_CHILD, 2, "Subagent of the plan"), dirRow("55555555-5555-4555-8555-555555555555", 1)];
  const page = async (_o: string, _w: string, a: DirectoryListArgs) => {
    io.n++;
    io.listCursors.push(a.cursor);
    const sorted = [...rows].sort((x, y) => y.cursor_ts.localeCompare(x.cursor_ts) || y.session_id.localeCompare(x.session_id));
    const after = a.cursor;
    return sorted
      .filter((r) => !a.sessionKeys || a.sessionKeys.some((k) => k.sessionId === r.session_id))
      .filter((r) => !after || r.cursor_ts < after.lastActivityAt || (r.cursor_ts === after.lastActivityAt && r.session_id < after.sessionId))
      .slice(0, a.limit + 1);
  };
  const directory: Directory = { list: page, query: page, activity: async () => [], queryActivity: async () => [] };
  const pointers = async () => { io.n++; return { pointers: 0, live: 0 }; };
  const records: RelayfactsRecordRow[] = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", topic: "plans", title: "Only from the secret session", statement: "Buy the competitor", status: "decided", supersedes: null, decided_at: "2026-11-01T00:00:00Z", implemented_at: null, implemented_ref: null, created_cursor: "2026-11-01T00:00:00.000000Z",
      evidence: [{ source: "codex", session_id: SECRET, turn_start: 0, turn_end: 1, claim: "secret claim", ref: null }] },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", topic: "plans", title: "From both sessions", statement: "Ship on Friday", status: "decided", supersedes: null, decided_at: "2026-11-01T00:00:00Z", implemented_at: null, implemented_ref: null, created_cursor: "2026-11-01T00:00:01.000000Z",
      evidence: [{ source: "codex", session_id: SECRET_PHYS, turn_start: 0, turn_end: 1, claim: "secret support", ref: null }, { source: "codex", session_id: OPEN, turn_start: 2, turn_end: 3, claim: "open support", ref: null }] },
    { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", topic: "plans", title: "Evidence erased long ago", statement: "Keep the old API", status: "decided", supersedes: null, decided_at: "2026-11-01T00:00:00Z", implemented_at: null, implemented_ref: null, created_cursor: "2026-11-01T00:00:02.000000Z", evidence: [] },
  ];
  const advisory = (id: string, peer: string, evidence: string): AdvisoryRow => ({
    advisoryId: id, harness: "codex", sessionId: OPEN, peerHarness: "codex", peerSessionId: peer, urgency: "high", kind: "concurrent_edit", artifact: "src/a.ts",
    evidence: [{ sessionId: evidence, eventId: "e", ts: "2026-11-01T00:00:00.000Z", kind: "tool" }], createdAt: "2026-11-01T00:00:00.000Z",
  });
  const deps: ReadApiDeps = {
    verify: async (bearer) => {
      if (!(bearer in USERS)) throw new Error("unknown");
      return { orgId: ORG, workspaceId: WS, userId: USERS[bearer]!, scopes: ["rth:read", "rth:sync"] } satisfies VerifiedIdentity;
    },
    adapter: { index, state: { fromMs: async () => 0, record: async () => {}, partials: async () => ({ sessions: opts.partials ?? [], overflow: false }) } },
    liveness: groups ? visibilityLiveness(base, scope) : base,
    completeSinceMs: 0,
    directory, directoryWorkspaces: "*", sessionQuery: true, listShortSummary: true,
    ...(opts.searchSkipsPartialSessions ? { searchSkipsPartialSessions: true } : {}),
    briefSummary: { async read(_o, _w, harness, sessionId) { io.n++; return [{ org_id: ORG, workspace_id: WS, harness, session_id: sessionId, description: "private summary", model: "m", generated_at: new Date() }] as never; } },
    briefTitles: { async titles(_o, _w, keys) { io.n++; io.titleKeys.push(...keys.map((k) => k.sessionId)); return keys.map((k) => ({ org_id: ORG, workspace_id: WS, harness: k.source, session_id: k.sessionId, title: `title of ${k.sessionId}` })) as never; } },
    briefTitleWorkspaces: "*",
    timing: { state: pointers, source: async () => { io.n++; throw new Error("not reached"); }, assumeNoTurns: true },
    turns: { harnesses: async () => { io.n++; return []; }, source: async () => { io.n++; throw new Error("not reached"); } },
    // PARENT is a published session whose canonical objects record two spawned sessions.
    selfhost: { catalog: {
      state: async (identity) => { io.n++; return identity.sessionId === PARENT ? { pointers: 1, live: 1 } : { pointers: 0, live: 0 }; },
      source: async () => { io.n++; return { rows: [SECRET_CHILD, OPEN].map((childId, i) => ({ table: "session_relationships", row: {
        source: "codex", parent_session_id: PARENT, relationship_uid: `rel-${i}`, child_session_id: childId, relationship: "spawn", child_agent_name: `agent of ${childId}`,
        spawned_at: `2026-11-01T00:00:0${i}Z`, received_at: "2026-11-01T00:00:00Z", record_id: `r-${i}` } })) }; },
    } },
    analysis: { harnesses: async () => { io.n++; return []; }, read: async () => { io.n++; return { outcome: "not_found" } as never; }, result: async () => { io.n++; return null; } },
    sessionSources: async () => { io.n++; return []; },
    relayfacts: { topics: async () => [], list: async () => { io.n++; return records; } },
    coordinationAdvisories: { enabled: true, source: {
      async pending() { io.advisoryReads++; return [advisory("00000000000000a1", SECRET, OPEN), advisory("00000000000000a2", "66666666-6666-4666-8666-666666666666", SECRET_PHYS), advisory("00000000000000a3", "66666666-6666-4666-8666-666666666666", OPEN)]; },
      async ack() { io.acks++; return true; },
    } },
    babysitter: {} as never,
    ...(opts.cors ? { corsAllowedOrigins: new Set(["https://app.example.test"]) } : {}),
    ...(groups ? { sessionVisibility: sessionVisibility(groups, m.store, scope) } : {}),
  };
  const app = createReadApi(deps);
  const call = (who: string, path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { authorization: `Bearer ${who}`, ...(init.headers as Record<string, string> | undefined) } });
  const post = (who: string, sessionId: string, body: unknown, ws = WS) => call(who, `/v1/sessions/${encodeURIComponent(sessionId)}/visibility?workspace=${ws}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { app, call, post, io, ...m };
}

type Body = Record<string, any>;
const json = async (r: Response) => (await r.json()) as Body;
const sessionRoutes = (id: string): Array<[string, RequestInit?]> => [
  [`/v1/sessions/${id}/events?workspace=${WS}`],
  [`/v1/sessions/${id}/events?workspace=${WS}&source=codex`],
  [`/v1/sessions/${id}/events?workspace=${WS}&source=codex&order=desc&limit=1`],
  [`/v1/sessions/${id}/summary?workspace=${WS}&source=codex`],
  [`/v1/sessions/${id}/summary?workspace=${WS}`],
  [`/v1/sessions/${id}/timing?workspace=${WS}&source=codex`],
  [`/v1/sessions/${id}/timing?workspace=${WS}`],
  [`/v1/sessions/${id}/turns?workspace=${WS}`],
  [`/v1/sessions/${id}/turns?workspace=${WS}&source=codex`],
  [`/v1/sessions/${id}/metadata?workspace=${WS}`],
  [`/v1/sessions/${id}/catalog?workspace=${WS}&source=codex`],
  [`/v1/sessions/${id}/sources?workspace=${WS}`],
  [`/v1/sessions/${id}/analysis?workspace=${WS}`],
  [`/v1/sessions/${id}/analysis?workspace=${WS}`, { method: "POST" }],
  // A sub-path the API does not serve, and bad parameters: still the same answer.
  [`/v1/sessions/${id}/anything-new?workspace=${WS}`],
  [`/v1/sessions/${id}/events?workspace=${WS}&limit=notanumber&unknown=1&q=x`],
  [`/v1/sessions/${id}/timing?workspace=${WS}&source=a&source=b`],
];

describe("unconfigured: READ_API_SESSION_VISIBILITY_GROUPS unset", () => {
  test("no marks read, no route, and a mark in the table changes nothing", async () => {
    const f = fixture({ groups: null });
    f.mark(SECRET, "leadership");
    for (const who of ["member", "outsider"]) {
      const events = await f.call(who, `/v1/sessions/${SECRET}/events?workspace=${WS}`);
      expect((await json(events)).events.map((e: Body) => e.content)).toEqual(["needle and the acquisition plan"]);
      const search = await json(await f.call(who, `/v1/events?workspace=${WS}&q=needle&limit=50`));
      expect(search.events).toHaveLength(5);
      expect((await json(await f.call(who, `/v1/sessions?workspace=${WS}`))).sessions.map((s: Body) => s.sessionId)).toContain(SECRET);
      expect((await json(await f.call(who, `/v1/sessions/titles?workspace=${WS}&key=codex:${SECRET}`))).titles).toHaveLength(1);
    }
    expect(f.io.queries.every((q) => q.excludeSessionIds === undefined)).toBe(true);
    // The routes do not exist: the app's ordinary unknown-route answer, for GET and POST.
    for (const init of [{}, { method: "POST", body: "{}" }]) {
      const r = await f.call("member", `/v1/sessions/${SECRET}/visibility?workspace=${WS}`, init);
      expect([r.status, (await json(r)).error.reason]).toEqual([501, "route"]);
    }
    expect(f.state.marksReads).toBe(0);
    // The service entry does not let the POST through either.
    const service = readApiServiceApp(f.app);
    expect((await service.request(`/v1/sessions/${SECRET}/visibility?workspace=${WS}`, { method: "POST", headers: { authorization: "Bearer member" }, body: "{}" })).status).toBe(405);
  });

  test("configured with no marks: every read answers exactly as the unconfigured app, after one marks read", async () => {
    const off = fixture({ groups: null }), on = fixture();
    const paths = [`/v1/sessions/${SECRET}/events?workspace=${WS}`, `/v1/events?workspace=${WS}&q=needle&limit=2`, `/v1/events?workspace=${WS}&session=${SECRET}`, `/v1/sessions?workspace=${WS}&limit=2`,
      `/v1/sessions?workspace=${WS}&q=title`, `/v1/sessions/titles?workspace=${WS}&key=codex:${SECRET}`, `/v1/sessions/${SECRET}/summary?workspace=${WS}&source=codex`, `/v1/relayfacts/plans?workspace=${WS}`,
      `/v1/coordination/advisories?workspace=${WS}&source=codex&sessionId=${OPEN}`, `/v1/sessions/${SECRET}/catalog?workspace=${WS}&source=codex`];
    for (const path of paths) {
      const [a, b] = [await off.call("outsider", path), await on.call("outsider", path)];
      const strip = (body: Body) => ({ ...body, correlationId: undefined });
      expect([path, b.status, strip(await json(b))]).toEqual([path, a.status, strip(await json(a))]);
    }
    expect(on.state.marksReads).toBe(paths.length);
    expect(on.io.queries.every((q) => q.excludeSessionIds === undefined)).toBe(true);
  });
});

describe("per-session routes: /v1/sessions/:sessionId/*", () => {
  test("a hidden session is the erase fence's 404 before any read, for every route, id form, parameter set and non-member", async () => {
    const f = fixture();
    f.mark(SECRET_PHYS, "leadership"); // marked by the upload id: the logical id and the spawned session are hidden with it
    for (const id of [SECRET, SECRET_PHYS, SECRET_CHILD]) {
      for (const who of ["outsider", "marker", "finance", "service", "nouser"]) {
        for (const [path, init] of sessionRoutes(id)) {
          f.io.n = 0;
          const r = await f.call(who, path, init);
          expect([who, init?.method ?? "GET", path, r.status, (await json(r)).error]).toEqual([who, init?.method ?? "GET", path, 404, NOT_FOUND]);
          expect(f.io.n).toBe(0);
        }
      }
    }
    // HEAD is routed as GET: the same refusal, and no body.
    const head = await f.call("outsider", `/v1/sessions/${SECRET}/events?workspace=${WS}`, { method: "HEAD" });
    expect([head.status, await head.text()]).toEqual([404, ""]);
    // Percent-encoding the id does not get around the gate.
    const encoded = [...SECRET].map((ch) => `%${ch.charCodeAt(0).toString(16)}`).join("");
    expect((await f.call("outsider", `/v1/sessions/${encoded}/events?workspace=${WS}`)).status).toBe(404);
    expect(f.io.n).toBe(0);
  });

  test("a member reads it as before; an unmarked session is unchanged for everyone", async () => {
    const f = fixture();
    f.mark(SECRET_PHYS, "leadership");
    const unconfigured = fixture({ groups: null });
    for (const [who, id] of [["member", SECRET], ["member", SECRET_PHYS], ["member", SECRET_CHILD], ["both", SECRET], ["outsider", OPEN], ["service", OPEN], ["marker", OPEN]] as const) {
      for (const [path, init] of sessionRoutes(id).slice(0, 14)) {
        f.io.n = 0;
        const [r, same] = [await f.call(who, path, init), await unconfigured.call(who, path, init)];
        const body = await r.text();
        expect([who, path, r.status]).toEqual([who, path, same.status]);
        expect([path, body.replace(/"correlationId":"[^"]+"/u, "")]).toEqual([path, (await same.text()).replace(/"correlationId":"[^"]+"/u, "")]);
        // The route ran: it reached its own dependency (the two source-less 400s answer before any read).
        if (r.status !== 400) expect([path, f.io.n > 0]).toEqual([path, true]);
      }
    }
    expect((await json(await f.call("member", `/v1/sessions/${SECRET}/events?workspace=${WS}`))).events.map((e: Body) => e.content)).toEqual(["needle and the acquisition plan"]);
    expect(await (await f.call("member", `/v1/sessions/${SECRET}/summary?workspace=${WS}&source=codex`)).text()).toContain("private summary");
  });

  test("a session id that equals a literal route name never breaks the list routes for the workspace", async () => {
    const f = fixture();
    for (const id of ["activity", "users", "output", "titles", "summaries"]) f.mark(id, "leadership");
    const unconfigured = fixture({ groups: null });
    for (const path of [`/v1/sessions/activity?workspace=${WS}&since=2026-11-01T00:00:00Z&until=2026-11-02T00:00:00Z`, `/v1/sessions/users?workspace=${WS}&lastTsAfter=2026-11-01T00:00:00Z&lastTsBefore=2026-11-02T00:00:00Z`,
      `/v1/sessions/output?workspace=${WS}&since=2026-11-01T00:00:00Z&until=2026-11-02T00:00:00Z`, `/v1/sessions/titles?workspace=${WS}&key=codex:${OPEN}`,
      `/v1/sessions/summaries/activity?workspace=${WS}&since=2026-11-01T00:00:00Z&until=2026-11-02T00:00:00Z`, `/v1/sessions/summaries/search?workspace=${WS}&q=plan`]) {
      const [r, same] = [await f.call("outsider", path), await unconfigured.call("outsider", path)];
      expect([path, r.status]).toEqual([path, same.status]);
      expect(r.status).not.toBe(404);
    }
    // As a session id it is still gated.
    expect((await f.call("outsider", `/v1/sessions/activity/events?workspace=${WS}`)).status).toBe(404);
    expect((await f.call("outsider", `/v1/sessions/summaries/summary?workspace=${WS}&source=codex`)).status).toBe(404);
  });

  test("a visible parent's catalog does not list a hidden child", async () => {
    const f = fixture();
    f.mark(SECRET_CHILD, "leadership");
    const children = async (who: string) => {
      const r = await f.call(who, `/v1/sessions/${PARENT}/catalog?workspace=${WS}&source=codex`);
      expect(r.status).toBe(200);
      const text = await r.text();
      return [(JSON.parse(text) as Body).children.map((c: Body) => c.childSessionId), text.includes(`agent of ${SECRET_CHILD}`)];
    };
    expect(await children("member")).toEqual([[SECRET_CHILD, OPEN], true]);
    expect(await children("outsider")).toEqual([[OPEN], false]);
    expect(await children("marker")).toEqual([[OPEN], false]);
    expect((await f.call("outsider", `/v1/sessions/${SECRET_CHILD}/catalog?workspace=${WS}&source=codex`)).status).toBe(404);
  });
});

describe("/v1/events", () => {
  test("session=: hidden is 404 with no read; search: hidden sessions are excluded by the index on every page", async () => {
    const f = fixture();
    f.mark(SECRET, "leadership");
    for (const id of [SECRET, SECRET_PHYS, SECRET_CHILD]) {
      for (const extra of ["", "&source=codex", "&q=needle", "&order=asc&limit=1"]) {
        f.io.n = 0;
        const r = await f.call("outsider", `/v1/events?workspace=${WS}&session=${id}${extra}`);
        expect([id, extra, r.status, (await json(r)).error]).toEqual([id, extra, 404, NOT_FOUND]);
        expect(f.io.n).toBe(0);
      }
    }
    expect((await json(await f.call("member", `/v1/events?workspace=${WS}&session=${SECRET}`))).events).toHaveLength(1);
    // Search, paged one row at a time: only the open session's rows, and no cursor ever stands on a hidden row.
    const seen: string[] = [];
    let cursor: string | null = null;
    f.io.queries.length = 0;
    do {
      const r: Response = await f.call("outsider", `/v1/events?workspace=${WS}&q=needle&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(r.status).toBe(200);
      const body = await json(r);
      seen.push(...body.events.map((e: Body) => `${e.sessionId}:${e.content}`));
      expect(body.events).toHaveLength(1);
      cursor = body.nextCursor;
      if (cursor) for (const id of [SECRET, SECRET_PHYS, SECRET_CHILD]) expect(atob(cursor.split(":").pop()!.replace(/-/gu, "+").replace(/_/gu, "/"))).not.toContain(id);
    } while (cursor);
    expect(seen).toEqual([`${OPEN}:needle again`, `${OPEN}:needle in the open`]);
    for (const q of f.io.queries) expect([...(q.excludeSessionIds ?? [])].sort()).toEqual([SECRET, SECRET_PHYS, SECRET_CHILD].sort());
    // Nothing that only the hidden session says can be found, or told from a word nobody said.
    const [hiddenWord, noWord] = [await json(await f.call("outsider", `/v1/events?workspace=${WS}&q=acquisition&limit=50`)), await json(await f.call("outsider", `/v1/events?workspace=${WS}&q=zebra&limit=50`))];
    expect({ ...hiddenWord, correlationId: 0 }).toEqual({ ...noWord, correlationId: 0 });
    expect(hiddenWord).toMatchObject({ events: [], nextCursor: null });
    // A member's search is not filtered.
    f.io.queries.length = 0;
    expect((await json(await f.call("member", `/v1/events?workspace=${WS}&q=needle&limit=50`))).events).toHaveLength(5);
    expect(f.io.queries[0]!.excludeSessionIds).toBeUndefined();
  });

  test("partial sessions are still excluded, a hidden one is never named, and more hidden ids than the index excludes is refused", async () => {
    const f = fixture({ searchSkipsPartialSessions: true, partials: [SECRET, "77777777-7777-4777-8777-777777777777"] });
    f.mark(SECRET, "leadership");
    const r = await json(await f.call("outsider", `/v1/events?workspace=${WS}&q=needle&limit=50`));
    expect(r.incomplete).toEqual({ reason: "session_partial", sessions: ["77777777-7777-4777-8777-777777777777"] });
    expect([...(f.io.queries.at(-1)!.excludeSessionIds ?? [])].sort()).toEqual([SECRET, SECRET_PHYS, SECRET_CHILD, "77777777-7777-4777-8777-777777777777"].sort());
    expect((await json(await f.call("member", `/v1/events?workspace=${WS}&q=needle&limit=50`))).incomplete.sessions).toEqual([SECRET, "77777777-7777-4777-8777-777777777777"]);

    const many = fixture();
    for (let i = 0; i <= 1000; i++) many.mark(`bulk-${i}`, "leadership");
    many.io.n = 0;
    const refused = await many.call("outsider", `/v1/events?workspace=${WS}&q=needle&limit=50`);
    expect([refused.status, (await json(refused)).error.reason]).toEqual([501, "session_visibility_unbounded"]);
    expect(many.io.queries).toEqual([]);
    expect((await many.call("member", `/v1/events?workspace=${WS}&q=needle&limit=50`)).status).toBe(200);
  });
});

describe("GET /v1/sessions (list and q)", () => {
  test("hidden rows are absent, pages stay full, and no cursor carries a hidden session's id or time", async () => {
    const f = fixture();
    f.mark(SECRET, "leadership");
    const visible = [OPEN, "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
    for (const query of ["", "&q=title", "&includeShortSummary=recorded"]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const r: Response = await f.call("outsider", `/v1/sessions?workspace=${WS}&limit=1${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        expect(r.status).toBe(200);
        const text = await r.text();
        for (const secret of [SECRET, SECRET_CHILD, "Acquisition plan", "Subagent of the plan", `summary of ${SECRET}`]) expect(text).not.toContain(secret);
        const body = JSON.parse(text) as Body;
        expect(body.sessions).toHaveLength(1);
        seen.push(body.sessions[0].sessionId);
        cursor = body.nextCursor;
        if (cursor) {
          const decoded = atob(cursor.split(":").pop()!.replace(/-/gu, "+").replace(/_/gu, "/"));
          expect(decoded).toContain(seen.at(-1)!);
          for (const hiddenValue of [SECRET, SECRET_CHILD, "12:04", "12:02"]) expect(decoded).not.toContain(hiddenValue);
        }
      } while (cursor);
      expect([query, seen]).toEqual([query, visible]);
    }
    // One page of everything: the member sees five, the outsider three, in the same order.
    const ids = async (who: string, q = "") => (await json(await f.call(who, `/v1/sessions?workspace=${WS}${q}`))).sessions.map((s: Body) => s.sessionId);
    expect(await ids("member")).toEqual([OPEN, SECRET, "44444444-4444-4444-8444-444444444444", SECRET_CHILD, "55555555-5555-4555-8555-555555555555"]);
    expect(await ids("outsider")).toEqual(visible);
    expect(await ids("marker")).toEqual(visible);
    expect(await ids("service")).toEqual(visible);
    // Asking for it by name or id finds nothing, exactly like a session that does not exist.
    expect(await ids("outsider", `&q=${encodeURIComponent("Acquisition")}`)).toEqual(await ids("outsider", "&q=zebra"));
    // Activity counts of a text query would be a word-by-word oracle over hidden titles: refused, with no read.
    const activity = (who: string, q: string) => f.call(who, `/v1/sessions/activity?workspace=${WS}&since=2026-11-01T00:00:00Z&until=2026-11-02T00:00:00Z${q}`);
    f.io.n = 0;
    for (const who of ["outsider", "marker", "service"]) {
      const r = await activity(who, "&q=Acquisition");
      expect([who, r.status, (await json(r)).error.reason]).toEqual([who, 501, "param_q"]);
    }
    expect(f.io.n).toBe(0);
    expect((await activity("member", "&q=Acquisition")).status).toBe(200);
    expect((await activity("outsider", "")).status).toBe(200);
  });

  test("a run of hidden rows longer than the read bound is refused, never served short or unfiltered", async () => {
    const rows = [dirRow(OPEN, 59), ...Array.from({ length: 30 }, (_, i) => dirRow(`bulk-${String(i).padStart(2, "0")}`, 58 - i)), dirRow("55555555-5555-4555-8555-555555555555", 1)];
    const f = fixture({ rows });
    for (let i = 0; i < 30; i++) f.mark(`bulk-${String(i).padStart(2, "0")}`, "leadership");
    // limit 5: six reads cover the 30 hidden rows, so the page fills and ends.
    const ok = await json(await f.call("outsider", `/v1/sessions?workspace=${WS}&limit=5`));
    expect(ok.sessions.map((s: Body) => s.sessionId)).toEqual([OPEN, "55555555-5555-4555-8555-555555555555"]);
    expect(ok.nextCursor).toBeNull();
    // limit 1: finding the row after the first needs more than twenty reads.
    f.io.listCursors.length = 0;
    const refused = await f.call("outsider", `/v1/sessions?workspace=${WS}&limit=1`);
    expect([refused.status, (await json(refused)).error.reason]).toEqual([501, "session_visibility_unbounded"]);
    expect(f.io.listCursors).toHaveLength(20);
    // The member's read of the same page is the one read it always was.
    f.io.listCursors.length = 0;
    expect((await json(await f.call("member", `/v1/sessions?workspace=${WS}&limit=1`))).sessions.map((s: Body) => s.sessionId)).toEqual([OPEN]);
    expect(f.io.listCursors).toHaveLength(1);
  });
});

describe("titles, relayfacts, advisories and the routes with no filter", () => {
  test("titles: a hidden key is dropped before the read and answers like a session with no title", async () => {
    const f = fixture();
    f.mark(SECRET, "leadership");
    const r = await json(await f.call("outsider", `/v1/sessions/titles?workspace=${WS}&key=codex:${SECRET}&key=codex:${OPEN}&key=claude:${SECRET_PHYS}&key=codex:${SECRET_CHILD}`));
    expect(r.titles).toEqual([{ source: "codex", sessionId: OPEN, title: `title of ${OPEN}` }]);
    expect(f.io.titleKeys).toEqual([OPEN]);
    f.io.n = 0;
    expect((await json(await f.call("outsider", `/v1/sessions/titles?workspace=${WS}&key=codex:${SECRET}`))).titles).toEqual([]);
    expect(f.io.n).toBe(0);
    expect((await json(await f.call("member", `/v1/sessions/titles?workspace=${WS}&key=codex:${SECRET}`))).titles).toHaveLength(1);
  });

  test("relayfacts: evidence of a hidden session is dropped, and a record supported only by hidden sessions with it", async () => {
    const f = fixture();
    f.mark(SECRET, "leadership");
    const outsider = await json(await f.call("outsider", `/v1/relayfacts/plans?workspace=${WS}`));
    expect(outsider.records).toBe(2);
    for (const secret of ["Buy the competitor", "Only from the secret session", "secret claim", "secret support", SECRET, SECRET_PHYS]) expect(outsider.markdown).not.toContain(secret);
    for (const open of ["Ship on Friday", "open support", "Keep the old API"]) expect(outsider.markdown).toContain(open);
    const member = await json(await f.call("member", `/v1/relayfacts/plans?workspace=${WS}`));
    expect(member.records).toBe(3);
    for (const text of ["Buy the competitor", "secret claim", "secret support"]) expect(member.markdown).toContain(text);
  });

  test("advisories: a hidden recipient reads and acks nothing; a hidden peer or evidence session is not served", async () => {
    const f = fixture();
    f.mark(SECRET, "leadership");
    const mine = await json(await f.call("outsider", `/v1/coordination/advisories?workspace=${WS}&source=codex&sessionId=${OPEN}`));
    expect(mine.advisories.map((a: Body) => a.advisoryId)).toEqual(["00000000000000a3"]);
    expect(JSON.stringify(mine)).not.toContain(SECRET);
    expect((await json(await f.call("member", `/v1/coordination/advisories?workspace=${WS}&source=codex&sessionId=${OPEN}`))).advisories).toHaveLength(3);
    f.io.advisoryReads = 0;
    const hiddenRecipient = await f.call("outsider", `/v1/coordination/advisories?workspace=${WS}&source=codex&sessionId=${SECRET_PHYS}`);
    expect([hiddenRecipient.status, (await json(hiddenRecipient)).advisories]).toEqual([200, []]);
    expect(f.io.advisoryReads).toBe(0);
    const ack = (who: string, sessionId: string) => f.call(who, `/v1/coordination/advisories/00000000000000a1/ack?workspace=${WS}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "codex", sessionId }) });
    expect((await ack("outsider", SECRET)).status).toBe(404);
    expect(f.io.acks).toBe(0);
    expect((await ack("member", SECRET)).status).toBe(204);
    expect((await ack("outsider", OPEN)).status).toBe(204);
  });

  test("delivery records carry no filter and are not served while visibility is configured", async () => {
    const r = await fixture().call("member", "/v1/delivery/records");
    expect([r.status, (await json(r)).error.reason]).toEqual([501, "delivery_records_not_configured"]);
  });
});

describe("fail closed", () => {
  test("a label the configuration does not name hides the session from everyone, members of other groups included", async () => {
    const f = fixture();
    f.mark(SECRET, "retired-group");
    for (const who of ["member", "marker", "finance", "both", "outsider", "service"]) {
      expect([who, (await f.call(who, `/v1/sessions/${SECRET}/events?workspace=${WS}`)).status]).toEqual([who, 404]);
      expect((await json(await f.call(who, `/v1/sessions?workspace=${WS}`))).sessions.map((s: Body) => s.sessionId)).not.toContain(SECRET);
      expect((await json(await f.call(who, `/v1/events?workspace=${WS}&q=needle&limit=50`))).events.map((e: Body) => e.sessionId)).toEqual([OPEN, OPEN]);
      // Nobody has a role in it: its mark reads as not found, and it cannot be cleared or replaced.
      expect((await f.call(who, `/v1/sessions/${SECRET}/visibility?workspace=${WS}`)).status).toBe(404);
    }
    for (const who of ["member", "both"]) for (const visibility of ["workspace", "leadership"]) expect((await f.post(who, SECRET, { visibility })).status).toBe(403);
    expect(f.rows.get(SECRET)!.visibility).toBe("retired-group");
  });

  test("two marks on one session: only a member of both groups reads it", async () => {
    const f = fixture();
    f.mark(SECRET, "leadership");
    f.mark(SECRET_PHYS, "finance");
    const status = async (who: string) => (await f.call(who, `/v1/sessions/${SECRET}/events?workspace=${WS}`)).status;
    expect([await status("member"), await status("finance"), await status("outsider"), await status("both")]).toEqual([404, 404, 404, 200]);
  });

  test("a failed marks read fails every request: 503, nothing read, no database text", async () => {
    const f = fixture();
    f.mark(SECRET, "leadership");
    f.state.fail = true;
    for (const [path, init] of [...sessionRoutes(OPEN).slice(0, 14), [`/v1/sessions?workspace=${WS}`], [`/v1/events?workspace=${WS}&q=needle&limit=50`], [`/v1/sessions/titles?workspace=${WS}&key=codex:${OPEN}`],
      [`/v1/sessions/${OPEN}/visibility?workspace=${WS}`], [`/v1/relayfacts/plans?workspace=${WS}`], [`/v1/digest/daily?workspace=${WS}&date=2026-11-01`]] as Array<[string, RequestInit?]>) {
      f.io.n = 0;
      const r = await f.call("member", path, init);
      const text = await r.text();
      expect([path, r.status, JSON.parse(text).error.code]).toEqual([path, 503, "backend_unavailable"]);
      expect(text).not.toContain("db text");
      expect(f.io.n).toBe(0);
    }
    // Authentication still comes first: no marks read for an unauthenticated request.
    const reads = f.state.marksReads;
    expect((await f.app.request(`/v1/sessions?workspace=${WS}`)).status).toBe(401);
    expect((await f.call("nobody", `/v1/sessions?workspace=${WS}`)).status).toBe(401);
    expect(f.state.marksReads).toBe(reads);
  });

  test("the liveness wrapper adds the caller's hidden sessions to the erased set, and refuses outside a request", async () => {
    const scope = new AsyncLocalStorage<VisibilityView>();
    const wrapped = visibilityLiveness(memoryLiveness({ erased: [{ source: "codex", sessionId: "gone" }] }).liveness, scope);
    const keys = [{ source: "codex", sessionId: "gone" }, { source: "codex", sessionId: SECRET }, { source: "claude", sessionId: SECRET }, { source: "codex", sessionId: OPEN }];
    await expect(wrapped.erased(ORG, WS, keys)).rejects.toThrow("no request view in scope");
    const view = { hidden: new Set([SECRET]), hides: (id: unknown) => id === SECRET, state: () => { throw new Error("unused"); } } as VisibilityView;
    const erased = await scope.run(view, () => wrapped.erased(ORG, WS, keys));
    expect([...erased].sort()).toEqual([`claude\u0000${SECRET}`, `codex\u0000${SECRET}`, "codex\u0000gone"].sort());
  });
});

describe("GET and POST /v1/sessions/:sessionId/visibility", () => {
  const get = async (f: ReturnType<typeof fixture>, who: string, id: string) => {
    const r = await f.call(who, `/v1/sessions/${id}/visibility?workspace=${WS}`);
    return r.status === 200 ? { ...(await json(r)), correlationId: undefined } : r.status;
  };

  test("a marker sets the mark, before the session exists, and can verify it but neither read nor clear it", async () => {
    const f = fixture();
    const set = await f.post("marker", SECRET, { visibility: "leadership" });
    expect(set.status).toBe(200);
    const state = await json(set);
    expect(state).toMatchObject({ sessionId: SECRET, visibility: "leadership", markedBy: MARKER });
    expect(Number.isFinite(Date.parse(state.markedAt))).toBe(true);
    expect(Object.keys(state).sort()).toEqual(["correlationId", "markedAt", "markedBy", "sessionId", "visibility"]);
    // It takes effect on the very next request, for the marker too.
    expect((await f.call("marker", `/v1/sessions/${SECRET}/events?workspace=${WS}`)).status).toBe(404);
    expect((await f.call("outsider", `/v1/sessions/${SECRET_CHILD}/summary?workspace=${WS}&source=codex`)).status).toBe(404);
    expect((await f.call("member", `/v1/sessions/${SECRET}/events?workspace=${WS}`)).status).toBe(200);
    // Idempotent: the first mark stands, whoever repeats it.
    for (const who of ["marker", "member"]) expect(await json(await f.post(who, SECRET, { visibility: "leadership" }))).toMatchObject({ visibility: "leadership", markedBy: MARKER, markedAt: state.markedAt });
    expect(f.state.writes).toBe(1);
    expect(await get(f, "marker", SECRET)).toMatchObject({ sessionId: SECRET, visibility: "leadership", markedBy: MARKER });
    // The other id form and the spawned session report the inherited mark.
    expect(await get(f, "marker", SECRET_PHYS)).toMatchObject({ sessionId: SECRET_PHYS, visibility: "leadership" });
    expect(await get(f, "member", SECRET_CHILD)).toMatchObject({ visibility: "leadership" });
    expect(await get(f, "marker", OPEN)).toEqual({ sessionId: OPEN, visibility: "workspace", markedBy: null, markedAt: null, correlationId: undefined });
    // The marker cannot clear it; a member can, and then everyone reads the session again.
    const refused = await f.post("marker", SECRET, { visibility: "workspace" });
    expect([refused.status, (await json(refused)).error.code]).toEqual([403, "forbidden"]);
    expect(f.rows.has(SECRET)).toBe(true);
    expect(await json(await f.post("member", SECRET, { visibility: "workspace" }))).toMatchObject({ sessionId: SECRET, visibility: "workspace", markedBy: null, markedAt: null });
    expect(await json(await f.post("member", SECRET, { visibility: "workspace" }))).toMatchObject({ visibility: "workspace" });
    expect((await f.call("outsider", `/v1/sessions/${SECRET}/events?workspace=${WS}`)).status).toBe(200);
  });

  test("who may do what: no role is 403/404 without a write; another group's mark cannot be seen, replaced or cleared", async () => {
    const f = fixture();
    for (const who of ["outsider", "service", "nouser"]) {
      for (const visibility of ["leadership", "workspace", "no-such-group"]) {
        const r = await f.post(who, OPEN, { visibility });
        expect([who, visibility, r.status, (await json(r)).error.code]).toEqual([who, visibility, 403, "forbidden"]);
      }
      expect(await get(f, who, OPEN)).toBe(404);
      expect(await get(f, who, SECRET)).toBe(404);
    }
    expect(f.state.writes).toBe(0);
    // A role in one group gives none in another.
    expect((await f.post("marker", OPEN, { visibility: "finance" })).status).toBe(403);
    expect((await f.post("member", OPEN, { visibility: "finance" })).status).toBe(403);
    expect((await f.post("finance", OPEN, { visibility: "finance" })).status).toBe(200);
    for (const who of ["member", "marker"]) {
      expect(await get(f, who, OPEN)).toBe(404);
      for (const visibility of ["leadership", "workspace"]) expect([who, visibility, (await f.post(who, OPEN, { visibility })).status]).toEqual([who, visibility, 403]);
    }
    expect(f.rows.get(OPEN)!.visibility).toBe("finance");
    // A member of both groups replaces it in one call.
    expect(await json(await f.post("both", OPEN, { visibility: "leadership" }))).toMatchObject({ visibility: "leadership", markedBy: BOTH });
    expect(f.rows.get(OPEN)!.visibility).toBe("leadership");
    // The 403s say the same thing whatever the reason.
    const messages = new Set<string>();
    for (const [who, id, visibility] of [["outsider", OPEN, "leadership"], ["marker", OPEN, "workspace"], ["finance", OPEN, "finance"], ["marker", OPEN, "finance"]] as const)
      messages.add((await json(await f.post(who, id, { visibility }))).error.message);
    expect([...messages]).toEqual(["not allowed to change this session's visibility"]);
  });

  test("bad requests: body, group, session id, workspace; a lost race is a 409 that leaves the other mark alone", async () => {
    const f = fixture();
    for (const body of ["", "not json", "[]", "null", "{}", { visibility: 1 }, { visibility: "" }, { visibility: "leadership", extra: true }, { visibility: "x".repeat(65) }]) {
      const r = await f.post("member", OPEN, body);
      expect([JSON.stringify(body), r.status, (await json(r)).error.code]).toEqual([JSON.stringify(body), 400, "bad_request"]);
    }
    for (const visibility of ["no-such-group", "Leadership", "workspace "]) {
      const r = await f.post("member", OPEN, { visibility });
      expect([visibility, r.status, (await json(r)).error.message]).toEqual([visibility, 400, "visibility must be workspace or a configured group"]);
    }
    expect((await f.post("member", "x".repeat(513), { visibility: "leadership" })).status).toBe(400);
    expect((await f.post("member", "a\u0001b", { visibility: "leadership" })).status).toBe(400);
    expect((await f.post("member", OPEN, { visibility: "leadership" }, "ws-other")).status).toBe(403);
    expect((await f.call("member", `/v1/sessions/${OPEN}/visibility`, { method: "POST", body: "{}" })).status).toBe(501); // org scope: as every route
    expect((await f.call("member", `/v1/sessions/${OPEN}/visibility?workspace=ws-other`)).status).toBe(403);
    const big = await f.post("member", OPEN, JSON.stringify({ visibility: "leadership", pad: "x".repeat(9000) }));
    expect(big.status).toBe(413);
    expect(f.state.writes).toBe(0);
    // Someone marks it for finance between this caller's check and its write.
    f.state.beforeSet = () => f.mark(OPEN, "finance");
    const raced = await f.post("member", OPEN, { visibility: "leadership" });
    expect([raced.status, (await json(raced)).error.code]).toEqual([409, "conflict"]);
    expect(f.rows.get(OPEN)!.visibility).toBe("finance");
    // ...or replaces the mark this caller was about to clear: the caller's delete is rolled back.
    f.rows.clear();
    f.mark(OPEN, "leadership");
    f.state.beforeSet = () => f.mark(OPEN, "finance");
    expect((await f.post("member", OPEN, { visibility: "workspace" })).status).toBe(409);
    expect(f.rows.get(OPEN)!.visibility).toBe("finance");
  });

  test("the service entry lets the POST through only when configured; CORS preflight allows it and reveals nothing", async () => {
    const f = fixture({ cors: true });
    f.mark(SECRET, "leadership");
    const on = readApiServiceApp(f.app, { cors: true, sessionVisibility: true }), off = readApiServiceApp(f.app, { cors: true });
    const send = (app: typeof on, path: string, method: string) => app.request(path, { method, headers: { authorization: "Bearer member", "content-type": "application/json" }, body: JSON.stringify({ visibility: "leadership" }) });
    expect((await send(on, `/v1/sessions/${OPEN}/visibility?workspace=${WS}`, "POST")).status).toBe(200);
    expect((await send(off, `/v1/sessions/${OPEN}/visibility?workspace=${WS}`, "POST")).status).toBe(405);
    for (const method of ["PUT", "DELETE", "PATCH"]) expect((await send(on, `/v1/sessions/${OPEN}/visibility?workspace=${WS}`, method)).status).toBe(405);
    // No other path becomes writable, encoded or not.
    for (const path of [`/v1/sessions/${OPEN}/visibility/x`, `/v1/sessions/${OPEN}/events`, `/v1/sessions/${OPEN}/visibilit%79`, "/v1/sessions/visibility"]) expect([path, (await send(on, `${path}?workspace=${WS}`, "POST")).status]).toEqual([path, 405]);
    // Preflight: the same answer for a hidden, an open and an unknown session, without a bearer.
    const preflight = async (id: string) => {
      const r = await f.app.request(`/v1/sessions/${id}/visibility?workspace=${WS}`, { method: "OPTIONS", headers: { origin: "https://app.example.test", "access-control-request-method": "POST" } });
      return [r.status, r.headers.get("access-control-allow-methods"), r.headers.get("access-control-allow-headers"), await r.text()];
    };
    expect(await preflight(SECRET)).toEqual([204, "GET, POST", "authorization, content-type, x-correlation-id", ""]);
    expect(await preflight(OPEN)).toEqual(await preflight(SECRET));
    expect(await preflight("no-such-session")).toEqual(await preflight(SECRET));
    const reads = await f.app.request(`/v1/sessions/${SECRET}/events?workspace=${WS}`, { method: "OPTIONS", headers: { origin: "https://app.example.test" } });
    expect(reads.headers.get("access-control-allow-methods")).toBe("GET");
    expect(f.state.marksReads).toBe(1); // the one authenticated POST above
  });
});

describe("configuration", () => {
  const parse = (value: string | undefined) => parseSessionVisibilityGroups({ [READ_API_SESSION_VISIBILITY_GROUPS_VAR]: value });

  test("unset, blank or empty is off; a valid value parses; markers are optional", () => {
    for (const off of [undefined, "", "  ", "{}"]) expect(parse(off)).toBeUndefined();
    const groups = parse(GROUPS)!;
    expect([...groups.keys()]).toEqual(["leadership", "finance"]);
    expect([...groups.get("leadership")!.members]).toEqual([MEMBER, BOTH]);
    expect([...groups.get("leadership")!.markers]).toEqual([MARKER]);
    expect([...groups.get("finance")!.markers]).toEqual([]);
    expect(parse(JSON.stringify({ empty: { members: [] } }))!.get("empty")!.members.size).toBe(0);
  });

  test("anything malformed refuses, naming the variable and never the value", () => {
    for (const bad of ["leadership", "[]", "null", "1", '{"leadership":[]}', '{"leadership":{}}', '{"leadership":{"markers":["u"]}}', '{"leadership":{"members":"u"}}',
      '{"leadership":{"members":[1]}}', '{"leadership":{"members":[""]}}', '{"leadership":{"members":[" u"]}}', '{"leadership":{"members":["u"],"owners":["u"]}}',
      '{"Leadership":{"members":["u"]}}', '{"workspace":{"members":["u"]}}', '{"has space":{"members":["u"]}}', '{"leadership":{"members":["read-api-service"]}}',
      '{"leadership":{"members":["u"],"markers":[null]}}', '{"leadership":{"members":["secret-value-u"]}', `{"${"x".repeat(65)}":{"members":["u"]}}`]) {
      let message = "";
      try { parse(bad); } catch (error) { message = (error as Error).message; }
      expect([bad, message.startsWith(`session read api: ${READ_API_SESSION_VISIBILITY_GROUPS_VAR} `)]).toEqual([bad, true]);
      expect(message).not.toContain("secret-value");
    }
  });

  test("the assembly refuses a malformed value before any pool opens, and the hosted Lambda entry refuses the feature", async () => {
    const secret = JSON.stringify({ supabase_url: "postgresql://reader:pw@db.selfhost.invalid:5432/history", clickhouse: { url: "https://ch.selfhost.invalid:8443", user: "reader", password: "p", database: "relay_search" } });
    const service = { READ_API_COMPLETE_SINCE: "epoch", SESSION_POSTGRES_TLS_PROFILE: "supabase", SEARCH_INDEX_BACKEND: "clickhouse" };
    await expect(readApiDepsFromSecret(secret, { ...service, [READ_API_SESSION_VISIBILITY_GROUPS_VAR]: "{not json" }, undefined, { entry: "service" })).rejects.toThrow(`session read api: ${READ_API_SESSION_VISIBILITY_GROUPS_VAR} is not JSON`);
    await expect(readApiDepsFromSecret(secret, { READ_API_COMPLETE_SINCE: "epoch", [READ_API_SESSION_VISIBILITY_GROUPS_VAR]: GROUPS })).rejects.toThrow(`${READ_API_SESSION_VISIBILITY_GROUPS_VAR} is served only by the self-host service`);
  });
});
