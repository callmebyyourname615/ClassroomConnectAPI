import { ParticipationScoreService } from './participation-score.service';
import { ParticipationScore } from './participation-score.entity';
import { ParticipationList } from '../participantion_list/participation_list.entity';
import { Student } from '../students/student.entity';
import { Notification } from '../notifications/notification.entity';
import { pushMessage } from '../notifications/web-push.service';
const dto: any = {
  branchId: 'branch',
  academicYearId: 'year',
  levelId: 'level',
  classId: 'class',
  date: '2026-10-11',
  scores: [{ studentId: 'child', participationId: 'criterion', score: 0 }],
};
function fixture(prior: any = null) {
  const record = {
    findOne: jest.fn().mockResolvedValue(prior),
    create: jest.fn((v) => v),
    save: jest.fn(async (v) => ({ ...v, id: 'record' })),
  };
  const definitions = {
    findBy: jest
      .fn()
      .mockResolvedValue([
        { id: 'criterion', name: 'Participation', score: '10' },
      ]),
  };
  const students = {
    find: jest.fn().mockResolvedValue([
      {
        id: 'child',
        first_name_lao: 'Child',
        parents: [
          { id: 'parent', isActive: true },
          { id: 'parent', isActive: true },
          { id: 'inactive', isActive: false },
        ],
      },
    ]),
  };
  const notifications = {
    create: jest.fn((v) => v),
    save: jest.fn().mockResolvedValue([]),
  };
  const manager: any = {
    query: jest.fn(),
    getRepository: (t: any) =>
      t === ParticipationScore
        ? record
        : t === ParticipationList
          ? definitions
          : t === Student
            ? students
            : t === Notification
              ? notifications
              : null,
  };
  const transaction = jest.fn((fn) => fn(manager));
  return {
    service: new ParticipationScoreService(
      { manager: { transaction } } as any,
      {} as any,
      {} as any,
    ),
    record,
    definitions,
    students,
    notifications,
    transaction,
    manager,
  };
}
describe('Daily assessment notifications', () => {
  it('aggregates zero-score assessments into one notification per active parent/student', async () => {
    const f = fixture();
    await f.service.bulkUpsert(dto);
    expect(f.notifications.save).toHaveBeenCalledTimes(1);
    const payload = f.notifications.save.mock.calls[0][0];
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      student_id: 'child',
      parent_id: 'parent',
      module_type: 'DAILY_EVALUATION',
      metadata: {
        type: 'daily_evaluation',
        score: 0,
        maxScore: 10,
        assessmentDate: '2026-10-11',
      },
    });
    expect(f.manager.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.any(Array),
    );
  });
  it('does not notify again for unchanged saved scores', async () => {
    const f = fixture({
      ...dto,
      id: 'record',
      scores: [
        {
          studentId: 'child',
          participationId: 'criterion',
          participationName: 'Participation',
          score: 0,
        },
      ],
    });
    await f.service.bulkUpsert(dto);
    expect(f.notifications.save).not.toHaveBeenCalled();
  });
  it('does not replay notifications for legacy nullable scope fields', async () => {
    const input = { ...dto, levelId: undefined };
    const f = fixture({
      ...input,
      levelId: null,
      id: 'record',
      scores: [{ studentId: 'child', participationId: 'criterion', score: 0 }],
    });
    await f.service.bulkUpsert(input);
    expect(f.notifications.save).not.toHaveBeenCalled();
  });
  it('notifies a correction and preserves the other criteria in bulk merge', async () => {
    const f = fixture({
      ...dto,
      id: 'record',
      scores: [{ studentId: 'child', participationId: 'criterion', score: 1 }],
    });
    await f.service.bulkUpsert(dto);
    expect(f.notifications.save).toHaveBeenCalledTimes(1);
  });
  it('uses the same notification transaction on create and update', async () => {
    const f = fixture();
    await f.service.create(dto);
    expect(f.notifications.save).toHaveBeenCalledTimes(1);
    const u = fixture({
      ...dto,
      id: 'record',
      scores: [{ studentId: 'child', participationId: 'criterion', score: 1 }],
    });
    await u.service.update('record', { scores: dto.scores });
    expect(u.notifications.save).toHaveBeenCalledTimes(1);
    expect(u.transaction).toHaveBeenCalledTimes(1);
  });
  it('propagates notification persistence failure to roll back the score transaction', async () => {
    const f = fixture();
    f.notifications.save.mockRejectedValue(new Error('noti failure'));
    await expect(f.service.bulkUpsert(dto)).rejects.toThrow('noti failure');
  });
  it('rejects negative or over-maximum scores before saving', async () => {
    for (const score of [-1, 11]) {
      const f = fixture();
      await expect(
        f.service.bulkUpsert({ ...dto, scores: [{ ...dto.scores[0], score }] }),
      ).rejects.toThrow();
      expect(f.record.save).not.toHaveBeenCalled();
    }
  });
  it('builds English/Lao Push banners for the daily total', () => {
    const row = {
      id: 'noti',
      student_id: 'child',
      metadata: {
        type: 'daily_evaluation',
        studentName: 'Child',
        assessmentDate: '2026-10-11',
        score: 0,
        maxScore: 10,
      },
    };
    expect(pushMessage(row, 'en').body).toContain('Total score: 0 / 10');
    expect(pushMessage(row, 'lo').title).toBe('ຜົນການປະເມີນປະຈຳວັນ');
  });
});
