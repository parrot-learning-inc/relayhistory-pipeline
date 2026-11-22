/**
 * Lane: session-visibility (slot 062141: directly above 062140, so a later step in the usual
 * ten-step slots still sorts after it and the ledger stays one contiguous prefix).
 * Two SECURITY DEFINER entry points over sessions.session_visibility (docs/session-visibility.md), both for
 * bulls96_read_api and pinned to its request scope: the marks reader and the set/clear writer. No runtime role
 * has a table privilege.
 */
import type { LaneManifest } from "../types.ts";

const MIGRATION = "supabase/migrations/20261105062141_session_visibility.sql";

export const sessionVisibility: LaneManifest = {
  lane: "session-visibility",
  owner: "per-session visibility groups for the session read API (slot 062141)",
  migration: MIGRATION,
  prefixes: ["sessions.session_visibility_"],
  grantSources: [{ path: MIGRATION, roles: ["bulls96_read_api"] }],
  functions: {
    "sessions.session_visibility_marks_v1(text)": { secdef: true, grants: ["bulls96_read_api"] },
    "sessions.session_visibility_set_v1(text,text,text,text)": { secdef: true, grants: ["bulls96_read_api"] },
  },
  replaces: {},
};
