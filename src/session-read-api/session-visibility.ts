/**
 * Per-session visibility groups (docs/session-visibility.md; migration 20261105062141).
 *
 * A session can carry one group label. Only callers whose user id is a member of that group may
 * read it; everyone else in the workspace gets nothing about it from any read route. Unset
 * READ_API_SESSION_VISIBILITY_GROUPS = this file is never used and the read API is unchanged.
 *
 * Fail closed throughout: a label the configuration does not name hides the session from everyone, a
 * failed marks read fails the request, and the request-scoped view is required wherever it is consulted.
 * Marks are read once per request and never cached.
 */
import type { TenantRunner } from "./liveness.ts";
import { keyOf, type Liveness } from "./page.ts";

export const READ_API_SESSION_VISIBILITY_GROUPS_VAR = "READ_API_SESSION_VISIBILITY_GROUPS";
/** The wire value for "no mark". Never a group label. */
export const WORKSPACE_VISIBILITY = "workspace";
/** POST /v1/sessions/:sessionId/visibility, exact; the self-host service reads its body. */
export const SESSION_VISIBILITY_PATH = /^\/v1\/sessions\/[^/]+\/visibility$/u;
export const SESSION_VISIBILITY_MAX_BODY_BYTES = 8 * 1024;
const GROUP_LABEL = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
/** Subjects that are never a person: the default subject of a self-issued service token. */
const SYNTHETIC_USERS: ReadonlySet<string> = new Set(["read-api-service"]);

export interface VisibilityGroup {
  /** May read sessions marked with the group, and set or clear the mark. */
  members: ReadonlySet<string>;
  /** May set the mark; cannot clear it, and cannot read the session unless also a member. */
  markers: ReadonlySet<string>;
}
export type VisibilityGroups = ReadonlyMap<string, VisibilityGroup>;

/**
 * READ_API_SESSION_VISIBILITY_GROUPS: JSON `{"<group>":{"members":["<user id>",...],"markers":[...]}}`.
 * Unset, blank or `{}` is off (undefined). Anything malformed refuses startup, naming the variable and
 * never its value: not an object, a label outside [a-z0-9][a-z0-9_-]{0,63} or equal to "workspace", an
 * unknown key, a missing `members`, or a user id that is not a non-blank string (or is a synthetic subject).
 */
export function parseSessionVisibilityGroups(env: Record<string, string | undefined>): VisibilityGroups | undefined {
  const raw = env[READ_API_SESSION_VISIBILITY_GROUPS_VAR];
  if (raw === undefined || raw.trim() === "") return undefined;
  const refuse = (what: string) => new Error(`session read api: ${READ_API_SESSION_VISIBILITY_GROUPS_VAR} ${what}`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw refuse("is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw refuse("must be a JSON object of groups");
  const users = (list: unknown): ReadonlySet<string> => {
    if (!Array.isArray(list) || list.some((u) => typeof u !== "string" || u === "" || u !== u.trim() || u.length > 512 || SYNTHETIC_USERS.has(u)))
      throw refuse("members and markers must be arrays of user ids");
    return new Set(list as string[]);
  };
  const groups = new Map<string, VisibilityGroup>();
  for (const [label, group] of Object.entries(value)) {
    if (!GROUP_LABEL.test(label) || label === WORKSPACE_VISIBILITY) throw refuse("has an invalid group label");
    if (!group || typeof group !== "object" || Array.isArray(group)) throw refuse("groups must be objects");
    const { members, markers, ...rest } = group as Record<string, unknown>;
    if (Object.keys(rest).length > 0 || members === undefined) throw refuse("groups take members and optional markers only");
    groups.set(label, { members: users(members), markers: users(markers ?? []) });
  }
  return groups.size > 0 ? groups : undefined;
}

/** One row of sessions.session_visibility_marks_v1: a hidden id with its label. */
export interface VisibilityMark {
  sessionId: string;
  visibility: string;
  markedBy: string;
  markedAt: string;
  /** The id itself is marked; false = inherited from another id form or a parent session. */
  direct: boolean;
}

export interface VisibilityStore {
  marks(orgId: string, workspaceId: string): Promise<VisibilityMark[]>;
  /** One READ WRITE transaction. `set` returns the label the id carried before the call (null = none). */
  write<T>(orgId: string, workspaceId: string, work: (tx: {
    marks(): Promise<VisibilityMark[]>;
    set(sessionId: string, visibility: string | null, markedBy: string): Promise<string | null>;
  }) => Promise<T>): Promise<T>;
}

const MARKS_SQL = `SELECT session_id, visibility, marked_by, marked_at, direct FROM sessions.session_visibility_marks_v1($1)`;
const SET_SQL = "SELECT sessions.session_visibility_set_v1($1, $2, $3, $4) AS previous";

type Query = Parameters<Parameters<TenantRunner>[2]>[0];

async function readMarks(q: Query, workspaceId: string): Promise<VisibilityMark[]> {
  const { rows } = await q.query<Record<string, unknown>>(MARKS_SQL, [workspaceId]);
  return rows.map((row) => {
    if (typeof row.session_id !== "string" || row.session_id === "" || typeof row.visibility !== "string" || typeof row.direct !== "boolean")
      throw new Error("session visibility marks out of contract");
    const at = row.marked_at instanceof Date ? row.marked_at : new Date(String(row.marked_at));
    return { sessionId: row.session_id, visibility: row.visibility, markedBy: String(row.marked_by), markedAt: at.toISOString(), direct: row.direct };
  });
}

/** The store over the 062141 functions: `read` READ ONLY, `write` READ WRITE (coordination-advisories.ts poolTenantWriter). */
export function sqlSessionVisibility(read: TenantRunner, write: TenantRunner): VisibilityStore {
  return {
    marks: (orgId, workspaceId) => read(orgId, workspaceId, (q) => readMarks(q, workspaceId)),
    write: (orgId, workspaceId, work) =>
      write(orgId, workspaceId, (q) => work({
        marks: () => readMarks(q, workspaceId),
        async set(sessionId, visibility, markedBy) {
          const { rows } = await q.query<{ previous: string | null }>(SET_SQL, [workspaceId, sessionId, visibility, markedBy]);
          if (rows.length !== 1) throw new Error("session visibility set out of contract");
          return rows[0]!.previous ?? null;
        },
      })),
  };
}

/** What GET and POST /v1/sessions/:sessionId/visibility answer. */
export interface VisibilityState {
  sessionId: string;
  /** A group label, or "workspace" when the id carries no mark the caller has a role in. */
  visibility: string;
  markedBy: string | null;
  markedAt: string | null;
}

/** A refusal of the visibility routes; the message never names a group, a session or another user. */
export class VisibilityRefusal extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: "bad_request" | "forbidden" | "not_found" | "conflict", message: string) {
    super(message);
    this.name = "VisibilityRefusal";
  }
}
const forbidden = () => new VisibilityRefusal(403, "forbidden", "not allowed to change this session's visibility");

/** One caller's view of the workspace's marks, for one request. */
export interface VisibilityView {
  /** Every session id (each id form, and spawned sessions) hidden from this caller. */
  readonly hidden: ReadonlySet<string>;
  hides(sessionId: unknown): boolean;
  /** The caller's GET answer for one id; throws 404 when the caller has no role, or none in the id's mark. */
  state(sessionId: string): VisibilityState;
}

export interface SessionVisibility {
  /** Reads the workspace's marks (one statement) and binds them to the caller. Throws when the read fails. */
  view(identity: { userId: string; orgId: string; workspaceId: string }): Promise<VisibilityView>;
  /** Runs the rest of the request with the view in scope (visibilityLiveness reads it there). */
  run<T>(view: VisibilityView, work: () => T): T;
  /** Sets (a group label) or clears ("workspace") the mark of one id; throws VisibilityRefusal. Idempotent. */
  set(identity: { userId: string; orgId: string; workspaceId: string }, sessionId: string, visibility: string): Promise<VisibilityState>;
}

/**
 * Where the request's view lives while the request runs: an AsyncLocalStorage (node:async_hooks) in the
 * self-host service, created by its assembly (lambda.ts) so this file stays runtime-neutral.
 */
export interface VisibilityScope {
  run<T>(view: VisibilityView, work: () => T): T;
  getStore(): VisibilityView | undefined;
}

/**
 * Liveness with the caller's hidden sessions reported as erased, so every consumer of `erased`
 * (event pages, the Output and digest facts, coordination overlaps) leaves them out. Consulted
 * only inside SessionVisibility.run; anywhere else it throws rather than answer unfiltered.
 */
export function visibilityLiveness(base: Liveness, scope: VisibilityScope): Liveness {
  return {
    async erased(orgId, workspaceId, keys) {
      const view = scope.getStore();
      if (!view) throw new Error("session visibility: no request view in scope");
      const erased = await base.erased(orgId, workspaceId, keys);
      for (const key of keys) if (view.hides(key.sessionId)) erased.add(keyOf(key));
      return erased;
    },
    sessionStart: (orgId, workspaceId, sessionId, source) => base.sessionStart(orgId, workspaceId, sessionId, source),
    livePointerSessions: (orgId, workspaceId, sessionIds) => base.livePointerSessions(orgId, workspaceId, sessionIds),
  };
}

export function sessionVisibility(groups: VisibilityGroups, store: VisibilityStore, scope: VisibilityScope): SessionVisibility {
  /** The caller's roles: no user id, or a synthetic one, is in no group. */
  const rolesOf = (userId: string) => {
    const member = new Set<string>(), setter = new Set<string>();
    if (typeof userId === "string" && userId !== "" && !SYNTHETIC_USERS.has(userId))
      for (const [label, group] of groups) {
        if (group.members.has(userId)) member.add(label);
        if (group.members.has(userId) || group.markers.has(userId)) setter.add(label);
      }
    return { member, setter };
  };
  type Roles = ReturnType<typeof rolesOf>;
  /** The id's mark as the caller may see it: its own mark first, else an inherited one; undefined = none it has a role in. */
  const visibleMark = (marks: readonly VisibilityMark[], roles: Roles, sessionId: string) =>
    marks.filter((m) => m.sessionId === sessionId && roles.setter.has(m.visibility))
      .sort((a, b) => Number(b.direct) - Number(a.direct) || b.markedAt.localeCompare(a.markedAt))[0];
  const stateOf = (sessionId: string, mark: VisibilityMark | undefined): VisibilityState =>
    mark ? { sessionId, visibility: mark.visibility, markedBy: mark.markedBy, markedAt: mark.markedAt }
      : { sessionId, visibility: WORKSPACE_VISIBILITY, markedBy: null, markedAt: null };

  return {
    async view(identity) {
      const marks = await store.marks(identity.orgId, identity.workspaceId);
      const roles = rolesOf(identity.userId);
      const hidden = new Set<string>();
      // A label outside the configuration has no members: hidden from everyone.
      for (const mark of marks) if (!roles.member.has(mark.visibility)) hidden.add(mark.sessionId);
      return {
        hidden,
        hides: (sessionId) => typeof sessionId === "string" && hidden.has(sessionId),
        state(sessionId) {
          const notFound = new VisibilityRefusal(404, "not_found", "Session not found");
          if (roles.setter.size === 0) throw notFound;
          const mark = visibleMark(marks, roles, sessionId);
          if (!mark && marks.some((m) => m.sessionId === sessionId)) throw notFound;
          return stateOf(sessionId, mark);
        },
      };
    },
    run: (view, work) => scope.run(view, work),
    async set(identity, sessionId, visibility) {
      const roles = rolesOf(identity.userId);
      if (roles.setter.size === 0) throw forbidden();
      const clear = visibility === WORKSPACE_VISIBILITY;
      if (!clear && !groups.has(visibility)) throw new VisibilityRefusal(400, "bad_request", "visibility must be workspace or a configured group");
      if (!clear && !roles.setter.has(visibility)) throw forbidden();
      const changed = () => new VisibilityRefusal(409, "conflict", "the session's visibility changed concurrently; retry");
      return store.write(identity.orgId, identity.workspaceId, async (tx) => {
        const own = (await tx.marks()).find((m) => m.direct && m.sessionId === sessionId);
        if (own && own.visibility !== visibility) {
          // Removing a mark (to clear it, or to replace it) is a member's right only.
          if (!roles.member.has(own.visibility)) throw forbidden();
          if ((await tx.set(sessionId, null, identity.userId)) !== own.visibility) throw changed();
        }
        // The writer inserts only where no mark stands, and says what stood there: another label is a lost race.
        if (!clear && own?.visibility !== visibility) {
          const stood = await tx.set(sessionId, visibility, identity.userId);
          if (stood !== null && stood !== visibility) throw changed();
        }
        return stateOf(sessionId, visibleMark(await tx.marks(), roles, sessionId));
      });
    },
  };
}
