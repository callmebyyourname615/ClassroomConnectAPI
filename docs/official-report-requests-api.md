# Official report requests

The AlphaSchool Reports page calls these endpoints relative to its configured API base. Every parent request checks the authenticated parent, the approved relationship in `student_parents`, and the active student/branch/class/year enrollment. Parents see only requests they submitted. Active report administrators can access requests in their branch. Teachers can list, inspect, update and download requests only for classes where they are the assigned homeroom teacher; the API rechecks that assignment on each action.

## Parent API

| Method | Path | Input / result |
| --- | --- | --- |
| GET | `/student-reports/:studentId/request-options` | Query `branchId,classId,academicYearId`; returns the scoped `academicYear` and `terms: [{id,label,labelLo,options}]` |
| GET | `/student-reports/:studentId/requests` | Same scope plus `limit` (1–100, default 100), `offset`; returns `{academicYear,requests,total,limit,offset}` |
| GET | `/student-reports/:studentId/requests/:id` | Same scope; request details/history and a short-lived document URL when ready |
| POST | `/student-reports/:studentId/requests` | JSON below; mandatory `Idempotency-Key` header (16–128 ASCII letters, digits, colon, underscore or hyphen); returns the stored request |

```json
{
  "branchId": "<UUID>",
  "classId": "<UUID>",
  "academicYearId": "<UUID>",
  "selectionId": "<option.id>",
  "documentLanguage": "en",
  "sourceReportId": "<option.sourceReportId>",
  "sourceVersion": 2,
  "template": { "family": "montessori", "level": "Twos", "templateVersion": "aims-report-mon-v2" }
}
```

`documentLanguage` accepts `en` or `lo`, independently of the app locale. The server resolves the selection and template again; mismatched source/version/template or unavailable results return **409**, prompting the app to reload. Retries with the same key and intent return the original request, even after the source changes or is deleted. Reusing a key for a different request returns 409. A transaction/advisory lock plus a unique constraint prevents concurrent duplicate inserts. Repeating an intentional request with a new key is allowed.

Primary monthly reports may send `selections` instead of the single selection fields: `[{selectionId,sourceReportId,sourceVersion,template}, …]`. Choose 1–12 available primary months from the same term. The request is one reference and one queue row; its `reportingPeriods` list and each requested document identify every chosen month. This is not limited to particular months: any available months, including 1–12, are supported. The server freezes each monthly source separately and creates a separate document for each selected month.

Primary options include `documents`: `primary-monthly`, `primary-evaluation` and `primary-yellow-book`, each with `canRequest`. The parent selects `documentType` before sending. Evaluation requests also require a `subjectSlot` from that document's available `subjects`. The server verifies both values and freezes only that subject for evaluation requests. Responses include `documentType,documentLabel,documentLabelLo,subjectSlot,subjectName` as applicable. Yellow Book exports cover the requested reporting period.

A single primary request can include multiple documents and evaluation subjects with `documents: [{documentType:"primary-monthly"}, {documentType:"primary-evaluation",subjectSlot:"lao"}, {documentType:"primary-evaluation",subjectSlot:"english"}, {documentType:"primary-yellow-book"}]`. Choose 1–32 unique type/subject pairs in the same student, source period and document language. `documents` cannot be mixed with the old top-level `documentType`/`subjectSlot` fields. Every entry is validated against that student's available options; the server resolves labels/subject metadata itself. Duplicates and empty lists return 400; unavailable documents/subjects return 409. Selection order is normalized so retries with the same entries in a different order still return one request.

Primary responses expose the resolved `documents` list. Each requested item has its own ID, status and (when ready) download URL. The top-level document fields remain the first item for compatibility. Legacy requests and downloads still work. Evaluation-only requests freeze the union of selected subjects; a bundle containing Monthly Report or Yellow Book freezes all eligible subject scores for the selected child. One reference and history cover the request; its status becomes `ready` after every requested PDF is ready. Each document is stored and released independently.


The response contains `id,reference,studentId,branchId,classId,academicYearId,academicYear,studentName,className,term,termLo,period,periodLo,reportingStart,reportingEnd,documentLanguage,format,formatLo,template,selectionId,sourceReportId,sourceVersion,status,version,requestedAt,updatedAt,history,declineReason,declineReasonLo`. Parent responses exclude the source payload and internal activity actor IDs.

## Availability and automatic templates

- **Montessori:** saved reports take priority, matching Learning Results. Each option uses the saved term, date range, level and `templateVersion`. At least one valid learning/behavior rating and a mapped template with a valid date range are required. Source save versions are never labeled as assessment rounds. The complete saved payload, including its actual subjects/skills, is frozen with the request.
- **Primary:** resolve the existing grade/template mapping. For each September–June reporting month, prefer the latest published v2 snapshot; use the latest reviewed snapshot when no publication exists, matching the app. The selected student must have a numeric score in an enabled subject with a positive report maximum; zero is a recorded score. Calendar years derive from the selected academic year. Terms use the school's valid `term2Start`, or the portal calendar's February default. Labels are real reporting months. The stored source includes only this student's results/comments and the subject definitions, never the other children's rows.
- **Kindergarten:** use the existing mapped `kindergarten-1/2/3` template, stored assessment term and round, and quality 1–3. Dates come from the recorded assessments. Template versions match the portal's `kgN-original-1` main report. Records without a valid grade mapping are unavailable. Assessments have no revision counter: a SHA-256 content identity detects changes/deletions, with `sourceVersion: 1` identifying that immutable content snapshot.

Submitted request metadata and source snapshots are independent of source report deletion. No score, enrollment or template record is modified. The snapshot records the results used for the request; PDF rendering is performed by the school/portal using the matching template and requested document language.

## School / web portal API

| Method | Path | Input / result |
| --- | --- | --- |
| GET | `/official-report-requests/:branchId` | Queue `{requests,total,limit,offset}`; optional `status,studentId,academicYearId,limit,offset` |
| GET | `/official-report-requests/:branchId/:id` | Detail plus `parentId`, frozen `sourceSnapshot` and activity actor IDs |
| PATCH | `/official-report-requests/:branchId/:id` | JSON `{status:"preparing",expectedVersion:1}` or `{status:"declined",expectedVersion:1,declineReason:"...",declineReasonLo:"..."}` |
| PATCH | `/official-report-requests/:branchId/:id/documents/:documentId` | JSON `{status:"preparing",expectedVersion:1}`; updates one requested document |
| POST | `/official-report-requests/:branchId/:id/document` | Legacy single-file upload: multipart `file` (PDF, max 10 MiB) and `expectedVersion` |
| GET | `/official-report-requests/:branchId/:id/document` | Legacy single-file download for an authenticated administrator or assigned homeroom teacher |
| POST / GET | `/official-report-requests/:branchId/:id/documents/:documentId/document` | Upload one PDF or download that ready PDF; each item has its own status/version |

All school endpoints require the usual Bearer token. Per-document transitions are `submitted → preparing → ready`; the parent request remains `preparing` until all its documents are ready. Every update locks the request, checks `expectedVersion`, increments versions, and appends activity. Conflicting updates return 409. Declining requires a reason. No public upload directory or client-provided document URL is used.

Parents open each ready item's `documentUrl` from a fresh detail response. `/official-report-documents/:id/:documentId?token=...` verifies a **five-minute, request/parent/document/version-bound token signed with a separate key**, then rechecks the active parent relationship/enrollment before streaming that PDF as an attachment. The legacy `/official-report-documents/:id?token=...` route remains for previously issued single-file requests. Download tokens cannot serve as ordinary API Bearer tokens. Responses use `private, no-store`. Proxy configuration must preserve the external host/protocol so generated links are reachable by the app.

### Parent deletion

`DELETE /student-reports/:studentId/requests/:id` uses the enrollment query (`branchId,classId,academicYearId`) and JSON `{expectedVersion}`. Only the authenticated parent who created the request may delete it; a different linked parent of the same child cannot. The API locks the scoped row and rejects changed versions with 409. Successful deletion removes the request and its PDF from both app and portal and revokes previous download links. The app shows a delete icon on each request and its detail page, confirms permanent deletion, and keeps the row until the server acknowledges success.

## Database and checks

Migrations: `1791781000000-CreateOfficialReportRequests.ts` creates the request table; `1791781100000-CreateOfficialReportRequestDocuments.ts` adds private per-document PDF storage and backfills pending requests; `1791781200000-AddOfficialReportRequestMultiPeriod.ts` permits the same document type for each selected month in one request. Existing released single-file requests are retained unchanged.

Apply with the normal deployment migration workflow. Locally, `npm run migration:official-reports:local` and `npm run migration:official-report-documents:local` prepare the existing request tables, then `npm run migration:official-report-multi-period:local` applies the multi-month document key to a localhost DB without running unrelated pending migrations. Re-running is safe. Removing the table via a down migration destroys requests and PDFs; do not revert after real requests exist without a backup.

Run `npm run test:official-reports` with the existing local PostgreSQL configuration. The authenticated HTTP integration test creates and drops an isolated schema, covering enrollment/parent/branch scope, all three source families, no-score/mapping eligibility, zero scores, tampering/staleness, concurrent idempotency, retry after source deletion, child-only immutable snapshots, pagination, school permissions and status conflicts, PDF validation, download expiry and relationship revocation. It never inserts test requests into school tables. Flutter contract/UI tests: `flutter test --no-pub test/official_report_requests_test.dart` in AlphaSchool.

The portal management screen is implemented at `/v/4c3d2e1f` in ClassroomConnect_UI. Staff queue/details include `parent: {id,name,nameEn}` and `student: {id,code,name,nameEn}` for the authorized request scope.

For primary requests, staff review the saved scores and choose **Confirm & create report**. The portal's `POST /api/rubric/official-report-request-confirm` accepts `{branchId,requestId,expectedVersion}`, retrieves the authorized immutable snapshot, renders each requested document in English or Lao, and uploads each PDF separately. One confirmation handles all selected items; the portal and parent app show each file and its status independently. The overall request becomes ready when all documents are released. Repeating a completed confirmation returns the ready request; competing updates are protected by backend version checks. A failure leaves already released files intact and unfinished items available for retry. The renderer selects only the requested child's scores/comments even if a source array contains additional children. It reuses the Review screen's bundled Excel monthly template, mapped evaluation print page and original Lao Yellow Book PDF/overlays. The original Lao Yellow Book template is retained at the user's request, including when the selected student name is English. It requires Playwright Chromium (with installed Chrome as fallback) and the portal's bundled Lao font. Montessori and kindergarten requests retain the prepare/attach/preview workflow.

Portal checks: `npm test -- test/officialReportRequestExport.test.ts test/officialReportRequestConfirm.test.ts`. The confirmation tests use isolated HTTP servers and real PDF rendering for all three primary documents in both languages, validate multipart uploads and retry/error behavior, and extract PDF text using `pdftotext` (Poppler). Start the local portal before these checks; the isolated test servers forward print-page assets to it. They do not modify school data. Full rendering trace: `ClassroomConnect_UI/docs/official-report-request-rendering.md`.

With the portal running, browser checks: `PLAYWRIGHT_CHANNEL=chrome npx playwright test test/e2e/officialReportRequestConfirm.spec.ts --workers=1 --output=/tmp/cc-official-request-playwright`. These intercept API calls with fixtures and verify score review, automatic confirmation, duplicate-click prevention and conflict recovery. Omit `PLAYWRIGHT_CHANNEL` when Playwright's bundled Chromium is installed.

### Delete a request

`DELETE /official-report-requests/:branchId/:id` accepts `{ "expectedVersion": <current version> }`. It uses the same authenticated branch/class authorization as updates and locks the request before checking its version. Stale versions return 409; success returns `{ "id": "...", "deleted": true }`. Deletion permanently removes the request, frozen snapshot and private PDF; parent history/detail and previously issued PDF links no longer expose it. The portal requires explicit confirmation that includes the reference and loss of parent access.
