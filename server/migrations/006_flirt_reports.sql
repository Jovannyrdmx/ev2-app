-- ============================================================================
-- Migration 006: reports can point at the flirt they are about, and the manager
-- can leave a note when closing one. One open report per reporter/reported pair.
-- ============================================================================
ALTER TABLE user_reports
  ADD COLUMN IF NOT EXISTS flirt_id        UUID REFERENCES flirts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolution_note TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS user_reports_one_open_per_pair
  ON user_reports (reporter_id, reported_id) WHERE status = 'open';
