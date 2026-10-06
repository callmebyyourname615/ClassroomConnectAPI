// Shared by the migration and isolated PostgreSQL integration tests.
export const kindergartenSchema = `
CREATE TABLE IF NOT EXISTS kindergarten_records (
 branch_id uuid NOT NULL REFERENCES branches(id), collection varchar(32) NOT NULL,
 record_key varchar(512) NOT NULL, payload jsonb, version integer NOT NULL DEFAULT 1,
 updated_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(branch_id, collection, record_key)
);
CREATE TABLE IF NOT EXISTS kindergarten_assets (
 id uuid PRIMARY KEY, branch_id uuid NOT NULL REFERENCES branches(id),
 mime varchar(32) NOT NULL, original_name text NOT NULL, content bytea NOT NULL,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kindergarten_assets_branch ON kindergarten_assets(branch_id);
CREATE TABLE IF NOT EXISTS kindergarten_reports (
 id uuid PRIMARY KEY, branch_id uuid NOT NULL REFERENCES branches(id),
 class_id uuid NOT NULL REFERENCES classes(id), academic_year_id uuid NOT NULL REFERENCES academic_years(id),
 kind varchar(8) NOT NULL, title text NOT NULL, privacy varchar(16) NOT NULL,
 revision integer NOT NULL, page_count integer NOT NULL, snapshot jsonb NOT NULL,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kindergarten_reports_scope ON kindergarten_reports(branch_id,class_id,academic_year_id,created_at DESC);
`;
