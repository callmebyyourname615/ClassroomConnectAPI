import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DataSource, EntityManager } from 'typeorm';
import { studentReportTemplate } from '../kindergarten/student-reports.service';
import { MontessoriService } from '../montessori/montessori.service';
import { validUuid } from '../montessori/montessori.validation';
import { reportSelections } from './report-request-sources';
import {
  requestedDocuments,
  resolveRequestedDocuments,
} from './report-request-documents';
import { NotificationsService } from '../notifications/notifications.service';

const fields =
  'id,reference,parent_id,student_id,branch_id,class_id,academic_year_id,metadata,status,version,history,decline_reason,decline_reason_lo,requested_at,updated_at';
const where =
  'parent_id=$1 AND student_id=$2 AND branch_id=$3 AND class_id=$4 AND academic_year_id=$5';
const statuses = ['submitted', 'preparing', 'ready', 'declined'];
const activity = {
  submitted: ['Request submitted', 'ສົ່ງຄຳຂໍແລ້ວ'],
  preparing: ['School is preparing the report', 'ໂຮງຮຽນກຳລັງກະກຽມລາຍງານ'],
  ready: ['Report ready', 'ລາຍງານພ້ອມແລ້ວ'],
  declined: ['Request declined', 'ຄຳຂໍຖືກປະຕິເສດ'],
};
const requestNotificationTitles = {
  submitted: ['New official report request', 'ມີຄຳຂໍລາຍງານໃໝ່'],
  preparing: ['Report request is being prepared', 'ໂຮງຮຽນກຳລັງກະກຽມລາຍງານ'],
  document_ready: [
    'Requested report document is ready',
    'ເອກະສານລາຍງານພ້ອມແລ້ວ',
  ],
  ready: ['Official report is ready', 'ລາຍງານພ້ອມແລ້ວ'],
  declined: ['Report request declined', 'ຄຳຂໍລາຍງານຖືກປະຕິເສດ'],
} as const;
type RequestNotificationEvent = keyof typeof requestNotificationTitles;

@Injectable()
export class ReportRequestsService {
  constructor(
    private readonly db: DataSource,
    private readonly staff: MontessoriService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  private async notifyReportRequest(
    manager: EntityManager,
    request: any,
    event: RequestNotificationEvent,
    document?: any,
  ) {
    const details = request.metadata || {};
    const documentDetails = document?.metadata || details;
    const period = documentDetails.period || details.period || '';
    const periodLo = documentDetails.periodLo || details.periodLo || period;
    const documentLabel =
      documentDetails.documentLabel || documentDetails.documentType || '';
    const documentLabelLo = documentDetails.documentLabelLo || documentLabel;
    const reason = request.decline_reason || '';
    const reasonLo = request.decline_reason_lo || reason;
    const message = [
      details.studentName,
      request.reference,
      periodLo,
      documentLabelLo,
      reasonLo,
    ]
      .filter(Boolean)
      .join(' · ');
    const metadata = {
      type: 'official_report_request',
      event,
      requestId: request.id,
      reference: request.reference,
      studentName: details.studentName || '',
      period,
      periodLo,
      documentLabel,
      documentLabelLo,
      declineReason: reason,
      declineReasonLo: reasonLo,
    };
    const [titleEn, titleLo] = requestNotificationTitles[event];
    await this.notifications.createInTransaction(manager, {
      title: titleLo || titleEn,
      message,
      branch_id: event === 'submitted' ? request.branch_id : undefined,
      academic_year_id: request.academic_year_id,
      student_id: request.student_id,
      parent_id: event === 'submitted' ? undefined : request.parent_id,
      module_id: request.id,
      module_type: 'report_request',
      metadata,
    });
  }

  private async scope(
    manager: EntityManager,
    user: any,
    student: string,
    q: Record<string, any>,
  ) {
    if (![student, q.branchId, q.classId, q.academicYearId].every(validUuid))
      throw new BadRequestException(
        'Student, branch, class and academic year are required.',
      );
    if (user?.user_type !== 'parent' || !validUuid(user.sub))
      throw new ForbiddenException('Parent access required.');
    const [scope] = await manager.query(
      `SELECT y.year_name,
      g.id AS grade_id,g.name AS grade_name,g.name_translations AS grade_translations,l.name AS level_name,
      concat_ws(' ',s.first_name_lao,s.last_name_lao) AS student_name,c.name AS class_name
      FROM parents p JOIN student_parents sp ON sp.parent_id=p.id JOIN students s ON s.id=sp.student_id
      JOIN enrollments e ON e.student_id=s.id JOIN classes c ON c.id=e.class_id
      JOIN academic_years y ON y.id=e.academic_year_id AND y.branch_id=e.branch_id
      JOIN year_levels g ON g.id=c.year_level_id JOIN levels l ON l.id=g.level_id
      WHERE p.id=$1 AND s.id=$2 AND e.branch_id=$3 AND e.class_id=$4 AND e.academic_year_id=$5
      AND p."isActive"=true AND p."isDeleted"=false AND s.is_active=true AND s.is_deleted=false
      AND e.is_active=true AND c.is_deleted=false AND y.is_deleted=false`,
      [user.sub, student, q.branchId, q.classId, q.academicYearId],
    );
    if (!scope)
      throw new ForbiddenException(
        'This student enrollment is not linked to your account.',
      );
    return {
      ...scope,
      studentId: student,
      branchId: q.branchId,
      classId: q.classId,
      academicYearId: q.academicYearId,
      academicYear: scope.year_name.replace('–', '-'),
    };
  }

  private params(user: any, student: string, q: any) {
    return [user.sub, student, q.branchId, q.classId, q.academicYearId];
  }

  private pagination(q: any) {
    const limit = Number(q.limit ?? 100),
      offset = Number(q.offset ?? 0);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0
    )
      throw new BadRequestException('Invalid pagination.');
    return { limit, offset };
  }

  private serialize(row: any, children?: any[]) {
    const documents = children?.length
      ? children.map((child) => ({
          ...child.metadata,
          id: child.id,
          status: child.status,
          version: child.version,
          updatedAt: new Date(child.updated_at).toISOString(),
        }))
      : row.metadata.documents;
    return {
      ...row.metadata,
      ...(documents?.length ? { documents } : {}),
      id: row.id,
      reference: row.reference,
      studentId: row.student_id,
      branchId: row.branch_id,
      classId: row.class_id,
      academicYearId: row.academic_year_id,
      status: row.status,
      version: row.version,
      requestedAt: new Date(row.requested_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      history: row.history.map(({ actorId, ...item }: any) => item),
      declineReason: row.decline_reason,
      declineReasonLo: row.decline_reason_lo,
    };
  }

  private async documentRows(requestIds: string[]) {
    if (!requestIds.length) return new Map<string, any[]>();
    const rows = await this.db.query(
      `SELECT id,request_id,document_type,subject_slot,metadata,status,version,updated_at
       FROM official_report_request_documents WHERE request_id=ANY($1::uuid[])
       ORDER BY requested_at,id`,
      [requestIds],
    );
    const grouped = new Map<string, any[]>();
    for (const row of rows) {
      const items = grouped.get(row.request_id) || [];
      items.push(row);
      grouped.set(row.request_id, items);
    }
    return grouped;
  }

  private async sources(manager: EntityManager, scope: any) {
    const args = [
      scope.branchId,
      scope.studentId,
      scope.classId,
      scope.academicYearId,
    ];
    const montessori = await manager.query(
      'SELECT * FROM montessori_reports WHERE branch_id=$1 AND student_id=$2 AND class_id=$3 AND academic_year_id=$4 ORDER BY term,updated_at DESC,id',
      args,
    );
    const [school] = await manager.query(
      "SELECT payload FROM kindergarten_records WHERE branch_id=$1 AND collection='school' AND record_key=$1::text",
      [scope.branchId],
    );
    let mappings = {};
    try {
      mappings = JSON.parse(school?.payload?.reportTemplates || '{}');
    } catch {
      /* No valid report template mapping. */
    }
    const mapped = studentReportTemplate(scope, mappings);
    const useMontessori =
      montessori.length > 0 &&
      mapped !== 'primary' &&
      !mapped.startsWith('kindergarten-');
    const primary = useMontessori
      ? []
      : await manager.query(
          `SELECT id,kind,payload FROM rubric_report_data
      WHERE class_id=$1 AND payload->>'classId'=$1 AND payload->>'academicYearId'=$2
      AND kind IN ('monthly-report-snapshot-v2','monthly-report-review-snapshot-v2') AND (expires_at IS NULL OR expires_at>now())
      ORDER BY updated_at DESC,id`,
          [scope.classId, scope.academicYearId],
        );
    const kindergartenRecords = useMontessori
      ? []
      : await manager.query(
          `SELECT collection,record_key AS key,payload AS value FROM kindergarten_records
      WHERE branch_id=$1 AND split_part(record_key,'|',1)=$1::text AND split_part(record_key,'|',2)=$2
      AND split_part(record_key,'|',3) IN ($3::text,$3::text||'::'||$4::text)
      AND ((collection IN ('growth','assessments') AND split_part(record_key,'|',4)=$5)
        OR (collection='activities' AND split_part(record_key,'|',4) BETWEEN $6 AND $7)
        OR (collection='daily' AND split_part(record_key,'|',4) BETWEEN $6 AND $7 AND split_part(record_key,'|',7)=$5)
        OR (collection IN ('reviews','weekly') AND split_part(record_key,'|',4) BETWEEN $6 AND $7 AND split_part(record_key,'|',5)=$5))
      ORDER BY collection,record_key`,
          [
            scope.branchId,
            scope.academicYear,
            scope.classId,
            scope.academicYearId,
            scope.studentId,
            `${Number(scope.academicYear.match(/\d{4}/)?.[0])}-09`,
            `${Number(scope.academicYear.match(/\d{4}/)?.[0]) + 1}-08`,
          ],
        );
    const kindergartenAttendance = useMontessori
      ? []
      : await manager.query(
          `SELECT to_char(a.attendance_date,'YYYY-MM-DD') AS attendance_date,a.student_id,a.type,a.reason,a.remark
      FROM attendances a JOIN enrollments e ON e.student_id=a.student_id
      JOIN academic_years y ON y.id=e.academic_year_id AND y.branch_id=e.branch_id
      WHERE e.branch_id=$1 AND e.class_id=$2 AND e.academic_year_id=$3 AND a.student_id=$4
      AND a.attendance_date BETWEEN y.start_date AND y.end_date
      ORDER BY a.attendance_date`,
          [scope.branchId, scope.classId, scope.academicYearId, scope.studentId],
        );
    const kindergartenReports = useMontessori
      ? []
      : await manager.query(
          `SELECT id,kind,revision,snapshot FROM kindergarten_reports
           WHERE branch_id=$1 AND class_id=$2 AND academic_year_id=$3
           ORDER BY created_at DESC,id`,
          [scope.branchId, scope.classId, scope.academicYearId],
        );
    return reportSelections(
      scope,
      school?.payload,
      useMontessori ? montessori : [],
      primary,
      [],
      kindergartenReports,
      kindergartenRecords,
      kindergartenAttendance,
    );
  }

  async options(user: any, student: string, q: any) {
    return this.db.transaction('REPEATABLE READ', async (manager) => {
      const scope = await this.scope(manager, user, student, q);
      const sources = await this.sources(manager, scope);
      const terms: Record<string, any>[] = [];
      for (const s of sources) {
        let term = terms.find((t) => t.id === s.termId);
        if (!term) {
          term = {
            id: s.termId,
            label: s.term,
            labelLo: s.termLo,
            options: [],
          };
          terms.push(term);
        }
        term.options.push(s.option);
      }
      return {
        studentId: student,
        branchId: q.branchId,
        classId: q.classId,
        academicYearId: q.academicYearId,
        academicYear: scope.academicYear,
        terms,
      };
    });
  }

  async history(user: any, student: string, q: any) {
    const scope = await this.scope(this.db.manager, user, student, q);
    const { limit, offset } = this.pagination(q);
    const params = this.params(user, student, q);
    const [count] = await this.db.query(
      `SELECT count(*)::int AS total FROM official_report_requests WHERE ${where}`,
      params,
    );
    const rows = await this.db.query(
      `SELECT ${fields} FROM official_report_requests WHERE ${where} ORDER BY requested_at DESC,id LIMIT $6 OFFSET $7`,
      [...params, limit, offset],
    );
    const children = await this.documentRows(rows.map((r) => r.id));
    return {
      academicYear: scope.academicYear,
      requests: rows.map((r) => this.serialize(r, children.get(r.id))),
      total: count.total,
      limit,
      offset,
    };
  }

  async parentRemove(
    user: any,
    student: string,
    id: string,
    q: any,
    body: any,
  ) {
    if (!Number.isInteger(body?.expectedVersion) || body.expectedVersion < 1)
      throw new BadRequestException('expectedVersion is required.');
    return this.db.transaction(async (manager) => {
      await this.scope(manager, user, student, q);
      const params = [...this.params(user, student, q), id];
      const [row] = await manager.query(
        `SELECT version FROM official_report_requests WHERE ${where} AND id=$6 FOR UPDATE`,
        params,
      );
      if (!row) throw new NotFoundException('Request not found.');
      if (row.version !== body.expectedVersion)
        throw new ConflictException(
          'Request changed. Refresh before deleting.',
        );
      await manager.query(
        `DELETE FROM official_report_requests WHERE ${where} AND id=$6`,
        params,
      );
      return { id, deleted: true };
    });
  }

  private documentSecret() {
    return `${this.config.get<string>('JWT_SECRET') || 'MY_SUPER_SECRET_KEY'}:official-report-documents`;
  }

  async detail(
    user: any,
    student: string,
    id: string,
    q: any,
    baseUrl: string,
  ) {
    await this.scope(this.db.manager, user, student, q);
    if (!validUuid(id)) throw new BadRequestException('Invalid request.');
    const [row] = await this.db.query(
      `SELECT ${fields} FROM official_report_requests WHERE ${where} AND id=$6`,
      [...this.params(user, student, q), id],
    );
    if (!row) throw new NotFoundException('Request not found.');
    const childRows = (await this.documentRows([id])).get(id) || [];
    const result = this.serialize(row, childRows);
    if (childRows.length) {
      for (const child of childRows) {
        if (child.status !== 'ready') continue;
        const token = await this.jwt.signAsync(
          {
            sub: user.sub,
            requestId: id,
            documentId: child.id,
            purpose: 'official-report-download',
            version: child.version,
          },
          { secret: this.documentSecret(), expiresIn: 300 },
        );
        const document = (result.documents as any[]).find(
          (item) => item.id === child.id,
        );
        if (document)
          document.documentUrl = `${baseUrl}/official-report-documents/${id}/${child.id}?token=${encodeURIComponent(token)}`;
      }
    } else if (row.status === 'ready') {
      const token = await this.jwt.signAsync(
        {
          sub: user.sub,
          requestId: id,
          purpose: 'official-report-download',
          version: row.version,
        },
        { secret: this.documentSecret(), expiresIn: 300 },
      );
      result['documentUrl'] =
        `${baseUrl}/official-report-documents/${id}?token=${encodeURIComponent(token)}`;
    }
    return result;
  }

  private reportSelections(body: any) {
    const input = body?.selections;
    if (
      input !== undefined &&
      (!Array.isArray(input) ||
        !input.length ||
        input.length > 12 ||
        body.selectionId !== undefined ||
        body.sourceReportId !== undefined ||
        body.sourceVersion !== undefined ||
        body.template !== undefined)
    )
      throw new BadRequestException(
        'Select between 1 and 12 reporting periods.',
      );
    const candidates =
      input === undefined
        ? [
            {
              selectionId: body?.selectionId,
              sourceReportId: body?.sourceReportId,
              sourceVersion: body?.sourceVersion,
              template: body?.template,
            },
          ]
        : input;
    const ids = new Set<string>();
    const selections = candidates.map((selection: any) => {
      if (
        !selection ||
        typeof selection !== 'object' ||
        Array.isArray(selection) ||
        typeof selection.selectionId !== 'string' ||
        !selection.selectionId ||
        selection.selectionId.length > 255 ||
        typeof selection.sourceReportId !== 'string' ||
        !selection.sourceReportId ||
        selection.sourceReportId.length > 255 ||
        !Number.isSafeInteger(selection.sourceVersion) ||
        selection.sourceVersion < 1 ||
        !selection.template ||
        typeof selection.template !== 'object' ||
        Array.isArray(selection.template) ||
        !ids.add(selection.selectionId)
      )
        throw new BadRequestException(
          'An available reporting period is required.',
        );
      return {
        selectionId: selection.selectionId,
        sourceReportId: selection.sourceReportId,
        sourceVersion: selection.sourceVersion,
        template: selection.template,
      };
    });
    return selections.sort((a, b) =>
      a.selectionId.localeCompare(b.selectionId),
    );
  }

  async create(user: any, student: string, body: any, key: string) {
    if (
      !body ||
      JSON.stringify(body).length > 10000 ||
      !['en', 'lo'].includes(body.documentLanguage) ||
      typeof key !== 'string' ||
      !/^[a-zA-Z0-9:_-]{16,128}$/.test(key)
    )
      throw new BadRequestException(
        'An available selection, English or Lao document language and Idempotency-Key are required.',
      );
    const reportSelections = this.reportSelections(body);
    if (
      (body.documentType !== undefined &&
        (typeof body.documentType !== 'string' ||
          body.documentType.length > 64)) ||
      (body.subjectSlot !== undefined &&
        (typeof body.subjectSlot !== 'string' ||
          body.subjectSlot.length > 64)) ||
      (body.subjectSlot && !body.documentType)
    )
      throw new BadRequestException('Invalid requested document.');
    const selections = requestedDocuments(body);
    const intent = {
      studentId: student,
      branchId: body.branchId,
      classId: body.classId,
      academicYearId: body.academicYearId,
      documentLanguage: body.documentLanguage,
      selections: reportSelections,
      ...(selections ? { documents: selections } : {}),
      ...(body.documentType !== undefined
        ? {
            documentType: body.documentType,
            subjectSlot: body.subjectSlot || '',
          }
        : {}),
    };
    // Serialize retries; under READ COMMITTED the next read sees the first request's commit.
    const result = await this.db.transaction(async (manager) => {
      const scope = await this.scope(manager, user, student, body);
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `official-report:${user.sub}:${key}`,
      ]);
      const [existing] = await manager.query(
        `SELECT ${fields},intent FROM official_report_requests WHERE parent_id=$1 AND idempotency_key=$2`,
        [user.sub, key],
      );
      if (existing) {
        if (!isDeepStrictEqual(existing.intent, intent))
          throw new ConflictException(
            'This Idempotency-Key was used for a different request.',
          );
        return this.serialize(existing);
      }
      const sources = await this.sources(manager, scope);
      const selectedSources = reportSelections
        .map((selection) => {
          const source = sources.find(
            (candidate) => candidate.option.id === selection.selectionId,
          );
          if (
            !source ||
            !source.option.canRequest ||
            source.option.sourceReportId !== selection.sourceReportId ||
            source.option.sourceVersion !== selection.sourceVersion ||
            !isDeepStrictEqual(source.option.template, selection.template)
          )
            throw new ConflictException(
              'The report or template changed. Reload the available reporting periods.',
            );
          return source;
        })
        .sort((a, b) =>
          String(a.option.reportingStart).localeCompare(
            String(b.option.reportingStart),
          ),
        );
      const [source] = selectedSources;
      const option = source.option;
      if (
        selectedSources.length > 1 &&
        (option.template.family !== 'primary' ||
          selectedSources.some(
            (candidate) =>
              candidate.termId !== source.termId ||
              candidate.option.template.family !== 'primary',
          ))
      )
        throw new ConflictException(
          'Multiple reporting periods are available for primary monthly reports in the same term only.',
        );
      let documentMetadata = {};
      let snapshot = source.snapshot;
      if (option.template.family === 'primary') {
        const requested = selections || [
          {
            documentType: body.documentType || 'primary-monthly',
            ...(body.subjectSlot ? { subjectSlot: body.subjectSlot } : {}),
          },
        ];
        const snapshots: any[] = [];
        const documents = selectedSources.flatMap((candidate) => {
          const resolved = resolveRequestedDocuments(
            candidate.option.documents,
            requested,
          );
          let candidateSnapshot = candidate.snapshot;
          if (
            resolved.every(
              (document) => document.documentType === 'primary-evaluation',
            )
          ) {
            const subjects = new Set(
              resolved.map((document) => document.subjectSlot),
            );
            candidateSnapshot = {
              ...candidateSnapshot,
              subjectDefinitions: candidateSnapshot.subjectDefinitions.filter(
                (definition: any) => subjects.has(definition.slotKey),
              ),
              students: candidateSnapshot.students.map((item: any) => ({
                ...item,
                scores: Object.fromEntries(
                  Object.entries(item.scores).filter(([slot]) =>
                    subjects.has(slot),
                  ),
                ),
              })),
            };
          }
          snapshots.push({
            selectionId: candidate.option.id,
            sourceReportId: candidate.option.sourceReportId,
            sourceVersion: candidate.option.sourceVersion,
            template: candidate.option.template,
            snapshot: candidateSnapshot,
          });
          return resolved.map((document) => ({
            ...document,
            selectionId: candidate.option.id,
            period: candidate.option.label,
            periodLo: candidate.option.labelLo,
            reportingStart: candidate.option.reportingStart,
            reportingEnd: candidate.option.reportingEnd,
          }));
        });
        documentMetadata = {
          ...documents[0],
          documents,
        };
        snapshot =
          snapshots.length === 1
            ? snapshots[0].snapshot
            : { selections: snapshots };
      } else if (option.template.family === 'kindergarten') {
        if (selectedSources.length !== 1 || !selections?.length)
          throw new BadRequestException(
            'Select one or more available kindergarten documents.',
          );
        const documents = resolveRequestedDocuments(
          option.documents || [],
          selections,
        ).map((document) => ({
          ...document,
          selectionId: option.id,
          period: option.label,
          periodLo: option.labelLo,
          reportingStart: option.reportingStart,
          reportingEnd: option.reportingEnd,
        }));
        documentMetadata = { ...documents[0], documents };
        snapshot = source.snapshot;
      } else {
        if (
          selectedSources.length > 1 ||
          selections ||
          body.documentType ||
          body.subjectSlot
        )
          throw new BadRequestException(
            'Document selection is supported for primary reports only.',
          );
        const childDocuments = [
          {
            documentType: 'official-report',
            documentLabel: option.format,
            documentLabelLo: option.formatLo,
          },
        ];
        documentMetadata = {
          ...childDocuments[0],
          documents: childDocuments,
        };
      }
      const reportingPeriods = selectedSources.map((candidate) => ({
        selectionId: candidate.option.id,
        period: candidate.option.label,
        periodLo: candidate.option.labelLo,
        reportingStart: candidate.option.reportingStart,
        reportingEnd: candidate.option.reportingEnd,
        sourceReportId: candidate.option.sourceReportId,
        sourceVersion: candidate.option.sourceVersion,
        template: candidate.option.template,
      }));
      const finalPeriod = reportingPeriods[reportingPeriods.length - 1];
      const metadata: Record<string, any> = {
        academicYear: scope.academicYear,
        studentName: scope.student_name,
        className: scope.class_name,
        term: source.term,
        termLo: source.termLo,
        period: reportingPeriods.map((period) => period.period).join(', '),
        periodLo: reportingPeriods.map((period) => period.periodLo).join(', '),
        reportingStart: reportingPeriods[0].reportingStart,
        reportingEnd: finalPeriod.reportingEnd,
        reportingPeriods,
        documentLanguage: body.documentLanguage,
        format: option.format,
        formatLo: option.formatLo,
        template: option.template,
        selectionId: option.id,
        selectionIds: reportingPeriods.map((period) => period.selectionId),
        sourceReportId: option.sourceReportId,
        sourceVersion: option.sourceVersion,
        ...documentMetadata,
      };
      const id = randomUUID();
      const history = [
        {
          label: activity.submitted[0],
          labelLo: activity.submitted[1],
          createdAt: new Date().toISOString(),
          actorId: user.sub,
        },
      ];
      const [row] = await manager.query(
        `INSERT INTO official_report_requests
        (id,reference,parent_id,student_id,branch_id,class_id,academic_year_id,idempotency_key,intent,metadata,source_snapshot,history)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb) RETURNING ${fields}`,
        [
          id,
          `RPT-${id.replaceAll('-', '').toUpperCase().slice(0, 20)}`,
          ...this.params(user, student, body),
          key,
          JSON.stringify(intent),
          JSON.stringify(metadata),
          JSON.stringify(snapshot),
          JSON.stringify(history),
        ],
      );
      for (const document of Array.isArray(metadata.documents)
        ? metadata.documents
        : []) {
        await manager.query(
          `INSERT INTO official_report_request_documents
           (request_id,selection_id,document_type,subject_slot,metadata,status)
           VALUES($1,$2,$3,$4,$5::jsonb,'submitted')`,
          [
            id,
            document.selectionId || '',
            document.documentType,
            document.subjectSlot || '',
            JSON.stringify(document),
          ],
        );
      }
      const childRows = await manager.query(
        `SELECT id,request_id,document_type,subject_slot,metadata,status,version,updated_at
         FROM official_report_request_documents WHERE request_id=$1 ORDER BY requested_at,id`,
        [id],
      );
      await this.notifyReportRequest(manager, row, 'submitted');
      return this.serialize(row, childRows);
    });
    await this.notifications.invalidateReportRequestNotifications(
      body.branchId,
    );
    return result;
  }

  private async authorizeStaff(user: any, branch: string) {
    const actor = await this.staff.authorize(user, branch);
    return actor;
  }

  private async checkStaffClass(
    actor: { id: string; canManageReports: boolean },
    classId: string,
    manager = this.db.manager,
  ) {
    if (actor.canManageReports) return;
    const [assigned] = await manager.query(
      'SELECT id FROM classes WHERE id=$1 AND homeroom_teacher_id=$2 AND is_deleted=false',
      [classId, actor.id],
    );
    if (!assigned)
      throw new ForbiddenException(
        'This class is not assigned to your account.',
      );
  }

  async queue(user: any, branch: string, q: any) {
    const actor = await this.authorizeStaff(user, branch);
    const { limit, offset } = this.pagination(q);
    if (q.status && !statuses.includes(q.status))
      throw new BadRequestException('Invalid status.');
    const params: any[] = [branch];
    let filter = 'branch_id=$1';
    if (!actor.canManageReports) {
      params.push(actor.id);
      filter +=
        ' AND class_id IN (SELECT id FROM classes WHERE homeroom_teacher_id=$2 AND is_deleted=false)';
    }
    for (const [field, column] of [
      ['academicYearId', 'academic_year_id'],
      ['studentId', 'student_id'],
      ['status', 'status'],
    ]) {
      if (q[field]) {
        if (field !== 'status' && !validUuid(q[field]))
          throw new BadRequestException(`Invalid ${field}.`);
        params.push(q[field]);
        filter += ` AND ${column}=$${params.length}`;
      }
    }
    const [count] = await this.db.query(
      `SELECT count(*)::int AS total FROM official_report_requests WHERE ${filter}`,
      params,
    );
    const rows = await this.db.query(
      `SELECT ${fields} FROM official_report_requests WHERE ${filter} ORDER BY requested_at DESC,id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return {
      requests: await this.staffRecords(rows),
      total: count.total,
      limit,
      offset,
    };
  }

  async staffDetail(user: any, branch: string, id: string) {
    const actor = await this.authorizeStaff(user, branch);
    const [row] = await this.db.query(
      `SELECT ${fields},source_snapshot FROM official_report_requests WHERE branch_id=$1 AND id=$2`,
      [branch, id],
    );
    if (!row) throw new NotFoundException('Request not found.');
    await this.checkStaffClass(actor, row.class_id);
    return {
      ...(await this.staffRecords([row]))[0],
      sourceSnapshot: row.source_snapshot,
      history: row.history,
    };
  }

  private async staffRecords(rows: any[]) {
    if (!rows.length) return [];
    const people = await this.db.query(
      `SELECT r.id,
      concat_ws(' ',p."firstName_lao",p."lastName_lao") AS parent_name,
      concat_ws(' ',p."firstName_eng",p."lastName_eng") AS parent_name_en,
      concat_ws(' ',s.first_name_lao,s.last_name_lao) AS student_name,
      concat_ws(' ',s.first_name_eng,s.last_name_eng) AS student_name_en,s.student_id AS student_code
      FROM official_report_requests r JOIN parents p ON p.id=r.parent_id JOIN students s ON s.id=r.student_id
      WHERE r.id=ANY($1::uuid[])`,
      [rows.map((r) => r.id)],
    );
    const byId = new Map(people.map((p: any) => [p.id, p]));
    const documentsByRequest = await this.documentRows(
      rows.map((row) => row.id),
    );
    return rows.map((row) => {
      const p: any = byId.get(row.id) || {};
      return {
        ...this.serialize(row, documentsByRequest.get(row.id)),
        parentId: row.parent_id,
        parent: {
          id: row.parent_id,
          name: p.parent_name || p.parent_name_en || '',
          nameEn: p.parent_name_en || p.parent_name || '',
        },
        student: {
          id: row.student_id,
          code: p.student_code || '',
          name:
            p.student_name ||
            p.student_name_en ||
            row.metadata.studentName ||
            '',
          nameEn:
            p.student_name_en ||
            p.student_name ||
            row.metadata.studentName ||
            '',
        },
      };
    });
  }

  async staffDocument(
    user: any,
    branch: string,
    id: string,
    documentId?: string,
  ) {
    const actor = await this.authorizeStaff(user, branch);
    if (documentId) {
      const [row] = await this.db.query(
        `SELECT r.reference,r.class_id,d.document_type,d.subject_slot,d.document
         FROM official_report_requests r JOIN official_report_request_documents d ON d.request_id=r.id
         WHERE r.branch_id=$1 AND r.id=$2 AND d.id=$3 AND d.status='ready'`,
        [branch, id, documentId],
      );
      if (!row?.document) throw new NotFoundException('Document not found.');
      await this.checkStaffClass(actor, row.class_id);
      return {
        content: row.document as Buffer,
        filename: `${row.reference}-${row.document_type}${row.subject_slot ? `-${row.subject_slot}` : ''}.pdf`,
      };
    }
    const [row] = await this.db.query(
      "SELECT reference,document,class_id FROM official_report_requests WHERE branch_id=$1 AND id=$2 AND status='ready'",
      [branch, id],
    );
    if (!row?.document) throw new NotFoundException('Document not found.');
    await this.checkStaffClass(actor, row.class_id);
    return {
      content: row.document as Buffer,
      filename: `${row.reference}.pdf`,
    };
  }

  async remove(user: any, branch: string, id: string, body: any) {
    const actor = await this.authorizeStaff(user, branch);
    if (!Number.isInteger(body?.expectedVersion) || body.expectedVersion < 1)
      throw new BadRequestException('expectedVersion is required.');
    return this.db.transaction(async (manager) => {
      const [row] = await manager.query(
        'SELECT class_id,version FROM official_report_requests WHERE branch_id=$1 AND id=$2 FOR UPDATE',
        [branch, id],
      );
      if (!row) throw new NotFoundException('Request not found.');
      await this.checkStaffClass(actor, row.class_id, manager);
      if (row.version !== body.expectedVersion)
        throw new ConflictException(
          'Request changed. Refresh before deleting.',
        );
      await manager.query(
        'DELETE FROM official_report_requests WHERE branch_id=$1 AND id=$2',
        [branch, id],
      );
      return { id, deleted: true };
    });
  }

  async updateDocumentStatus(
    user: any,
    branch: string,
    id: string,
    documentId: string,
    body: any,
  ) {
    const actor = await this.authorizeStaff(user, branch);
    if (
      body?.status !== 'preparing' ||
      !Number.isInteger(body?.expectedVersion) ||
      body.expectedVersion < 1
    )
      throw new BadRequestException('Status and expectedVersion are required.');
    const result = await this.db.transaction(async (manager) => {
      const [request] = await manager.query(
        `SELECT ${fields} FROM official_report_requests WHERE branch_id=$1 AND id=$2 FOR UPDATE`,
        [branch, id],
      );
      if (!request) throw new NotFoundException('Request not found.');
      await this.checkStaffClass(actor, request.class_id, manager);
      if (request.version !== body.expectedVersion)
        throw new ConflictException(
          'Request changed. Refresh before updating.',
        );
      if (!['submitted', 'preparing'].includes(request.status))
        throw new ConflictException('This request can no longer be prepared.');
      const [document] = await manager.query(
        `SELECT * FROM official_report_request_documents WHERE request_id=$1 AND id=$2 FOR UPDATE`,
        [id, documentId],
      );
      if (!document)
        throw new NotFoundException('Requested document not found.');
      if (document.status !== 'submitted')
        throw new ConflictException('This document is already being prepared.');
      const history = [
        ...request.history,
        {
          label: `Preparing: ${document.metadata.documentLabel || document.document_type}`,
          labelLo: `ກຳລັງກະກຽມ: ${document.metadata.documentLabelLo || document.metadata.documentLabel || document.document_type}`,
          createdAt: new Date().toISOString(),
          actorId: actor.id,
        },
      ];
      await manager.query(
        `UPDATE official_report_request_documents SET status='preparing',version=version+1,updated_at=now() WHERE request_id=$1 AND id=$2`,
        [id, documentId],
      );
      const [updated] = await manager.query(
        `UPDATE official_report_requests SET status='preparing',version=version+1,history=$3::jsonb,updated_at=now()
         WHERE branch_id=$1 AND id=$2 RETURNING ${fields}`,
        [branch, id, JSON.stringify(history)],
      );
      if (request.status === 'submitted')
        await this.notifyReportRequest(manager, updated[0], 'preparing');
      const children = await manager.query(
        `SELECT id,request_id,document_type,subject_slot,metadata,status,version,updated_at
         FROM official_report_request_documents WHERE request_id=$1 ORDER BY requested_at,id`,
        [id],
      );
      return this.serialize(updated[0], children);
    });
    await this.notifications.invalidateReportRequestNotifications(branch);
    return result;
  }

  async updateDocumentFile(
    user: any,
    branch: string,
    id: string,
    documentId: string,
    expectedVersion: number,
    file?: Buffer,
  ) {
    const actor = await this.authorizeStaff(user, branch);
    if (
      !Number.isInteger(expectedVersion) ||
      expectedVersion < 1 ||
      !file ||
      file.length > 10 * 1024 * 1024 ||
      !file.subarray(0, 5).equals(Buffer.from('%PDF-'))
    )
      throw new BadRequestException(
        'A PDF document of at most 10 MB and expectedVersion are required.',
      );
    const result = await this.db.transaction(async (manager) => {
      const [request] = await manager.query(
        `SELECT ${fields} FROM official_report_requests WHERE branch_id=$1 AND id=$2 FOR UPDATE`,
        [branch, id],
      );
      if (!request) throw new NotFoundException('Request not found.');
      await this.checkStaffClass(actor, request.class_id, manager);
      if (request.version !== expectedVersion)
        throw new ConflictException(
          'Request changed. Refresh before uploading.',
        );
      if (!['submitted', 'preparing'].includes(request.status))
        throw new ConflictException('This request can no longer be updated.');
      const [document] = await manager.query(
        `SELECT * FROM official_report_request_documents WHERE request_id=$1 AND id=$2 FOR UPDATE`,
        [id, documentId],
      );
      if (!document)
        throw new NotFoundException('Requested document not found.');
      if (!['submitted', 'preparing'].includes(document.status))
        throw new ConflictException('This document is already released.');
      const history = [
        ...request.history,
        {
          label: `Released: ${document.metadata.documentLabel || document.document_type}`,
          labelLo: `ສົ່ງແລ້ວ: ${document.metadata.documentLabelLo || document.metadata.documentLabel || document.document_type}`,
          createdAt: new Date().toISOString(),
          actorId: actor.id,
        },
      ];
      await manager.query(
        `UPDATE official_report_request_documents SET status='ready',version=version+1,document=$3,updated_at=now()
         WHERE request_id=$1 AND id=$2`,
        [id, documentId, file],
      );
      const [remaining] = await manager.query(
        `SELECT count(*)::int AS count FROM official_report_request_documents WHERE request_id=$1 AND id<>$2 AND status<>'ready'`,
        [id, documentId],
      );
      const status = remaining.count === 0 ? 'ready' : 'preparing';
      const [updated] = await manager.query(
        `UPDATE official_report_requests SET status=$3,version=version+1,history=$4::jsonb,updated_at=now()
         WHERE branch_id=$1 AND id=$2 RETURNING ${fields}`,
        [branch, id, status, JSON.stringify(history)],
      );
      await this.notifyReportRequest(
        manager,
        updated[0],
        status === 'ready' ? 'ready' : 'document_ready',
        document,
      );
      const children = await manager.query(
        `SELECT id,request_id,document_type,subject_slot,metadata,status,version,updated_at
         FROM official_report_request_documents WHERE request_id=$1 ORDER BY requested_at,id`,
        [id],
      );
      return this.serialize(updated[0], children);
    });
    await this.notifications.invalidateReportRequestNotifications(branch);
    return result;
  }

  async update(
    user: any,
    branch: string,
    id: string,
    body: any,
    document?: Buffer,
  ) {
    const actor = await this.authorizeStaff(user, branch);
    if (
      !Number.isInteger(body?.expectedVersion) ||
      body.expectedVersion < 1 ||
      !['preparing', 'declined', 'ready'].includes(body.status)
    )
      throw new BadRequestException('Status and expectedVersion are required.');
    if (
      body.status === 'ready' &&
      (!document ||
        document.length > 10 * 1024 * 1024 ||
        !document.subarray(0, 5).equals(Buffer.from('%PDF-')))
    )
      throw new BadRequestException(
        'A PDF document of at most 10 MB is required.',
      );
    if (body.status !== 'ready' && document)
      throw new BadRequestException(
        'Documents can only be attached when ready.',
      );
    if (
      body.status === 'declined' &&
      (typeof body.declineReason !== 'string' ||
        !body.declineReason.trim() ||
        body.declineReason.length > 2000 ||
        (body.declineReasonLo !== undefined &&
          (typeof body.declineReasonLo !== 'string' ||
            body.declineReasonLo.length > 2000)))
    )
      throw new BadRequestException(
        'A decline reason of at most 2000 characters is required.',
      );
    const result = await this.db.transaction(async (manager) => {
      const [row] = await manager.query(
        `SELECT ${fields} FROM official_report_requests WHERE branch_id=$1 AND id=$2 FOR UPDATE`,
        [branch, id],
      );
      if (!row) throw new NotFoundException('Request not found.');
      await this.checkStaffClass(actor, row.class_id, manager);
      if (row.version !== body.expectedVersion)
        throw new ConflictException(
          'Request changed. Refresh before updating.',
        );
      const [childCount] = await manager.query(
        'SELECT count(*)::int AS count FROM official_report_request_documents WHERE request_id=$1',
        [id],
      );
      if (body.status === 'ready' && childCount.count > 0)
        throw new BadRequestException(
          'Upload each requested document separately.',
        );
      if (
        ['ready', 'declined'].includes(row.status) ||
        row.status === body.status
      )
        throw new ConflictException('This status transition is not available.');
      const history = [
        ...row.history,
        {
          label: activity[body.status][0],
          labelLo: activity[body.status][1],
          createdAt: new Date().toISOString(),
          actorId: actor.id,
        },
      ];
      const [updated] = await manager.query(
        `UPDATE official_report_requests SET status=$3,version=version+1,history=$4::jsonb,
        decline_reason=$5,decline_reason_lo=$6,document=$7,updated_at=now() WHERE branch_id=$1 AND id=$2 RETURNING ${fields}`,
        [
          branch,
          id,
          body.status,
          JSON.stringify(history),
          body.status === 'declined' ? body.declineReason.trim() : '',
          body.status === 'declined' ? body.declineReasonLo || '' : '',
          document || null,
        ],
      );
      await this.notifyReportRequest(manager, updated[0], body.status);
      return this.serialize(updated[0]);
    });
    await this.notifications.invalidateReportRequestNotifications(branch);
    return result;
  }

  async document(id: string, token: string, documentId?: string) {
    let claims: any;
    try {
      claims = await this.jwt.verifyAsync(token, {
        secret: this.documentSecret(),
      });
    } catch {
      throw new UnauthorizedException(
        'This download link is invalid or expired. Open the request again.',
      );
    }
    if (
      claims.purpose !== 'official-report-download' ||
      claims.requestId !== id ||
      !validUuid(claims.sub) ||
      (documentId
        ? claims.documentId !== documentId || !validUuid(documentId)
        : claims.documentId !== undefined)
    )
      throw new UnauthorizedException('Invalid download link.');
    const [row] = documentId
      ? await this.db.query(
          `SELECT r.*,d.document,d.document_type,d.subject_slot FROM official_report_requests r
           JOIN official_report_request_documents d ON d.request_id=r.id
           WHERE r.id=$1 AND r.parent_id=$2 AND d.id=$3 AND d.version=$4 AND d.status='ready'`,
          [id, claims.sub, documentId, claims.version],
        )
      : await this.db.query(
          "SELECT * FROM official_report_requests WHERE id=$1 AND parent_id=$2 AND version=$3 AND status='ready'",
          [id, claims.sub, claims.version],
        );
    if (!row) throw new NotFoundException('Document not found.');
    await this.scope(
      this.db.manager,
      { sub: claims.sub, user_type: 'parent' },
      row.student_id,
      {
        branchId: row.branch_id,
        classId: row.class_id,
        academicYearId: row.academic_year_id,
      },
    );
    return {
      content: row.document as Buffer,
      filename: `${row.reference}${documentId ? `-${row.document_type}${row.subject_slot ? `-${row.subject_slot}` : ''}` : ''}.pdf`,
    };
  }
}
