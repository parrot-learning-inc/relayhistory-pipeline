-- Drops the 20261105062141 session visibility marks: the two functions, the table sessions.session_visibility
-- (with its primary key) and the ledger row.
-- Marks: while any mark exists this refuses (55000). Dropping them makes every marked session readable by the
-- whole workspace again. To drop them anyway, set the override in the same session before running this file
-- (it opens its own transaction, so SET LOCAL cannot precede it), for example
--   psql -v ON_ERROR_STOP=1 -c "SET session_visibility.rollback_drop_marks = 'true'" -f <this file>
-- Anything but exactly 'true' (unset included) refuses. The table is locked before the check, so no mark can be
-- added between the check and the drop. Stop every read API that has READ_API_SESSION_VISIBILITY_GROUPS set
-- first: with it set and these functions gone, every read answers 503.
-- Guard, object removal and ledger removal are one transaction under the migrator lock.
-- On refusal the caller must ROLLBACK or disconnect.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(961996,1); -- same namespace as the real migrator
DO $rollback_guard$ DECLARE v_sha text; BEGIN
 IF to_regclass('sessions.__96bulls_migrations') IS NULL
 THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='session visibility: migration ledger required';END IF;
 LOCK TABLE sessions.__96bulls_migrations IN SHARE ROW EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM sessions.__96bulls_migrations WHERE name LIKE 'upstream:%' AND name COLLATE "C">'upstream:20261105062141_session_visibility.sql')
 THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='session visibility: a later migration is applied; roll it back first';END IF;
 SELECT sha256 INTO v_sha FROM sessions.__96bulls_migrations WHERE name='upstream:20261105062141_session_visibility.sql' FOR UPDATE;
 IF NOT FOUND OR v_sha<>'d940ccc64587ca58d6a3afe949484556c030598e202506a45c03e79106372f29'
 THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='session visibility: own applied checksum required';END IF;
 LOCK TABLE sessions.session_visibility IN ACCESS EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM sessions.session_visibility)
    AND coalesce(current_setting('session_visibility.rollback_drop_marks',true),'')<>'true'
 THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='session visibility: marks exist; set session_visibility.rollback_drop_marks=true to drop them';END IF;
END $rollback_guard$;
DROP FUNCTION sessions.session_visibility_marks_v1(text),
 sessions.session_visibility_set_v1(text,text,text,text);
DROP TABLE sessions.session_visibility;
DELETE FROM sessions.__96bulls_migrations WHERE name='upstream:20261105062141_session_visibility.sql';
COMMIT;
