import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { EntityManager, In } from 'typeorm';
import { RubricReportData } from './rubric-report-data.entity';
import { Student } from '../students/student.entity';
import { Notification } from '../notifications/notification.entity';
import { Enrollment } from '../enrollments/enrollment.entity';

const object = (value: any): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const finite = (value: any) =>
  typeof value === 'number' && Number.isFinite(value);

export async function reviewMonthlyReport(
  manager: EntityManager,
  input: { configurationId: string; configurationVersion: number },
) {
  if (
    !input?.configurationId ||
    typeof input.configurationId !== 'string' ||
    input.configurationId.length > 255 ||
    !Number.isInteger(input.configurationVersion) ||
    input.configurationVersion < 1
  )
    throw new BadRequestException(
      'A report configuration and version are required',
    );
  const records = manager.getRepository(RubricReportData);
  const record = await records
    .createQueryBuilder('record')
    .setLock('pessimistic_write')
    .where('record.kind = :kind', { kind: 'monthly-report-configuration-v2' })
    .andWhere("record.payload ->> 'id' = :id", { id: input.configurationId })
    .getOne();
  if (!record)
    throw new NotFoundException('Monthly report configuration not found');
  const config = object(record.payload);
  if (config.version !== input.configurationVersion)
    throw new ConflictException(
      'Report configuration changed. Reload the scores.',
    );
  if (!['draft', 'ready', 'published'].includes(config.status))
    throw new BadRequestException('Invalid report status');
  const draftRecord = await records.findOne({
    where: {
      kind: 'monthly-report-score-draft-v2',
      scopeKey: `${input.configurationId}:${input.configurationVersion}`,
    },
    lock: { mode: 'pessimistic_write' },
  });
  const draft = object(draftRecord?.payload);
  if (
    draft.configurationId !== config.id ||
    draft.configurationVersion !== config.version ||
    draft.academicYearId !== config.academicYearId ||
    draft.classId !== config.classId ||
    draft.reportMonth !== config.reportMonth
  )
    throw new BadRequestException('Save this report’s scores before reviewing');
  if (
    !config.academicYearId ||
    !config.classId ||
    !Number.isInteger(config.reportMonth) ||
    config.reportMonth < 1 ||
    config.reportMonth > 12
  )
    throw new BadRequestException('The report scope is incomplete');
  const subjects = Array.isArray(config.subjects)
    ? config.subjects.filter((s) => s.enabled)
    : [];
  const rows = Array.isArray(draft.students) ? draft.students : [];
  if (
    !subjects.length ||
    !rows.length ||
    new Set(rows.map((r) => r.studentId)).size !== rows.length
  )
    throw new BadRequestException(
      'The report requires subjects and a unique student roster',
    );
  for (const row of rows) {
    if (
      typeof row.studentId !== 'string' ||
      !finite(row.totalScore) ||
      !finite(row.averageScore)
    )
      throw new BadRequestException('The report has incomplete scores');
    for (const subject of subjects) {
      const score = object(object(row.scores)[subject.slotKey]);
      if (
        !finite(subject.reportMaximum) ||
        subject.reportMaximum <= 0 ||
        !finite(score.value) ||
        score.value < 0 ||
        score.value > subject.reportMaximum
      )
        throw new BadRequestException(
          'The report has incomplete or invalid subject scores',
        );
    }
  }
  // Older configurations were saved without a branch. Recover only from
  // the saved roster's active enrollments in this exact class and year.
  let recoveredBranch = false;
  if (!config.branchId) {
    const enrollments = await manager.getRepository(Enrollment).find({
      where: {
        studentId: In(rows.map((row) => row.studentId)),
        classId: config.classId,
        academicYearId: config.academicYearId,
        is_active: true,
      },
    });
    const branches = new Set(enrollments.map((e) => e.branchId).filter(Boolean));
    const enrolled = new Set(enrollments.map((e) => e.studentId));
    if (branches.size !== 1 || rows.some((r) => !enrolled.has(r.studentId)))
      throw new BadRequestException('The report branch cannot be resolved from active enrollments');
    config.branchId = [...branches][0];
    recoveredBranch = true;
  }
  const calendarMonth = ((config.reportMonth + 7) % 12) + 1;
  const students = await manager
    .getRepository(Student)
    .find({
      where: {
        id: In(rows.map((row) => row.studentId)),
        is_active: true,
        enrollments: {
          classId: config.classId,
          academicYearId: config.academicYearId,
          branchId: config.branchId,
          is_active: true,
        },
      },
      relations: ['parents'],
    });
  if (students.length !== rows.length)
    throw new BadRequestException(
      'The report roster does not match active classroom enrollments',
    );
  const byId = new Map(students.map((student) => [student.id, student]));
  const notifications = manager.getRepository(Notification);
  const previous = await notifications.find({
    where: { module_id: record.id, module_type: 'MONTHLY_REPORT' },
  });
  const sent = new Set(
    previous.map(
      (n) => `${n.student_id}:${n.parent_id}:${n.metadata?.reviewRevision}`,
    ),
  );
  const pending: Notification[] = [];
  for (const row of rows) {
    const student = byId.get(row.studentId)!;
    const scores = subjects
      .map((subject) => ({
        slotKey: subject.slotKey,
        subjectName: subject.subjectName || '',
        score: row.scores[subject.slotKey].value,
        maxScore: subject.reportMaximum,
      }))
      .sort((a, b) => String(a.slotKey).localeCompare(String(b.slotKey)));
    const reviewRevision = createHash('sha256')
      .update(
        JSON.stringify({
          version: config.version,
          month: config.reportMonth,
          year: config.reportYear,
          scores,
          total: row.totalScore,
          average: row.averageScore,
          rank: row.rank,
        }),
      )
      .digest('hex');
    const studentName = [
      student.first_name_lao || student.first_name_eng,
      student.last_name_lao || student.last_name_eng,
    ]
      .filter(Boolean)
      .join(' ');
    const metadata = {
      type: 'monthly_report',
      configurationId: config.id,
      configurationVersion: config.version,
      reviewRevision,
      studentId: student.id,
      studentName,
      reportMonth: config.reportMonth,
      calendarMonth,
      reportYear: config.reportYear || '',
      totalScore: row.totalScore,
      averageScore: row.averageScore,
      rank: row.rank ?? null,
      scores,
      status: 'ready',
    };
    for (const parent of student.parents || []) {
      const key = `${student.id}:${parent.id}:${reviewRevision}`;
      if (parent.isActive === false || sent.has(key)) continue;
      sent.add(key);
      pending.push(
        notifications.create({
          parent_id: parent.id,
          student_id: student.id,
          branch_id: config.branchId,
          academic_year_id: config.academicYearId,
          module_id: record.id,
          module_type: 'MONTHLY_REPORT',
          title: 'ອັບເດດລາຍງານປະຈຳເດືອນ',
          description:
            `${studentName} · ${calendarMonth} · ${config.reportYear || ''}`.slice(
              0,
              255,
            ),
          message: `${studentName}\n${calendarMonth} · ${config.reportYear || ''}\n${row.totalScore}`,
          metadata,
          seen: 0,
          clicked: 0,
        }),
      );
    }
  }
  if (pending.length) await notifications.save(pending);
  if (config.status === 'draft' || recoveredBranch) {
    record.payload = {
      ...config,
      status: config.status === 'draft' ? 'ready' : config.status,
      updatedAt: new Date().toISOString(),
    };
    await records.save(record);
  }
  return { configuration: record.payload, notificationCount: pending.length };
}
