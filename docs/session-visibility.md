# Session visibility groups

Self-host SERVICE only (`SERVICE=session-read-api`), default off. Code: `src/session-read-api/session-visibility.ts`,
the gates in `src/session-read-api/app.ts`, migration `supabase/migrations/20261105062141_session_visibility.sql`.

By default every member of a workspace can read every session of that workspace. With this feature a session
can carry a **visibility group**, a short label such as `leadership`. A session with a group is served only to
callers whose user id is a member of that group. Everyone else in the workspace gets nothing about it from the
read API: no content, no title, no summary, no search hit, no list row.

- A session without a mark behaves exactly as before.
- With `READ_API_SESSION_VISIBILITY_GROUPS` unset the service behaves exactly as before: no extra statement is
  run, the two routes below do not exist, and rows already in `sessions.session_visibility` have no effect.
- It is a filter on the session read API only. It does not encrypt anything and does not change what the
  pipeline stores, indexes or summarises. See [Limits](#limits).

## Configuration

One non-secret environment variable on the read API:

```
READ_API_SESSION_VISIBILITY_GROUPS={"leadership":{"members":["<user id>","<user id>"],"markers":["<user id>"]}}
```

- The value is one JSON object. Each key is a group label: lowercase letters, digits, `_` and `-`, at most 64
  characters, starting with a letter or digit, and never `workspace`.
- `members` (required, may be empty): user ids that may read sessions marked with the group, and may set,
  replace or clear the mark.
- `markers` (optional): user ids that may **set** the mark. A marker cannot clear it, and cannot read the
  session unless it is also a member.
- A user id is the `userId` of the verified token (with `READ_API_AUTH_MODE=self_issued`, the `userId` the
  session was minted for). A caller with no user id, or with the default subject of a self-issued service
  token (`read-api-service`), is in no group; that subject is refused in the configuration.
- Unset, blank or `{}`: off.
- Anything malformed refuses startup, naming the variable and never its value. The hosted Lambda entry refuses
  the variable (its Output, digest and write paths carry no filter). A search backend that does not declare
  the `exclude_session` filter refuses startup with it.
- A mark whose label the configuration does not name (the group was removed or renamed) hides the session
  from **everyone**, and nobody can clear it through the API until the label is configured again.

Membership is read from the environment at startup; changing it needs a restart. Marks are read from the
database on every request and never cached, so a mark takes effect on the very next request.

## What a mark covers

A mark is keyed by organization, workspace and session id. It has no source: it applies to every harness that
holds that id. It applies to both forms of a session id and to the sessions spawned from the marked one:

- `sessions.session_index`: the physical `session_id` and the `canonical_session_id`, in both directions, so
  marking either form hides the session under the other, and under every other live upload of the same
  logical id;
- `sessions.session_directory_relationships`: a session whose parent is hidden is hidden, at any depth. A
  child's mark does not reach its parent.

This is computed on every request, so a mark set before the session is uploaded covers it once it arrives.
When two marks reach one session (for example its own and its parent's), a caller must be a member of **both**
groups to read it.

## Routes

Both need a bearer with `rth:read` and `workspace=<the token's workspace>`, like every read route.

### `POST /v1/sessions/:sessionId/visibility?workspace=<ws>`

Body `{"visibility":"<group>"}` to set the mark, `{"visibility":"workspace"}` to clear it.

| Caller | Set `<group>` | Replace another group's mark | Clear |
| --- | --- | --- | --- |
| member of `<group>` | yes | only if also a member of the current group | yes, for its own group's mark |
| marker of `<group>` | yes | only if also a member of the current group | no |
| anyone else | no | no | no |

- 200 `{sessionId, visibility, markedBy, markedAt}`: the mark the id now carries, as far as the caller has a
  role in it (`"workspace"` with `null`s when none). Idempotent: setting the standing group again, or clearing
  an unmarked id, changes nothing and keeps the first `markedBy`/`markedAt`.
- 403 `forbidden`, one message for every reason: no role, not a member or marker of the group, or the id
  carries a mark of a group the caller is not a member of.
- 400 `bad_request`: a malformed body, or (for a caller that has a role in some group) a group that is not
  configured. A caller with no role gets 403 for every value.
- 409 `conflict`: the mark changed between the route's check and its write. Nothing was written; retry.
- 413 over 8 KiB. The service entry admits `POST` on exactly this path, and only while the variable is set
  (otherwise 405, as before). CORS preflight on this path allows `POST` while the variable is set.
- The session does not have to exist, so the answer never says whether it does.

The mark is written to the id in the URL only. Clearing an id that is hidden through another id's mark (the
other id form, or a parent) reports the inherited group and leaves the session hidden: clear the mark where it
was set.

### `GET /v1/sessions/:sessionId/visibility?workspace=<ws>`

For a member or marker of at least one group: the id's mark (`"workspace"` when it has none), in the same
shape, so a marker can verify its mark. 404 `not_found` for a caller with no role, and for a caller whose
groups do not include the group of the id's mark.

## Which read paths are filtered

"Hidden" means hidden from the calling user. Members are never filtered.

| Route | Behaviour for a hidden session |
| --- | --- |
| `GET /v1/sessions/:sessionId/*` (events, summary, sources, timing, turns, metadata, catalog, analysis `GET` and `POST`, and any sub-path added later) | 404 `{"error":{"code":"not_found","message":"Session not found"}}`, before the route runs and before any read. It does not depend on `source=` or on any other parameter. It is the operator erase fence's answer. |
| `GET /v1/events?session=` | the same 404, before any read |
| `GET /v1/events?q=` | hidden sessions are excluded inside the index query (`SearchQuery.excludeSessionIds`) on every page, so no row and no cursor position of one is produced. More than 1000 excluded ids (hidden plus partial) is 501 `session_visibility_unbounded`. With `READ_API_SEARCH_PARTIAL_SESSIONS=skip`, a hidden partial session is excluded but not named in `incomplete.sessions`. |
| `GET /v1/sessions` (with and without `q`) | hidden rows are left out. The route reads on until the page is full, and the page cursor is always a row the caller was shown. More than 20 reads for one page is 501 `session_visibility_unbounded`. |
| `GET /v1/sessions/activity?q=` | 501 `param_q` for a caller that has any hidden session (per-day counts of a text query would reveal which words a hidden title or summary holds). Without `q` the route is unchanged, see Limits. |
| `GET /v1/sessions/titles` | a hidden key is dropped before the read and answers like a session with no title |
| `GET /v1/sessions/:sessionId/catalog` of a visible parent | a hidden child is left out of `children` |
| `GET /v1/sessions/output`, `GET /v1/digest/daily`, `GET /v1/coordination/overlaps` | the facts of hidden sessions are dropped where erased sessions are (the `Liveness.erased` filter), so the numbers, the digest's session list and the narrative input exclude them. The narrative cache is keyed by a hash of exactly that input, so a narrative written from a member's digest is not served to a caller whose digest differs. |
| `GET /v1/coordination/advisories`, `POST .../ack` | a hidden recipient session has no advisories and acks nothing (404, as an unknown advisory); an advisory whose peer or evidence is a hidden session is not served |
| `GET /v1/relayfacts/:topic` | evidence rows of hidden sessions are dropped; a record whose evidence is all hidden is dropped |
| `GET /v1/sessions/summaries/search`, `GET /v1/delivery/records`, owner-buffered reads | not served while the variable is set (they carry no filter): the routes' usual 501 `*_not_configured`, and no buffered rows |

Fail closed: if the marks cannot be read, every `/v1` request of that moment answers 503
`backend_unavailable`. That includes a database without migration `20261105062141`: apply the migration
before setting the variable.

## Limits

Read these before relying on the feature.

- **Hidden is not the same answer as "never existed".** The per-session gate answers 404 on every route. For
  a session id that was never uploaded, some routes answer something else (an empty event page, 501
  `timing_no_pointers` or `turns_no_pointers`, an empty `sources` list). A caller who already knows a session
  id can therefore tell that the id is restricted. It learns nothing else about it.
- **A marker or member of another group can tell that an id carries some other group's mark**: `GET` answers
  404 instead of `"workspace"`, and `POST` answers 403.
- **Counts still include hidden sessions.** `GET /v1/sessions/activity`, `GET /v1/sessions/summaries/activity`,
  `GET /v1/sessions/users` (session counts, `lastSessionAt` and the top project names per user),
  `GET /v1/relayfacts` (records per topic), and `childSessionCount` on a list row are not filtered. They show
  that sessions exist and when, and for `users` which projects a user worked in. No transcript content.
- **Readiness refusals are workspace-wide.** A partial or unindexed hidden session can make a search, Output
  or digest read answer its usual 501 for everyone.
- **Relayfacts already written** from a session that is marked later keep their title and statement when
  another, visible session also supports them. Only the hidden session's evidence lines are removed. The
  topic list (`GET /v1/relayfacts`) is not filtered: a topic name and its record counts stay visible even
  when every record of the topic came from hidden sessions.
- **The coordination advisor worker** is a separate workload. Messages it already pushed, or pushes, to a
  peer about a hidden session are not filtered here.
- **The two id forms are tied together by the session's pointer rows** (`sessions.session_index`). For a
  session with no pointer row (not uploaded yet, or indexed history that predates its pointers) only the
  marked form is hidden until the pointer exists.
- **What another session recorded about a hidden one stays with that session.** A parent session's own
  transcript holds the task it gave a sub-agent and the result it got back. Marking only the child does not
  hide that: mark the parent (its children are then hidden with it).
- **Groups are not per workspace.** The configuration names user ids only, so a member is a member in every
  workspace this service serves with that user id.
- **Relayfacts paging.** A topic page's `nextCursor` is the position of the last stored record, which can be
  a record the caller was not shown (its id and creation time, no text).
- **Child sessions** are hidden through the directory's relationship rows. Until the directory has projected
  a new child's relationship, the child is not hidden by its parent's mark; mark it directly if that matters.
- **Other consumers are out of scope**: anything that reads the database, the search index or the object
  store directly, summaries and analysis already generated, and caches held by callers of this API (for
  example a report cached by a control plane).
- **A member's digest narrative and a non-member's replace each other** in the one cache row per day, so each
  may see a cache miss after the other's read.
- **Service tokens minted with an explicit `userId`** are that user for this feature. Mint them only for a
  user who should have that access.
- **Cost.** One extra statement per `/v1` request while the variable is set. With no mark in the workspace it
  is one primary-key probe. With marks it walks them through the pointer and relationship tables by index
  (a few probes per hidden id and harness), so keep the number of marks small (tens, not thousands).

## Database

Migration `20261105062141_session_visibility.sql` adds:

- `sessions.session_visibility (organization_id, workspace_id, session_id, visibility, marked_by, marked_at)`,
  primary key `(organization_id, workspace_id, session_id)`, row-level security enabled, no privilege for any
  runtime role. No history is kept.
- `sessions.session_visibility_marks_v1(p_workspace_id)`: every hidden id of the workspace with its label
  (`direct` = the id itself is marked).
- `sessions.session_visibility_set_v1(p_workspace_id, p_session_id, p_visibility, p_marked_by)`: `NULL` or
  `'workspace'` deletes the mark; another label inserts it only where no mark stands. It returns the label the
  id carried before the call, which is how the route detects a concurrent change and rolls back.

Both are `SECURITY DEFINER` with a pinned `search_path`, granted to `bulls96_read_api` only, and pinned to the
caller's request scope by `sessions.session_directory_read_api_scope`: the workspace must be the bound one and
the organization is never an argument. The writer runs in a `READ WRITE` transaction on the read-role pool,
like the advisory ack.

Rollback: `supabase/rollbacks/20261105062141_session_visibility.down.sql`. It refuses while a later step is
applied, and while any mark exists unless `session_visibility.rollback_drop_marks` is set to `true` in the
session. **Dropping the marks, or running a read API without the variable, makes every marked session
readable by the whole workspace again.**
