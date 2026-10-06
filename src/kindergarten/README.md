# Kindergarten report storage

Authenticated routes under `/api/v2/kindergarten/:branchId`. The service verifies the active admin's assigned branch in PostgreSQL, and verifies class/year/student enrollment for all scoped records. Parents cannot access these teacher workspace endpoints.

| Endpoint | Purpose |
| --- | --- |
| GET records | Teacher input and report history for assigned branch |
| PATCH records | Atomic batches of changed records, with per-record expectedVersion |
| POST assets | Validated JPEG/PNG/WebP, up to 10MB, stored as bytea |
| GET assets/:id | Authenticated branch-scoped image download |
| POST reports | Immutable report snapshot, including transformed/redacted image data |
| GET reports/:id | Reopen original report snapshot across devices |
| GET attendance/:classId/:yearId | Existing attendance records for report export |

Migration: `CreateKindergartenStorage1791200000000` creates only `kindergarten_records`, `kindergarten_assets` and `kindergarten_reports`, plus indexes. On the local classroomconnect database this migration has already been applied and recorded; other environments should run the normal migration workflow.

Changes cover school metadata, holidays, growth, assessments, activity planning, daily work, weekly summaries and reviews. Deletions use tombstones to retain concurrency versions. Simultaneous edits to the same record return HTTP 409 instead of silently replacing another teacher's data. Student/parent records remain sourced from their existing APIs. Attendance remains edited through the existing Attendance page.

Reports persist the immutable preview snapshot, not a browser-generated PDF binary. PDF is produced from that saved snapshot with the existing browser print renderer. Raw source assets are stored separately from the redacted images embedded in a report snapshot.

Build and isolated PostgreSQL/HTTP tests:

```sh
npm run build
node test/kindergarten/storage.integration.cjs
```

The integration test creates and removes its own PostgreSQL schema. It never inserts test scores into real school records. For the frontend cross-browser persistence test, keep a fixture server running:

```sh
KG_TEST_PORT=7777 node test/kindergarten/storage.integration.cjs
```

Then run `features/kindergarten-report/tests/test_api_persistence.py` from the Admin project. Stop the fixture server with SIGTERM to remove its schema.
