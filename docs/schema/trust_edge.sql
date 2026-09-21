-- Trust edges: who granted which staff status to whom.
-- Session GET /trust-chain projects at most one incoming kind per subject:
-- verify, moderator_appoint, and moderator_propose only when the live
-- subject is a moderator. moderator_confirm and moderator_reject never.
-- Propose and reject may repeat (append-only history). Live unique kinds
-- stay one-per-subject: verify, moderator_confirm, moderator_appoint.
-- Operator PATCH /debug/accounts/:id does not write this table.

CREATE TABLE IF NOT EXISTS trust_edge (
  id uuid PRIMARY KEY,
  subject_id uuid NOT NULL REFERENCES account (id),
  actor_id uuid NOT NULL REFERENCES account (id),
  kind text NOT NULL CHECK (kind IN ('verify', 'moderator_propose', 'moderator_confirm', 'moderator_appoint', 'moderator_reject')),
  created_at timestamptz NOT NULL,
  CHECK (subject_id <> actor_id)
);
ALTER TABLE trust_edge DROP CONSTRAINT IF EXISTS trust_edge_kind_check;
ALTER TABLE trust_edge ADD CONSTRAINT trust_edge_kind_check CHECK (kind IN ('verify', 'moderator_propose', 'moderator_confirm', 'moderator_appoint', 'moderator_reject'));
DROP INDEX IF EXISTS trust_edge_subject_kind_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS trust_edge_subject_kind_live_uidx ON trust_edge (subject_id, kind) WHERE kind IN ('verify', 'moderator_confirm', 'moderator_appoint');
CREATE INDEX IF NOT EXISTS trust_edge_actor_idx ON trust_edge (actor_id);
