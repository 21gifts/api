-- Trust edges: who granted which staff status to whom.
-- Public GET /trust-chain projects stored verify / moderator_confirm /
-- moderator_appoint edges only. moderator_propose is stored but not shown.
-- Operator PATCH /debug/accounts/:id does not write this table.

CREATE TABLE IF NOT EXISTS trust_edge (
  id uuid PRIMARY KEY,
  subject_id uuid NOT NULL REFERENCES account (id),
  actor_id uuid NOT NULL REFERENCES account (id),
  kind text NOT NULL CHECK (kind IN ('verify', 'moderator_propose', 'moderator_confirm', 'moderator_appoint')),
  created_at timestamptz NOT NULL,
  CHECK (subject_id <> actor_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS trust_edge_subject_kind_uidx ON trust_edge (subject_id, kind);
CREATE INDEX IF NOT EXISTS trust_edge_actor_idx ON trust_edge (actor_id);
