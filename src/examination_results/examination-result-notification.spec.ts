import { ExaminationResultService } from './examination-result.service';
import { ExaminationResult } from './examination-result.entity';
import { Examination } from '../examination/examination.entity';
import { Enrollment } from '../enrollments/enrollment.entity';
import { Notification } from '../notifications/notification.entity';
import { pushMessage } from '../notifications/web-push.service';

function fixture() {
  const exam: any = {
    id: 'exam',
    branchId: 'branch',
    academicYearId: 'year',
    classId: 'room',
    subjectId: 'subject',
    title: 'October mathematics exam',
    subject: { subjectType: { name: 'Mathematics' } },
    examDate: new Date('2026-10-11T08:00:00Z'),
    maxScore: 100,
    passScore: 50,
  };
  const enrollment = {
    findOne: jest.fn().mockImplementation(async ({ where }) => {
      if (where.id === 'wrong') return null;
      return {
        student: {
          id: where.studentId,
          first_name_lao: where.studentId,
          last_name_lao: 'Child',
          parents: [
            {
              id: where.studentId + '-parent',
              isActive: true,
              approvalStatus: 'approved',
            },
            {
              id: where.studentId + '-parent',
              isActive: true,
              approvalStatus: 'approved',
            },
            { id: 'inactive', isActive: false, approvalStatus: 'approved' },
            { id: 'deleted', isDeleted: true, approvalStatus: 'approved' },
            { id: 'pending', approvalStatus: 'pending' },
          ],
        },
      };
    }),
  };
  const committed: any[] = [];
  let failInbox = false;
  const notifications = {
    create: jest.fn((v) => v),
    save: jest.fn(async (rows) => {
      if (failInbox) throw new Error('Inbox unavailable');
      committed.push(...rows);
      return rows;
    }),
  };
  const transactionalResults = {
    save: jest.fn(async (rows) =>
      rows.map((row, i) => ({
        ...row,
        id: row.id || 'result-' + row.studentId,
        gradedAt: new Date('2026-10-11T09:00:00Z'),
      })),
    ),
  };
  const exams = { findOne: jest.fn(async () => exam) };
  const manager: any = {
    getRepository: jest.fn((t) =>
      t === Examination
        ? exams
        : t === Enrollment
          ? enrollment
          : t === Notification
            ? notifications
            : transactionalResults,
    ),
  };
  const results: any = {
    create: jest.fn((v) => v),
    findOne: jest.fn(async () => null),
    save: jest.fn(async (v) => v),
    manager: {
      transaction: jest.fn(async (cb) => {
        const count = committed.length;
        try {
          return await cb(manager);
        } catch (e) {
          committed.splice(count);
          throw e;
        }
      }),
    },
  };
  return {
    service: new ExaminationResultService(results, exams as any),
    exam,
    results,
    transactionalResults,
    notifications,
    enrollment,
    committed,
    failInbox: () => {
      failInbox = true;
    },
  };
}
const score = {
  examinationId: 'exam',
  studentId: 'child-a',
  enrollmentId: 'enrollment',
  gradedBy: 'teacher',
  score: 0,
};

describe('Examination score parent notifications', () => {
  it('bulk submit notifies only the approved linked parent of each scored child, preserving zero', async () => {
    const f = fixture();
    await f.service.bulkCreate({
      examinationId: 'exam',
      gradedBy: 'teacher',
      results: [
        { studentId: 'child-a', enrollmentId: 'enrollment-a', score: 0 },
        { studentId: 'child-b', enrollmentId: 'enrollment-b', score: 77.5 },
      ],
    });
    expect(f.committed).toHaveLength(2);
    expect(f.committed.map((n) => [n.student_id, n.parent_id])).toEqual([
      ['child-a', 'child-a-parent'],
      ['child-b', 'child-b-parent'],
    ]);
    expect(f.committed[0].metadata).toMatchObject({
      type: 'examination_score',
      score: 0,
      maxScore: 100,
      subjectName: 'Mathematics',
      examDate: '2026-10-11T08:00:00.000Z',
    });
    expect(f.enrollment.findOne.mock.calls[0][0].where).toMatchObject({
      studentId: 'child-a',
      classId: 'room',
      branchId: 'branch',
      academicYearId: 'year',
      is_active: true,
    });
    expect(f.results.manager.transaction).toHaveBeenCalledTimes(1);
  });
  it('single submit uses the same score and inbox transaction', async () => {
    const f = fixture();
    await f.service.create(score);
    expect(f.committed).toHaveLength(1);
    expect(f.results.save).not.toHaveBeenCalled();
  });
  it('rejects scores above the maximum without saving or notifying', async () => {
    const f = fixture();
    await expect(f.service.create({ ...score, score: 101 })).rejects.toThrow();
    expect(f.results.manager.transaction).not.toHaveBeenCalled();
    expect(f.committed).toHaveLength(0);
  });
  it('rejects a mismatched enrollment and rolls back all inbox entries in the batch', async () => {
    const f = fixture();
    await expect(
      f.service.bulkCreate({
        examinationId: 'exam',
        gradedBy: 'teacher',
        results: [
          { studentId: 'child-a', enrollmentId: 'enrollment', score: 75 },
          { studentId: 'child-b', enrollmentId: 'wrong', score: 70 },
        ],
      }),
    ).rejects.toThrow('enrollment');
    expect(f.committed).toHaveLength(0);
  });
  it('propagates inbox failure through the write transaction', async () => {
    const f = fixture();
    f.failInbox();
    await expect(f.service.create(score)).rejects.toThrow('Inbox unavailable');
    expect(f.results.save).not.toHaveBeenCalled();
    expect(f.committed).toHaveLength(0);
  });
  it('notifies corrections, but unchanged score or remark-only saves do not alert again', async () => {
    const f = fixture();
    f.results.findOne.mockResolvedValue({ ...score, id: 'result', score: 50 });
    await f.service.update('result', { score: 77 });
    expect(f.committed).toHaveLength(1);
    await f.service.update('result', {
      score: 77,
      remark: 'Corrected spelling',
    });
    expect(f.committed).toHaveLength(1);
    expect(f.results.save).toHaveBeenCalledTimes(1);
  });
  it('push includes child, subject, score and exam date in both languages', async () => {
    const f = fixture();
    await f.service.create(score);
    for (const lang of ['en', 'lo']) {
      const message = pushMessage(f.committed[0], lang);
      expect(message.body).toContain('child-a');
      expect(message.body).toContain('Mathematics');
      expect(message.body).toContain('0 / 100');
      expect(message.body).toContain('2026-10-11');
    }
  });
});
