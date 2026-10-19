# Montessori Report API

The authenticated NestJS resource is `/api/v2/montessori/:branchId`. The Nuxt portal uses its existing `/api/v2` proxy. Staff membership and report-management rights are resolved from the database. Parent tokens and staff from other branches are rejected.

| Method | Path | Purpose |
|---|---|---|
| GET | `/context` | Current staff permissions, school, years, and enrolled student/class options |
| GET | `/reports` | Branch reports; filters: studentId, classId, academicYearId, level; limit 1–200, offset |
| GET | `/reports/:id` | Saved report with server version |
| PUT | `/reports/:id` | Create or save a report: `{ id, expectedVersion, report }` |
| DELETE | `/reports/:id?expectedVersion=1` | Permanently delete the report and its history; author or branch administrator only, latest version required |
| GET | `/reports/:id/history` | Immutable save history |

Use a UUID as the client-created report ID. New reports use `expectedVersion: 0`. Existing reports must send the returned version. Conflicting changes return 409. A lost-response retry of an identical report save returns the existing version without creating a duplicate revision.

Reports store verified student/class/year identities; level and term; reporting dates; an immutable subject/skill snapshot and template version; learning ratings; behavior ratings; subject coverage; comments; summary; and period/year-to-date attendance. Display names, school name, author, timestamps, and computed progress come from the server.

Assessment keys are canonical `subjectIndex:skillIndex` strings (for example `1:0`). Repeated source labels remain independent. Learning ratings are Presented, Practicing, Improved, Mastered, or empty. Behavior uses 1–4 or null. Blank attendance is null, distinct from zero. Tardy is an event count.

Teachers create, save, preview/print, and edit their own reports directly. No submission, approval, finalization, or reopening is required, and there is no transitions endpoint. Database-assigned administrators can also edit branch reports. Concurrent edits still require the latest expected version; branch, parent-token, enrollment and author restrictions remain enforced.

`montessori_reports` stores the latest document; `montessori_report_revisions` stores each successful save in the same transaction. Report identity and the assessment template snapshot remain immutable so ratings keep their original meaning. Historical workflow columns and revision entries are retained for compatibility, but they do not restrict editing. Previously submitted, approved or finalized reports can be saved by their teacher author directly.

Deploy with the normal TypeORM migration workflow; the new migration is `CreateMontessoriReports1791780000000`. For this local development database only, `node -r ts-node/register scripts/apply-montessori-migration.cjs` applies this additive migration and records it without running unrelated pending migrations.

Verification:

- `npm test -- --runInBand --watchman=false montessori.validation.spec.ts`
- `node -r ts-node/register test/montessori-postgres.integration.cjs`

The PostgreSQL integration test creates an isolated, uniquely named test schema and removes it afterward. It does not write fixture students or reports into the school's tables.
