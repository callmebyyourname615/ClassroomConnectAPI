import { reviewMonthlyReport } from './monthly-report-review';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, MoreThan, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { RubricReportData } from './rubric-report-data.entity';

export interface SaveRubricReportDataDto {
  kind: string;
  scopeKey?: string;
  classId?: string;
  studentId?: string;
  reportMonth?: number | string | null;
  reportYear?: string | number | null;
  payload: Record<string, unknown>;
  expiresInSeconds?: number | string | null;
}

export interface AtomicMonthlyReportPublishDto {
  id: string;
  idempotencyKey: string;
  configurationId: string;
  configurationVersion: number;
  academicYearId: string;
  classId: string;
  reportMonth: number;
  attempts?: number;
  snapshot: Record<string, unknown>;
  publishedConfiguration: Record<string, unknown>;
  previousPublishedSnapshot?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const CONFIGURATION_KIND = 'monthly-report-configuration-v2';
const SNAPSHOT_KIND = 'monthly-report-snapshot-v2';
const PUBLISH_OPERATION_KIND = 'monthly-report-publish-operation-v2';

@Injectable()
export class RubricReportDataService {
  constructor(
    @InjectRepository(RubricReportData)
    private readonly repo: Repository<RubricReportData>,
  ) {}

  private text(value: unknown) {
    return String(value ?? '').trim();
  }

  private month(value: unknown) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 12 ? parsed : null;
  }

  private normalize(dto: SaveRubricReportDataDto, transient = false) {
    const kind = this.text(dto.kind);
    const payload = dto.payload;
    if (!kind || kind.length > 64 || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestException('kind and object payload are required.');
    }
    const scopeKey = transient ? randomUUID() : this.text(dto.scopeKey);
    if (!scopeKey || scopeKey.length > 255) throw new BadRequestException('scopeKey is required.');
    const ttl = Number(dto.expiresInSeconds);
    const expiresAt = transient
      ? new Date(Date.now() + (Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, 604800) : 86400) * 1000)
      : null;
    return {
      kind,
      scopeKey,
      classId: this.text(dto.classId),
      studentId: this.text(dto.studentId),
      reportMonth: this.month(dto.reportMonth),
      reportYear: this.text(dto.reportYear),
      payload,
      expiresAt,
    };
  }

  private object(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private positiveInteger(value: unknown) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  }

  private validatePublishOperation(dto: AtomicMonthlyReportPublishDto) {
    const operation = this.object(dto);
    const snapshot = this.object(operation.snapshot);
    const publishedConfiguration = this.object(operation.publishedConfiguration);
    const previousPublishedSnapshot = operation.previousPublishedSnapshot
      ? this.object(operation.previousPublishedSnapshot)
      : undefined;
    const configurationId = this.text(operation.configurationId);
    const configurationVersion = this.positiveInteger(operation.configurationVersion);
    const academicYearId = this.text(operation.academicYearId);
    const classId = this.text(operation.classId);
    const reportMonth = this.month(operation.reportMonth);
    const idempotencyKey = this.text(operation.idempotencyKey);
    const snapshotVersion = this.positiveInteger(snapshot.version);

    if (!configurationId || !configurationVersion || !academicYearId || !classId || reportMonth === null
      || !idempotencyKey || !snapshotVersion || !Object.keys(snapshot).length || !Object.keys(publishedConfiguration).length) {
      throw new BadRequestException('The monthly report publish operation is incomplete.');
    }
    if (idempotencyKey !== `${configurationId}:${configurationVersion}`) {
      throw new BadRequestException('The monthly report idempotency key is invalid.');
    }
    const sameScope = (value: Record<string, unknown>) => (
      this.text(value.academicYearId) === academicYearId
      && this.text(value.classId) === classId
      && this.month(value.reportMonth) === reportMonth
    );
    if (this.text(publishedConfiguration.id) !== configurationId
      || !sameScope(publishedConfiguration)
      || this.text(snapshot.configurationId) !== configurationId
      || !sameScope(snapshot)
      || this.positiveInteger(publishedConfiguration.version) !== snapshotVersion
      || this.text(publishedConfiguration.status) !== 'published') {
      throw new BadRequestException('The monthly report publish scopes do not match.');
    }
    if (previousPublishedSnapshot && (!sameScope(previousPublishedSnapshot)
      || this.text(previousPublishedSnapshot.id) === this.text(snapshot.id)
      || this.positiveInteger(previousPublishedSnapshot.version) === snapshotVersion)) {
      throw new BadRequestException('The previous monthly report snapshot is invalid.');
    }
    return {
      operation,
      snapshot,
      publishedConfiguration,
      previousPublishedSnapshot,
      configurationId,
      configurationVersion,
      academicYearId,
      classId,
      reportMonth,
      idempotencyKey,
      snapshotVersion,
    };
  }

  private async upsertMany(manager: EntityManager, values: SaveRubricReportDataDto[]) {
    const normalized = values.map((value) => this.normalize(value));
    const parameters: unknown[] = [];
    const rows = normalized.map((value) => {
      const offset = parameters.length;
      parameters.push(
        value.kind,
        value.scopeKey,
        value.classId,
        value.studentId,
        value.reportMonth,
        value.reportYear,
        JSON.stringify(value.payload),
        value.expiresAt,
      );
      return `(${Array.from({ length: 8 }, (_, index) => `$${offset + index + 1}`).join(', ')})`;
    });
    return manager.query(`
      INSERT INTO "rubric_report_data"
        ("kind", "scope_key", "class_id", "student_id", "report_month", "report_year", "payload", "expires_at")
      VALUES ${rows.join(', ')}
      ON CONFLICT ("kind", "scope_key") DO UPDATE SET
        "class_id" = EXCLUDED."class_id",
        "student_id" = EXCLUDED."student_id",
        "report_month" = EXCLUDED."report_month",
        "report_year" = EXCLUDED."report_year",
        "payload" = EXCLUDED."payload",
        "expires_at" = EXCLUDED."expires_at",
        "updated_at" = now()
      RETURNING "kind", "scope_key" AS "scopeKey", "payload"
    `, parameters);
  }

  async findAll(query: Partial<SaveRubricReportDataDto> = {}) {
    const where: Record<string, unknown> = {};
    for (const key of ['kind', 'scopeKey', 'classId', 'studentId', 'reportYear'] as const) {
      const value = this.text(query[key]);
      if (value) where[key] = value;
    }
    const reportMonth = this.month(query.reportMonth);
    if (reportMonth !== null) where.reportMonth = reportMonth;
    return this.repo.find({ where, order: { updatedAt: 'DESC' } });
  }

  async findById(id: string) {
    const record = await this.repo.findOne({
      where: [
        { id, expiresAt: IsNull() },
        { id, expiresAt: MoreThan(new Date()) },
      ],
    });
    if (!record) throw new NotFoundException('Rubric report data not found or expired.');
    return record;
  }

  async findConfigurationById(configurationId: string) {
    const id = this.text(configurationId);
    if (!id) throw new BadRequestException('configurationId is required.');
    const record = await this.repo.createQueryBuilder('record')
      .where('record.kind = :kind', { kind: 'monthly-report-configuration-v2' })
      .andWhere("record.payload ->> 'id' = :id", { id })
      .orderBy('record.updatedAt', 'DESC')
      .getOne();
    if (!record) throw new NotFoundException('Monthly report configuration not found.');
    return record;
  }

  async upsert(dto: SaveRubricReportDataDto) {
    const value = this.normalize(dto);
    const [record] = await this.repo.query(`
      INSERT INTO "rubric_report_data"
        ("kind", "scope_key", "class_id", "student_id", "report_month", "report_year", "payload", "expires_at")
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
      ON CONFLICT ("kind", "scope_key") DO UPDATE SET
        "class_id" = EXCLUDED."class_id",
        "student_id" = EXCLUDED."student_id",
        "report_month" = EXCLUDED."report_month",
        "report_year" = EXCLUDED."report_year",
        "payload" = EXCLUDED."payload",
        "expires_at" = EXCLUDED."expires_at",
        "updated_at" = now()
      RETURNING
        "id", "kind", "scope_key" AS "scopeKey", "class_id" AS "classId",
        "student_id" AS "studentId", "report_month" AS "reportMonth",
        "report_year" AS "reportYear", "payload", "expires_at" AS "expiresAt",
        "created_at" AS "createdAt", "updated_at" AS "updatedAt"
    `, [
      value.kind,
      value.scopeKey,
      value.classId,
      value.studentId,
      value.reportMonth,
      value.reportYear,
      JSON.stringify(value.payload),
      value.expiresAt,
    ]);
    return record;
  }

  async publishMonthlyReport(dto: AtomicMonthlyReportPublishDto) {
    const input = this.validatePublishOperation(dto);
    return this.repo.manager.transaction(async (manager) => {
      const configurationRecord = await manager.createQueryBuilder(RubricReportData, 'record')
        .setLock('pessimistic_write')
        .where('record.kind = :kind', { kind: CONFIGURATION_KIND })
        .andWhere("record.payload ->> 'id' = :id", { id: input.configurationId })
        .getOne();
      if (!configurationRecord) throw new NotFoundException('Monthly report configuration not found.');

      const storedOperationRecord = await manager.findOne(RubricReportData, {
        where: { kind: PUBLISH_OPERATION_KIND, scopeKey: input.idempotencyKey },
      });
      const storedOperation = this.object(storedOperationRecord?.payload);
      if (this.text(storedOperation.status) === 'completed') {
        return {
          data: {
            operation: storedOperation,
            configuration: this.object(storedOperation.publishedConfiguration),
            snapshot: this.object(storedOperation.snapshot),
          },
          meta: { idempotentReplay: true, attempts: Number(storedOperation.attempts) || 1 },
        };
      }

      const storedConfiguration = this.object(configurationRecord.payload);
      const storedVersion = this.positiveInteger(storedConfiguration.version);
      const storedIsMatchingPublishedVersion = this.text(storedConfiguration.status) === 'published'
        && storedVersion === input.snapshotVersion;
      if (this.text(storedConfiguration.id) !== input.configurationId
        || (storedVersion !== input.configurationVersion && !storedIsMatchingPublishedVersion)) {
        throw new ConflictException('The monthly report configuration changed before it could be published.');
      }

      const now = new Date().toISOString();
      const attempts = Math.max(Number(input.operation.attempts) || 0, Number(storedOperation.attempts) || 0) + 1;
      const snapshot: Record<string, unknown> = { ...input.snapshot, status: 'published' };
      const publishedConfiguration: Record<string, unknown> = { ...input.publishedConfiguration, status: 'published' };
      const completedOperation: Record<string, unknown> = {
        ...input.operation,
        snapshot,
        publishedConfiguration,
        status: 'completed',
        step: 'completed',
        attempts,
        updatedAt: now,
        completedAt: now,
        lastError: undefined,
      };
      const reportYear = this.text(snapshot.reportYear || publishedConfiguration.reportYear);
      const records: SaveRubricReportDataDto[] = [
        {
          kind: CONFIGURATION_KIND,
          scopeKey: `${input.academicYearId}:${input.classId}:${input.reportMonth}`,
          classId: input.classId,
          reportMonth: input.reportMonth,
          reportYear,
          payload: publishedConfiguration,
        },
        {
          kind: SNAPSHOT_KIND,
          scopeKey: `${input.academicYearId}:${input.classId}:${input.reportMonth}:${input.snapshotVersion}`,
          classId: input.classId,
          reportMonth: input.reportMonth,
          reportYear,
          payload: snapshot,
        },
      ];
      if (input.previousPublishedSnapshot) {
        const previousVersion = this.positiveInteger(input.previousPublishedSnapshot.version);
        if (!previousVersion) throw new BadRequestException('The previous monthly report snapshot version is invalid.');
        records.push({
          kind: SNAPSHOT_KIND,
          scopeKey: `${input.academicYearId}:${input.classId}:${input.reportMonth}:${previousVersion}`,
          classId: input.classId,
          reportMonth: input.reportMonth,
          reportYear: this.text(input.previousPublishedSnapshot.reportYear || reportYear),
          payload: { ...input.previousPublishedSnapshot, status: 'superseded' },
        });
      }
      records.push({
        kind: PUBLISH_OPERATION_KIND,
        scopeKey: input.idempotencyKey,
        classId: input.classId,
        reportMonth: input.reportMonth,
        reportYear,
        payload: completedOperation,
      });
      await this.upsertMany(manager, records);
      return {
        data: { operation: completedOperation, configuration: publishedConfiguration, snapshot },
        meta: { idempotentReplay: false, attempts },
      };
    });
  }

  async reviewMonthlyReport(input: {configurationId: string; configurationVersion: number}) {
    return this.repo.manager.transaction(manager => reviewMonthlyReport(manager, input));
  }

  async createTransient(dto: SaveRubricReportDataDto) {
    return this.repo.save(this.repo.create(this.normalize(dto, true)));
  }

  async remove(id: string) {
    await this.repo.delete({ id });
    return { deleted: true };
  }
}
