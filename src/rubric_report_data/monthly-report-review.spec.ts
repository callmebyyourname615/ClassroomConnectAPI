import { reviewMonthlyReport } from './monthly-report-review';
import { RubricReportData } from './rubric-report-data.entity';
import { Student } from '../students/student.entity';
import { Notification } from '../notifications/notification.entity';
import { Enrollment } from '../enrollments/enrollment.entity';
import { RubricReportDataController } from './rubric-report-data.controller';
import { pushMessage } from '../notifications/web-push.service';
function fixture() {
  const config: any = {
    id: 'configuration',
    branchId: 'branch',
    academicYearId: 'year',
    classId: 'class',
    reportMonth: 10,
    reportYear: '2026-2027',
    version: 1,
    status: 'draft',
    subjects: [
      {
        enabled: true,
        slotKey: 'math',
        subjectName: 'Mathematics',
        reportMaximum: 10,
      },
    ],
  };
  const draft: any = {
    configurationId: config.id,
    configurationVersion: 1,
    academicYearId: 'year',
    classId: 'class',
    reportMonth: 10,
    students: [
      {
        studentId: 'child',
        totalScore: 0,
        averageScore: 0,
        rank: 1,
        scores: { math: { value: 0 } },
      },
    ],
  };
  const record: any = { id: 'db-id', payload: config };
  const builder: any = {
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn(async () => record),
  };
  const records: any = {
    createQueryBuilder: () => builder,
    findOne: jest.fn(async () => ({ payload: draft })),
    save: jest.fn(async (v) => v),
  };
  const previous: any[] = [];
  const notifications: any = {
    find: jest.fn(async () => previous),
    create: (v) => v,
    save: jest.fn(async (v) => {
      previous.push(...v);
      return v;
    }),
  };
  const students: any = {
    find: jest.fn(async () => [
      {
        id: 'child',
        first_name_eng: 'Real Child',
        parents: [
          { id: 'parent', isActive: true },
          { id: 'parent', isActive: true },
          { id: 'inactive', isActive: false },
        ],
      },
    ]),
  };
  const enrollments: any = {
    find: jest.fn(async () => [{ studentId: 'child', branchId: 'branch' }]),
  };
  const manager: any = {
    getRepository: (t) =>
      t === RubricReportData
        ? records
        : t === Student
          ? students
          : t === Notification
            ? notifications
            : t === Enrollment
              ? enrollments
            : null,
  };
  return {
    manager,
    config,
    draft,
    record,
    records,
    notifications,
    students,
    enrollments,
    builder,
    input: { configurationId: config.id, configurationVersion: 1 },
  };
}
describe('Review report notifications', () => {
  it('recovers an omitted branch from the actual roster and persists it on an already-ready report', async () => {
    const f = fixture();
    f.config.branchId = '';
    f.config.status = 'ready';
    f.config.reportMonth = f.draft.reportMonth = 1;
    const result = await reviewMonthlyReport(f.manager, f.input);
    expect(result.configuration.branchId).toBe('branch');
    expect(f.records.save).toHaveBeenCalled();
    expect(f.notifications.save.mock.calls[0][0][0].metadata).toMatchObject({ reportMonth: 1, calendarMonth: 9 });
    expect(f.students.find.mock.calls[0][0].where.enrollments.branchId).toBe('branch');
  });
  it('rejects ambiguous branches or incomplete enrollment coverage without notifying', async () => {
    const f = fixture();
    f.config.branchId = '';
    f.enrollments.find.mockResolvedValue([{ studentId: 'child', branchId: 'branch' }, { studentId: 'child', branchId: 'other' }]);
    await expect(reviewMonthlyReport(f.manager, f.input)).rejects.toThrow('cannot be resolved');
    f.enrollments.find.mockResolvedValue([]);
    await expect(reviewMonthlyReport(f.manager, f.input)).rejects.toThrow('cannot be resolved');
    expect(f.notifications.save).not.toHaveBeenCalled();
  });
  it('reviews saved API data atomically and sends zero-score alerts to active enrolled children’s parents', async () => {
    const f = fixture();
    const result = await reviewMonthlyReport(f.manager, f.input);
    expect(result.notificationCount).toBe(1);
    expect(result.configuration.status).toBe('ready');
    expect(f.students.find.mock.calls[0][0].where.enrollments).toEqual({
      classId: 'class',
      branchId: 'branch',
      academicYearId: 'year',
      is_active: true,
    });
    expect(f.notifications.save.mock.calls[0][0][0]).toMatchObject({
      student_id: 'child',
      parent_id: 'parent',
      metadata: {
        type: 'monthly_report',
        studentName: 'Real Child',
        totalScore: 0,
        reportMonth: 10,
      },
    });
    expect(f.builder.setLock).toHaveBeenCalledWith('pessimistic_write');
  });
  it('repeated review and autosave timestamp changes do not duplicate alerts', async () => {
    const f = fixture();
    await reviewMonthlyReport(f.manager, f.input);
    f.draft.updatedAt = 'changed';
    const replay = await reviewMonthlyReport(f.manager, f.input);
    expect(replay.notificationCount).toBe(0);
    expect(f.notifications.save).toHaveBeenCalledTimes(1);
  });
  it('meaningful score changes notify once again when explicitly reviewed', async () => {
    const f = fixture();
    await reviewMonthlyReport(f.manager, f.input);
    f.draft.students[0].scores.math.value = 5;
    f.draft.students[0].totalScore = 5;
    f.draft.students[0].averageScore = 5;
    expect(
      (await reviewMonthlyReport(f.manager, f.input)).notificationCount,
    ).toBe(1);
  });
  it('rejects stale configuration versions and mismatched score scopes', async () => {
    const f = fixture();
    await expect(
      reviewMonthlyReport(f.manager, { ...f.input, configurationVersion: 2 }),
    ).rejects.toThrow('changed');
    f.draft.classId = 'other';
    await expect(reviewMonthlyReport(f.manager, f.input)).rejects.toThrow(
      'Save this report',
    );
    expect(f.notifications.save).not.toHaveBeenCalled();
  });
  it('rejects incomplete scores and non-enrolled children without alerts', async () => {
    const f = fixture();
    f.draft.students[0].scores.math.value = null;
    await expect(reviewMonthlyReport(f.manager, f.input)).rejects.toThrow(
      'invalid',
    );
    f.draft.students[0].scores.math.value = 0;
    f.students.find.mockResolvedValue([]);
    await expect(reviewMonthlyReport(f.manager, f.input)).rejects.toThrow(
      'enrollments',
    );
    expect(f.notifications.save).not.toHaveBeenCalled();
  });
  it('propagates inbox failure before marking the report ready', async () => {
    const f = fixture();
    f.notifications.save.mockRejectedValue(new Error('database unavailable'));
    await expect(reviewMonthlyReport(f.manager, f.input)).rejects.toThrow(
      'database unavailable',
    );
    expect(f.records.save).not.toHaveBeenCalled();
  });
  it('rejects parent-triggered review', () => {
    const controller = new RubricReportDataController({
      reviewMonthlyReport: jest.fn(),
    } as any);
    expect(
      controller.reviewMonthlyReport(
        { user: { sub: 'parent', user_type: 'parent' } },
        { configurationId: 'id', configurationVersion: 1 },
      ),
    ).rejects.toThrow('Staff account required');
  });
  it('uses real report period in localized Push without claiming publication', () => {
    const row = {
      metadata: {
        type: 'monthly_report',
        studentName: 'Child',
        reportMonth: 10,
        reportYear: '2026-2027',
      },
    };
    expect(pushMessage(row, 'en')).toMatchObject({
      title: 'Monthly report updated',
      body: 'Child · 10 · 2026-2027',
    });
    expect(pushMessage(row, 'lo').title).toBe('ອັບເດດລາຍງານປະຈຳເດືອນ');
  });
});
