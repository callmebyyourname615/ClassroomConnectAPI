import { notifyHomework } from './homework-notification';
import { TeacherHomeworkService } from './teacher-homework.service';
import { TeacherHomework } from './teacher-homework.entity';
import { Teaching } from '../teachings/teaching.entity';
import { Student } from '../students/student.entity';
import { Notification } from '../notifications/notification.entity';
import { pushMessage } from '../notifications/web-push.service';
const homework: any = {
  id: 'hw',
  teachingId: 'teaching',
  classId: 'class',
  title: 'Addition',
  overallInstruction: 'Complete page 2',
  dueDate: new Date('2026-10-12T00:00:00Z'),
  items: [{ score: 5 }],
  status: 'draft',
};
function fixture() {
  const notifications = {
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((v) => v),
    save: jest.fn().mockResolvedValue([]),
  };
  const teaching = {
    findOne: jest
      .fn()
      .mockResolvedValue({
        id: 'teaching',
        branchId: 'branch',
        academicYearId: 'year',
        subjectId: 'subject',
        branch: { id: 'branch' },
        subject: {
          class_id: 'class',
          class: { name: 'P1/1' },
          subjectType: { name: 'Mathematics' },
        },
      }),
  };
  const students = {
    find: jest.fn().mockResolvedValue([
      {
        id: 'child',
        first_name_eng: 'Child',
        parents: [
          { id: 'parent', isActive: true },
          { id: 'parent', isActive: true },
          { id: 'inactive', isActive: false },
        ],
      },
    ]),
  };
  const records = {
    findOne: jest.fn().mockImplementation(async () => ({ ...homework })),
    create: jest.fn((v) => v),
    save: jest.fn(async (v) => ({ ...v, id: 'hw' })),
  };
  const manager: any = {
    query: jest.fn(),
    getRepository: (t: any) =>
      t === Teaching
        ? teaching
        : t === Student
          ? students
          : t === Notification
            ? notifications
            : t === TeacherHomework
              ? records
              : null,
  };
  const service = new TeacherHomeworkService(
    { ...records, manager: { transaction: (fn) => fn(manager) } } as any,
    { create: (v) => v } as any,
    { findOne: async () => ({ id: 'session', subject: {} }) } as any,
    teaching as any,
    { findOne: async () => ({ id: 'class' }) } as any,
  );
  return { manager, notifications, teaching, students, records, service };
}
describe('Homework notifications', () => {
  it('uses active enrollment in the exact class, branch and year; deduplicates parents', async () => {
    const f = fixture();
    await notifyHomework(f.manager, homework);
    expect(f.students.find).toHaveBeenCalledWith({
      where: {
        is_active: true,
        enrollments: {
          classId: 'class',
          branchId: 'branch',
          academicYearId: 'year',
          is_active: true,
        },
      },
      relations: ['parents'],
    });
    expect(f.notifications.save.mock.calls[0][0]).toHaveLength(1);
    expect(f.notifications.save.mock.calls[0][0][0]).toMatchObject({
      parent_id: 'parent',
      student_id: 'child',
      module_type: 'HOMEWORK',
      metadata: {
        type: 'homework',
        subjectName: 'Mathematics',
        homeworkTitle: 'Addition',
      },
    });
  });
  it('does not resend to recipients already notified, including read notifications', async () => {
    const f = fixture();
    f.notifications.find.mockResolvedValue([
      { student_id: 'child', parent_id: 'parent', seen: 1 },
    ]);
    await notifyHomework(f.manager, homework);
    expect(f.notifications.save).not.toHaveBeenCalled();
  });
  it('resolves the subject classroom when the older homework has no class', async () => {
    const f = fixture();
    await notifyHomework(f.manager, { ...homework, classId: null });
    expect(f.students.find.mock.calls[0][0].where.enrollments.classId).toBe(
      'class',
    );
  });
  it('rejects missing or mismatched classrooms without broadcasting', async () => {
    const f = fixture();
    await expect(
      notifyHomework(f.manager, { ...homework, classId: 'other' }),
    ).rejects.toThrow('must match');
    f.teaching.findOne.mockResolvedValue({
      ...(await f.teaching.findOne()),
      subject: {},
    });
    await expect(
      notifyHomework(f.manager, { ...homework, classId: null }),
    ).rejects.toThrow('required');
    expect(f.students.find).not.toHaveBeenCalled();
  });
  it('saving a draft does not notify; changing status to sent does', async () => {
    const f = fixture();
    await f.service.update('hw', { title: 'New title' });
    expect(f.notifications.save).not.toHaveBeenCalled();
    await f.service.update('hw', { status: 'sent' } as any);
    expect(f.notifications.save).toHaveBeenCalledTimes(1);
    expect(f.manager.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      ['homework:hw'],
    );
  });
  it('publishing uses the transaction and propagates inbox failures', async () => {
    const f = fixture();
    f.notifications.save.mockRejectedValue(new Error('inbox unavailable'));
    await expect(f.service.publish('hw')).rejects.toThrow('inbox unavailable');
  });
  it('creation only notifies when sent', async () => {
    const f = fixture();
    await f.service.create({
      teachingId: 'teaching',
      teachLearningId: 'session',
      title: 'Addition',
      items: [{ title: 'Q1', score: 5 }],
    } as any);
    expect(f.notifications.save).not.toHaveBeenCalled();
    await f.service.create({
      teachingId: 'teaching',
      teachLearningId: 'session',
      title: 'Addition',
      status: 'sent',
      items: [{ title: 'Q1', score: 5 }],
    } as any);
    expect(f.notifications.save).toHaveBeenCalledTimes(1);
  });
  it('localizes concise Push for English and Lao without embedding instructions', () => {
    const row = {
      metadata: {
        type: 'homework',
        studentName: 'Child',
        subjectName: 'Math',
        homeworkTitle: 'Addition',
        instruction: 'Private details',
      },
    };
    expect(pushMessage(row, 'en')).toMatchObject({
      title: 'New homework',
      body: 'Child · Math · Addition',
    });
    expect(pushMessage(row, 'lo').title).toBe('ວຽກບ້ານໃໝ່');
  });
});
