export const montessoriSchema = `
CREATE TABLE IF NOT EXISTS montessori_reports (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 student_id uuid NOT NULL REFERENCES students(id),
 class_id uuid NOT NULL REFERENCES classes(id),
 academic_year_id uuid NOT NULL REFERENCES academic_years(id),
 level varchar(32) NOT NULL CHECK (level IN ('Toddlers','Twos','Pre-School','Lower Elementary')),
 term varchar(16) NOT NULL CHECK (term IN ('Term 1','Term 2')),
 status varchar(32) NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Submitted','Changes requested','Approved','Finalized')),
 payload jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 created_by uuid NOT NULL REFERENCES admins(id),
 updated_by uuid NOT NULL REFERENCES admins(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS montessori_reports_branch_year ON montessori_reports(branch_id,academic_year_id,updated_at DESC,id);
CREATE INDEX IF NOT EXISTS montessori_reports_student ON montessori_reports(branch_id,student_id);
CREATE TABLE IF NOT EXISTS montessori_report_revisions (
 report_id uuid NOT NULL REFERENCES montessori_reports(id),
 version integer NOT NULL,
 status varchar(32) NOT NULL,
 payload jsonb NOT NULL,
 actor_id uuid NOT NULL REFERENCES admins(id),
 action varchar(32) NOT NULL,
 note text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(report_id,version)
);
`;
