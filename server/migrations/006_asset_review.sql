-- Post-registration review and correction (brief §9). Review is separate from registration: it never blocks
-- registration, never deletes or replaces the asset, and never changes its institutional ID or QR code.

ALTER TABLE assets ADD COLUMN review_status text NOT NULL DEFAULT 'not_reviewed'
  CHECK (review_status IN ('not_reviewed', 'approved', 'returned_for_correction', 'corrected_awaiting_rereview'));
CREATE INDEX assets_review_idx ON assets (review_status) WHERE archived_at IS NULL AND registration_status = 'registered';

-- What was reviewed, what was flagged, what was corrected, who and when. Append-only.
CREATE TABLE asset_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id      uuid NOT NULL REFERENCES assets(id),
  department_id uuid NOT NULL REFERENCES departments(id),   -- the department responsible for corrections
  action        text NOT NULL CHECK (action IN ('approved', 'returned', 'corrections_submitted')),
  note          text,
  fields        text[] NOT NULL DEFAULT '{}',              -- fields the reviewer flagged (returned)
  changes       jsonb,                                     -- before/after of what was corrected (corrections_submitted)
  actor_id      uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_has_reason CHECK (action <> 'returned' OR length(trim(coalesce(note, ''))) >= 5)
);
CREATE INDEX asset_reviews_asset_idx ON asset_reviews (asset_id, created_at);

CREATE FUNCTION asset_reviews_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'asset_reviews is append-only';
END $$;
CREATE TRIGGER asset_reviews_no_update BEFORE UPDATE OR DELETE ON asset_reviews FOR EACH ROW EXECUTE FUNCTION asset_reviews_append_only();
