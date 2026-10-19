export const reportRequestsSchema = `
CREATE TABLE IF NOT EXISTS official_report_requests (
 id uuid PRIMARY KEY,
 reference varchar(32) NOT NULL UNIQUE,
 parent_id uuid NOT NULL REFERENCES parents(id),
 student_id uuid NOT NULL REFERENCES students(id),
 branch_id uuid NOT NULL REFERENCES branches(id),
 class_id uuid NOT NULL REFERENCES classes(id),
 academic_year_id uuid NOT NULL REFERENCES academic_years(id),
 idempotency_key varchar(128) NOT NULL,
 intent jsonb NOT NULL,
 metadata jsonb NOT NULL,
 source_snapshot jsonb NOT NULL,
 status varchar(16) NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','preparing','ready','declined')),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 history jsonb NOT NULL,
 decline_reason text NOT NULL DEFAULT '',
 decline_reason_lo text NOT NULL DEFAULT '',
 document bytea,
 requested_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(parent_id,idempotency_key),
 CHECK(status <> 'ready' OR document IS NOT NULL OR metadata ? 'documents')
);
CREATE INDEX IF NOT EXISTS official_report_requests_parent_scope
 ON official_report_requests(parent_id,student_id,branch_id,class_id,academic_year_id,requested_at DESC,id);
CREATE INDEX IF NOT EXISTS official_report_requests_branch_queue
 ON official_report_requests(branch_id,requested_at DESC,id);
`;

export const reportRequestDocumentsSchema = `
ALTER TABLE official_report_requests DROP CONSTRAINT IF EXISTS official_report_requests_check;
ALTER TABLE official_report_requests DROP CONSTRAINT IF EXISTS official_report_requests_ready_document_check;
ALTER TABLE official_report_requests ADD CONSTRAINT official_report_requests_ready_document_check
 CHECK(status <> 'ready' OR document IS NOT NULL OR metadata ? 'documents');

CREATE TABLE IF NOT EXISTS official_report_request_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL REFERENCES official_report_requests(id) ON DELETE CASCADE,
 document_type varchar(64) NOT NULL,
 subject_slot varchar(64) NOT NULL DEFAULT '',
 metadata jsonb NOT NULL,
 status varchar(16) NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','preparing','ready','declined')),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 document bytea,
 requested_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(request_id,document_type,subject_slot),
 CHECK(status <> 'ready' OR document IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS official_report_request_documents_request
 ON official_report_request_documents(request_id,requested_at,id);

INSERT INTO official_report_request_documents(request_id,document_type,subject_slot,metadata,status)
SELECT r.id,
 COALESCE(d->>'documentType',r.metadata->>'documentType','official-report'),
 COALESCE(d->>'subjectSlot',r.metadata->>'subjectSlot',''),
 d,
 CASE WHEN r.status='preparing' THEN 'preparing' ELSE 'submitted' END
FROM official_report_requests r
CROSS JOIN LATERAL jsonb_array_elements(
 CASE WHEN jsonb_typeof(r.metadata->'documents')='array' AND jsonb_array_length(r.metadata->'documents')>0
 THEN r.metadata->'documents'
 ELSE jsonb_build_array(jsonb_build_object(
   'documentType',COALESCE(r.metadata->>'documentType','official-report'),
   'documentLabel',r.metadata->>'documentLabel',
   'documentLabelLo',r.metadata->>'documentLabelLo',
   'subjectSlot',COALESCE(r.metadata->>'subjectSlot',''),
   'subjectName',r.metadata->>'subjectName')) END
) d
WHERE r.status IN ('submitted','preparing')
ON CONFLICT(request_id,document_type,subject_slot) DO NOTHING;
`;

export const reportRequestMultiPeriodSchema = `
ALTER TABLE official_report_request_documents
 ADD COLUMN IF NOT EXISTS selection_id varchar(255) NOT NULL DEFAULT '';
ALTER TABLE official_report_request_documents
 DROP CONSTRAINT IF EXISTS official_report_request_documents_request_selection_document_subject_key;
DO $$
DECLARE old_constraint text;
BEGIN
 SELECT c.conname INTO old_constraint
 FROM pg_constraint c
 JOIN pg_class t ON t.oid=c.conrelid
 WHERE t.relname='official_report_request_documents'
   AND c.contype='u'
   AND pg_get_constraintdef(c.oid)='UNIQUE (request_id, document_type, subject_slot)';
 IF old_constraint IS NOT NULL THEN
   EXECUTE format('ALTER TABLE official_report_request_documents DROP CONSTRAINT %I', old_constraint);
 END IF;
END $$;
ALTER TABLE official_report_request_documents
 ADD CONSTRAINT official_report_request_documents_request_selection_document_subject_key
 UNIQUE(request_id,selection_id,document_type,subject_slot);
`;
