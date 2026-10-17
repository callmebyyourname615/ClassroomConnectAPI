import { notifyTask, taskReminderOccurrences } from './task-notification';
import { TaskNotificationService } from './task-notification.service';
import { TaskService } from './task.service';
import { Admin } from '../admins/admin.entity';
import { Parent } from '../parents/parent.entity';
import { Student } from '../students/student.entity';
import { Enrollment } from '../enrollments/enrollment.entity';
import { Notification } from '../notifications/notification.entity';
import { TaskSubmissionSlot } from '../task-submission/task-submission-slot.entity';
import { pushMessage } from '../notifications/web-push.service';

const local = (value: string) => new Date(`${value}+07:00`);
function fixture() {
  const task: any = {
    id: 'task',
    name: 'Reading',
    description: '<p>Read a story</p>',
    subject: 'English',
    status: 'assigned',
    added_by_id: 'teacher',
    added_by_type: 'admin',
    assignment_student_ids: ['student'],
    deadline: local('2026-10-14T17:00:00'),
    due_time: '17:00',
    created_at: local('2026-10-10T08:00:00'),
    settings: {
      submission_schedule: { count: 2, dates: ['2026-10-14', '2026-10-16'] },
    },
    reminders: {
      day_before: true,
      day_before_days: 3,
      day_before_time: '09:00',
      due_day: true,
      due_day_time: '09:00',
      overdue: true,
      overdue_time: '09:00',
    },
  };
  const parent: any = {
    id: 'parent',
    branchId: 'branch',
    isActive: true,
    isDeleted: false,
    approvalStatus: 'approved',
  };
  const student: any = {
    id: 'student',
    branchId: 'branch',
    first_name_eng: 'Child',
    is_active: true,
    parents: [parent, parent],
  };
  const records: any[] = [];
  const inbox = {
    find: jest.fn(async () => records),
    create: jest.fn((x) => x),
    save: jest.fn(async (rows) => {
      records.push(...rows);
      return rows;
    }),
  };
  const enrollments = { find: jest.fn(async () => [{ studentId: 'student' }]) };
  const students = { find: jest.fn(async () => [student]) };
  const slots = { find: jest.fn(async () => [] as any[]) };
  const author = {
    findOne: jest.fn(async () => ({ branch: { id: 'branch' } })),
  };
  const files = { create: jest.fn((x) => x), save: jest.fn() };
  const manager: any = {
    getRepository: (type) =>
      type === Notification
        ? inbox
        : type === Student
          ? students
          : type === Enrollment
            ? enrollments
            : type === TaskSubmissionSlot
              ? slots
              : type === Admin || type === Parent
                ? author
                : files,
    findOne: jest.fn(async () => ({ ...task })),
    save: jest.fn(async (_, value) => ({ ...task, ...value })),
  };
  const transaction = jest.fn(async (fn) => fn(manager));
  const taskRepo: any = {
    manager: { transaction },
    create: (x) => ({ ...task, ...x }),
    findOne: async () => task,
  };
  const service = new TaskService(
    taskRepo,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { del: jest.fn(), delPattern: jest.fn() } as any,
  );
  return {
    task,
    parent,
    student,
    records,
    inbox,
    enrollments,
    students,
    slots,
    author,
    manager,
    transaction,
    service,
  };
}

test('before reminders are daily for the selected number of days, in Lao time', () => {
  const { task } = fixture();
  expect(
    taskReminderOccurrences(task, local('2026-10-11T08:59:59')),
  ).toHaveLength(0);
  expect(
    taskReminderOccurrences(task, local('2026-10-11T09:00:00')).map((x) => [
      x.event,
      x.round,
    ]),
  ).toEqual([['day_before', 1]]);
  expect(
    taskReminderOccurrences(task, local('2026-10-12T09:00:00')).map(
      (x) => x.event,
    ),
  ).toEqual(['day_before']);
  expect(
    taskReminderOccurrences(task, local('2026-10-13T09:00:00')).map(
      (x) => x.round,
    ),
  ).toEqual([1, 2]);
});
test('saved per-round reminder days and times override the global default', () => {
  const { task } = fixture();
  task.reminders.day_before_schedule = [
    {
      round: 1,
      due_date: '2026-10-14',
      offset_days: -1,
      date: '2026-10-13',
      time: '14:30',
      datetime: '2026-10-13T14:30:00',
    },
    {
      round: 2,
      due_date: '2026-10-16',
      offset_days: -3,
      date: '2026-10-13',
      time: '08:00',
      datetime: '2026-10-13T08:00:00',
    },
  ];
  expect(
    taskReminderOccurrences(task, local('2026-10-13T09:00:00')).map(
      (x) => x.round,
    ),
  ).toEqual([2]);
  expect(
    taskReminderOccurrences(task, local('2026-10-13T14:30:00')).map(
      (x) => x.round,
    ),
  ).toEqual([1, 2]);
});
test('due-day respects each round time and overdue waits until after the actual deadline', () => {
  const { task } = fixture();
  task.reminders.day_before = false;
  task.reminders.due_day_schedule = [
    { round: 1, due_date: '2026-10-14', time: '16:00' },
  ];
  expect(
    taskReminderOccurrences(task, local('2026-10-14T15:59:59')),
  ).toHaveLength(0);
  expect(
    taskReminderOccurrences(task, local('2026-10-14T18:00:00')).map(
      (x) => x.event,
    ),
  ).toEqual(['due_day']);
  expect(
    taskReminderOccurrences(task, local('2026-10-15T09:00:00')).map((x) => [
      x.event,
      x.round,
    ]),
  ).toEqual([['overdue', 1]]);
});
test('disabled toggles, completed tasks, drafts and future start dates do not remind', () => {
  for (const patch of [
    { reminders: {} },
    { status: 'draft' },
    { status: 'completed' },
    { start_date: local('2026-10-15T00:00:00') },
  ]) {
    const { task } = fixture();
    Object.assign(task, patch);
    expect(
      taskReminderOccurrences(task, local('2026-10-14T10:00:00')),
    ).toHaveLength(0);
  }
});
test('restart catches up today only, without sending historical reminder dates', () => {
  const { task } = fixture();
  task.reminders.overdue = false;
  const events = taskReminderOccurrences(task, local('2026-10-14T23:00:00'));
  expect(
    events.every((x) => x.scheduledAt.toISOString().startsWith('2026-10-14')),
  ).toBe(true);
  expect(events.map((x) => [x.event, x.round])).toEqual([
    ['due_day', 1],
    ['day_before', 2],
  ]);
});
test('publication is immediate with all reminder toggles off, and retries do not resend', async () => {
  const f = fixture();
  f.task.reminders = {};
  await notifyTask(f.manager, f.task, local('2026-10-11T09:00:00'), true);
  await notifyTask(f.manager, f.task, local('2026-10-11T09:00:00'), true);
  expect(f.records).toHaveLength(1);
  expect(f.records[0]).toMatchObject({
    parent_id: 'parent',
    student_id: 'student',
    metadata: { type: 'task', event: 'assigned', description: 'Read a story' },
  });
});
test('reminder retries including previously read notices are deduplicated', async () => {
  const f = fixture();
  const now = local('2026-10-11T09:00:00');
  await notifyTask(f.manager, f.task, now);
  f.records[0].seen = 1;
  await notifyTask(f.manager, f.task, now);
  expect(f.records).toHaveLength(1);
});
test('overdue reminders repeat once per local day for each outstanding round', async () => {
  const f = fixture();
  f.task.reminders = { overdue: true, overdue_time: '09:00' };
  for (const day of ['2026-10-17', '2026-10-17', '2026-10-18'])
    await notifyTask(f.manager, f.task, local(`${day}T09:00:00`));
  expect(f.records).toHaveLength(4);
  expect(new Set(f.records.map((x) => x.metadata.deliveryKey)).size).toBe(4);
});
test.each(['submitted', 'late', 'reviewed'])(
  'submitted round (%s) stops reminders without blocking other rounds',
  async (status) => {
    const f = fixture();
    f.slots.find.mockResolvedValue([
      { student_id: 'student', schedule_index: 1, status },
    ]);
    await notifyTask(f.manager, f.task, local('2026-10-13T09:00:00'));
    expect(f.records.map((x) => x.metadata.round)).toEqual([2]);
  },
);
test('a pending slot carrying a submission timestamp is not reminded', async () => {
  const f = fixture();
  f.slots.find.mockResolvedValue([
    {
      student_id: 'student',
      schedule_index: 1,
      status: 'pending',
      submitted_at: new Date(),
    },
  ]);
  await notifyTask(f.manager, f.task, local('2026-10-11T09:00:00'));
  expect(f.records).toHaveLength(0);
});
test.each([
  { isActive: false },
  { isDeleted: true },
  { approvalStatus: 'pending' },
  { branchId: 'other' },
])(
  'unapproved/inactive or different-branch parents are excluded: %j',
  async (patch) => {
    const f = fixture();
    Object.assign(f.parent, patch);
    await notifyTask(f.manager, f.task, local('2026-10-11T09:00:00'), true);
    expect(f.records).toHaveLength(0);
  },
);
test('class and multiple class assignments resolve active enrollments within branch and academic year', async () => {
  const f = fixture();
  f.task.assignment_class_ids = ['class-1', 'class-2'];
  f.task.academic_year_id = 'year';
  await notifyTask(f.manager, f.task, local('2026-10-11T09:00:00'), true);
  expect(f.enrollments.find.mock.calls[0][0].where).toMatchObject({
    branchId: 'branch',
    academicYearId: 'year',
    is_active: true,
  });
  expect(f.students.find.mock.calls[0][0].where).toMatchObject({
    branchId: 'branch',
    is_active: true,
  });
  expect(f.records.filter((x) => x.metadata.event === 'assigned')).toHaveLength(
    1,
  );
});
test('creation commits assignment and inbox in one transaction and fails on notification failure', async () => {
  const f = fixture();
  f.task.reminders = {};
  const dto: any = { ...f.task, deadline: f.task.deadline.toISOString() };
  await f.service.create(dto);
  expect(f.transaction).toHaveBeenCalledTimes(1);
  expect(f.records[0].metadata.event).toBe('assigned');
  f.inbox.find.mockResolvedValue([]);
  f.inbox.save.mockRejectedValue(new Error('Inbox failed'));
  await expect(f.service.create(dto)).rejects.toThrow('Inbox failed');
});
test('scheduler locks a task, dispatches due reminders, and retries do not duplicate', async () => {
  const f = fixture();
  const db: any = {
    getRepository: () => ({ find: async () => [{ id: 'task' }] }),
    transaction: f.transaction,
  };
  const scheduler = new TaskNotificationService(db);
  await scheduler.dispatch(local('2026-10-11T09:00:00'));
  await scheduler.dispatch(local('2026-10-11T09:00:00'));
  expect(f.manager.findOne.mock.calls[0][1].lock).toEqual({
    mode: 'pessimistic_write',
  });
  expect(f.records).toHaveLength(1);
});
test('task push uses configured event, student, round and local due time', () => {
  expect(
    pushMessage(
      {
        metadata: {
          type: 'task',
          event: 'overdue',
          studentName: 'Child',
          taskTitle: 'Reading',
          round: 2,
          dueDate: '2026-10-14',
          dueTime: '17:00',
        },
      },
      'en',
    ),
  ).toMatchObject({
    title: 'Task overdue',
    body: 'Child\nReading\nRound 2\n2026-10-14 17:00',
  });
});
