-- Slot 20261105062141. Per-session visibility groups for the session read API (docs/session-visibility.md):
-- one table and two SECURITY DEFINER entry points for bulls96_read_api. Enables nothing by itself: the read
-- API calls them only when READ_API_SESSION_VISIBILITY_GROUPS is set.
-- (The slot sits directly above 062140 so that a later step in the usual ten-step slots sorts after it.)
--
-- A row marks one session id of one workspace with a group label. No transcript content: the ids, the label,
-- who marked it and when. The label is a name only; who belongs to a group is the read API's configuration,
-- so a label the configuration no longer names hides the session from everyone.
--
-- A mark applies to every form of the session id and to the sessions spawned from it: the reader returns the
-- marked ids (direct = true) and, with the same label, every id reachable from them through
--   sessions.session_index             physical session_id -> canonical_session_id (any pointer row), and
--                                      canonical_session_id -> physical session_id (live pointer rows; a
--                                      physical id whose every pointer is tombstoned is erased already), and
--   sessions.session_directory_relationships   parent_session_id -> child_session_id
-- (direct = false). It is computed on every call, so a pointer or a child that arrives after the mark is
-- covered by the next read. No history is kept.
--
-- Roles: the read API (bulls96_read_api) gets both functions, pinned to its request scope
-- (session_directory_read_api_scope). It gets no table privilege. bulls96_read_api defaults to read-only
-- transactions: the caller of the writer must open READ WRITE.

CREATE TABLE sessions.session_visibility (
  organization_id text NOT NULL CHECK (char_length(organization_id) BETWEEN 1 AND 512),
  workspace_id text NOT NULL CHECK (char_length(workspace_id) BETWEEN 1 AND 512),
  session_id text NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 512 AND session_id !~ '[[:cntrl:]]'),
  visibility text NOT NULL CHECK (visibility ~ '^[a-z0-9][a-z0-9_-]{0,63}$' AND visibility <> 'workspace'),
  marked_by text NOT NULL CHECK (char_length(marked_by) BETWEEN 1 AND 512),
  marked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, workspace_id, session_id)
);

ALTER TABLE sessions.session_visibility ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sessions.session_visibility
  FROM PUBLIC, anon, authenticated, service_role, search_consumer_runtime, bulls96_read_api;

-- Read API: every hidden id of the workspace with its label (see the header). The workspace must be the read
-- API's request scope; the org comes from that scope, never from the caller.
CREATE FUNCTION sessions.session_visibility_marks_v1(p_workspace_id text)
RETURNS TABLE (session_id text, visibility text, marked_by text, marked_at timestamptz, direct boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, sessions, pg_temp AS $session_visibility_marks$
DECLARE v_org text := sessions.session_directory_read_api_scope(p_workspace_id); v_harnesses text[];
BEGIN
  -- No mark in the workspace: one primary-key probe and nothing else.
  IF NOT EXISTS (SELECT 1 FROM sessions.session_visibility AS m
                  WHERE m.organization_id = v_org AND m.workspace_id = p_workspace_id) THEN
    RETURN;
  END IF;
  -- The workspace's harness names, by loose index scans (one probe per name) over session_index (si_harness,
  -- live pointers) and session_directory (its primary key). The two lookups below that have no harness of
  -- their own bind it to these names, so each is an index probe (session_index_canonical_live, and the
  -- relationships primary key) instead of a scan of the workspace.
  WITH RECURSIVE live (harness) AS (
    (SELECT p.harness FROM sessions.session_index AS p
      WHERE p.org_id = v_org AND p.workspace_id = p_workspace_id AND p.deleted_at IS NULL
      ORDER BY p.harness LIMIT 1)
    UNION ALL
    SELECT (SELECT p.harness FROM sessions.session_index AS p
             WHERE p.org_id = v_org AND p.workspace_id = p_workspace_id AND p.deleted_at IS NULL AND p.harness > l.harness
             ORDER BY p.harness LIMIT 1)
      FROM live AS l WHERE l.harness IS NOT NULL
  ), listed (harness) AS (
    (SELECT d.harness FROM sessions.session_directory AS d
      WHERE d.org_id = v_org AND d.workspace_id = p_workspace_id
      ORDER BY d.harness LIMIT 1)
    UNION ALL
    SELECT (SELECT d.harness FROM sessions.session_directory AS d
             WHERE d.org_id = v_org AND d.workspace_id = p_workspace_id AND d.harness > l.harness
             ORDER BY d.harness LIMIT 1)
      FROM listed AS l WHERE l.harness IS NOT NULL
  )
  SELECT array_agg(DISTINCT x.harness) INTO v_harnesses
    FROM (SELECT l.harness FROM live AS l UNION ALL SELECT l.harness FROM listed AS l) AS x
   WHERE x.harness IS NOT NULL;
  RETURN QUERY
    WITH RECURSIVE hidden (id, label, marker, marked, direct) AS (
      SELECT m.session_id, m.visibility, m.marked_by, m.marked_at, true
        FROM sessions.session_visibility AS m
       WHERE m.organization_id = v_org AND m.workspace_id = p_workspace_id
      UNION
      SELECT x.id, h.label, h.marker, h.marked, false
        FROM hidden AS h
       CROSS JOIN LATERAL (
         SELECT p.canonical_session_id FROM sessions.session_index AS p
          WHERE p.org_id = v_org AND p.workspace_id = p_workspace_id AND p.session_id = h.id
         UNION ALL
         SELECT p.session_id FROM sessions.session_index AS p
          WHERE p.org_id = v_org AND p.workspace_id = p_workspace_id AND p.harness = ANY (v_harnesses)
            AND p.canonical_session_id = h.id AND p.deleted_at IS NULL
         UNION ALL
         SELECT r.child_session_id FROM sessions.session_directory_relationships AS r
          WHERE r.org_id = v_org AND r.workspace_id = p_workspace_id AND r.harness = ANY (v_harnesses)
            AND r.parent_session_id = h.id
       ) AS x (id)
       WHERE x.id IS NOT NULL
    )
    SELECT h.id, h.label, h.marker, h.marked, h.direct FROM hidden AS h;
END
$session_visibility_marks$;

-- Read API: set or clear the mark of one session id. p_visibility NULL or 'workspace' deletes the mark;
-- any other label inserts it ONLY when the id has no mark (an existing mark is never replaced: clear it
-- first). Returns the label the id carried BEFORE the call (NULL = none), so the caller can tell whether its
-- statement changed anything and roll back when the mark was not the one it authorized against.
CREATE FUNCTION sessions.session_visibility_set_v1(p_workspace_id text, p_session_id text, p_visibility text, p_marked_by text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, sessions, pg_temp AS $session_visibility_set$
DECLARE v_org text := sessions.session_directory_read_api_scope(p_workspace_id); v_prev text;
BEGIN
  IF p_session_id IS NULL OR char_length(p_session_id) NOT BETWEEN 1 AND 512 OR p_session_id ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'session visibility: invalid session id';
  END IF;
  IF p_visibility IS NULL OR p_visibility = 'workspace' THEN
    DELETE FROM sessions.session_visibility AS m
     WHERE m.organization_id = v_org AND m.workspace_id = p_workspace_id AND m.session_id = p_session_id
    RETURNING m.visibility INTO v_prev;
    RETURN v_prev;
  END IF;
  IF p_visibility !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     OR p_marked_by IS NULL OR char_length(p_marked_by) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'session visibility: invalid label or marker';
  END IF;
  INSERT INTO sessions.session_visibility (organization_id, workspace_id, session_id, visibility, marked_by)
  VALUES (v_org, p_workspace_id, p_session_id, p_visibility, p_marked_by)
  ON CONFLICT (organization_id, workspace_id, session_id) DO NOTHING;
  IF FOUND THEN RETURN NULL; END IF;
  SELECT m.visibility INTO v_prev FROM sessions.session_visibility AS m
   WHERE m.organization_id = v_org AND m.workspace_id = p_workspace_id AND m.session_id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'session visibility: the mark changed concurrently; retry';
  END IF;
  RETURN v_prev;
END
$session_visibility_set$;

REVOKE ALL ON FUNCTION sessions.session_visibility_marks_v1(text),
  sessions.session_visibility_set_v1(text,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role, search_consumer_runtime, bulls96_read_api;
GRANT EXECUTE ON FUNCTION sessions.session_visibility_marks_v1(text),
  sessions.session_visibility_set_v1(text,text,text,text)
  TO bulls96_read_api;
