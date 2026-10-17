import { BadRequestException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { Task } from './task.entity';
import { Admin } from '../admins/admin.entity';
import { Parent } from '../parents/parent.entity';
import { Student } from '../students/student.entity';
import { Enrollment } from '../enrollments/enrollment.entity';
import { Notification } from '../notifications/notification.entity';
import { TaskSubmissionSlot } from '../task-submission/task-submission-slot.entity';

export type TaskNotificationEvent =
  | 'assigned'
  | 'day_before'
  | 'due_day'
  | 'overdue';
export const taskNotificationTitles = {
  assigned: { en: 'New task assigned', lo: 'ວຽກໃໝ່ທີ່ມອບໝາຍ' },
  day_before: { en: 'Task due soon', lo: 'ວຽກໃກ້ຮອດກຳນົດສົ່ງ' },
  due_day: { en: 'Task due today', lo: 'ວຽກຮອດກຳນົດສົ່ງມື້ນີ້' },
  overdue: { en: 'Task overdue', lo: 'ວຽກເກີນກຳນົດສົ່ງ' },
};
const activeStatuses = ['assigned', 'in_progress', 'submitted', 'overdue'];
export const taskLocalDate = (date: Date) =>
  new Date(date.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
const atLocalTime = (date: string, time: string) =>
  new Date(`${date}T${time}:00+07:00`);
const shiftDate = (date: string, days: number) =>
  new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86400000)
    .toISOString()
    .slice(0, 10);
const clock = (value?: string) =>
  /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '') ? value! : '09:00';

export interface TaskReminderOccurrence {
  event: TaskNotificationEvent;
  round: number;
  dueDate: string;
  dueAt: Date;
  scheduledAt: Date;
  key: string;
}

/** Only today's due occurrences are caught up; restarting never floods parents
 * with reminders for dates that have already passed. Local portal dates are Lao time. */
export function taskReminderOccurrences(
  task: Task,
  now: Date,
): TaskReminderOccurrence[] {
  if (
    !activeStatuses.includes(task.status) ||
    (task.start_date && new Date(task.start_date) > now)
  )
    return [];
  const today = taskLocalDate(now);
  const dates = task.settings?.submission_schedule?.dates?.length
    ? task.settings.submission_schedule.dates.map((value) => value.slice(0, 10))
    : [taskLocalDate(new Date(task.deadline))];
  const reminders = task.reminders || {};
  const result: TaskReminderOccurrence[] = [];
  dates.forEach((dueDate, index) => {
    const round = index + 1;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return;
    const dueAt = atLocalTime(dueDate, task.due_time || '23:59');
    if (Number.isNaN(dueAt.getTime())) return;
    const add = (event: TaskNotificationEvent, date: string, time: string) => {
      const scheduledAt = atLocalTime(date, clock(time));
      if (
        date !== today ||
        scheduledAt > now ||
        scheduledAt < new Date(task.created_at)
      )
        return;
      result.push({
        event,
        round,
        dueDate,
        dueAt,
        scheduledAt,
        key: `${event}:${round}:${dueDate}:${date}:${clock(time)}`,
      });
    };
    if (reminders.day_before) {
      const saved = (reminders.day_before_schedule || []).filter(
        (item) =>
          item.round === round ||
          (!item.round && (!item.due_date || item.due_date === dueDate)),
      );
      if (saved.length) {
        for (const item of saved) {
          if (item.due_date && item.due_date !== dueDate) continue;
          // Recompute the day from the current submission plan, rather than
          // trusting a stale serialized datetime after editing the deadline.
          if (item.offset_days >= -7 && item.offset_days <= -1)
            add('day_before', shiftDate(dueDate, item.offset_days), item.time);
        }
      } else {
        const days = Math.min(7, Math.max(1, reminders.day_before_days || 1));
        for (let offset = -days; offset < 0; offset++)
          add(
            'day_before',
            shiftDate(dueDate, offset),
            reminders.day_before_time || '09:00',
          );
      }
    }
    if (reminders.due_day) {
      const saved = reminders.due_day_schedule?.find(
        (item) => item.round === round && item.due_date === dueDate,
      );
      add('due_day', dueDate, saved?.time || reminders.due_day_time || '09:00');
    }
    if (reminders.overdue && dueAt < now && today >= dueDate) {
      const scheduled = atLocalTime(today, clock(reminders.overdue_time));
      if (scheduled > dueAt)
        add('overdue', today, reminders.overdue_time || '09:00');
    }
  });
  return result;
}

/** Caller holds the task row lock. Notification keys survive read/deleted state
 * so repeated saves and scheduler retries do not resend the same occurrence. */
export async function notifyTask(
  manager: EntityManager,
  task: Task,
  now = new Date(),
  publication = false,
) {
  if (!activeStatuses.includes(task.status)) return;
  const occurrences = taskReminderOccurrences(task, now);
  if (!publication && !occurrences.length) return;
  if (!task.added_by_id)
    throw new BadRequestException('Task author is required for notifications');
  const author =
    task.added_by_type?.toLowerCase() === 'parent'
      ? await manager
          .getRepository(Parent)
          .findOne({ where: { id: task.added_by_id }, relations: ['branch'] })
      : await manager
          .getRepository(Admin)
          .findOne({ where: { id: task.added_by_id }, relations: ['branch'] });
  const branchId = author?.branch?.id || (author as Parent)?.branchId;
  if (!branchId)
    throw new BadRequestException(
      'Task author branch is required for notifications',
    );
  const ids = new Set([
    ...(task.assignment_student_ids || []),
    ...(task.student?.id ? [task.student.id] : []),
  ]);
  const classIds = [
    ...new Set([
      ...(task.assignment_class_ids || []),
      ...(task.class_id ? [task.class_id] : []),
    ]),
  ];
  if (classIds.length) {
    const enrollments = await manager.getRepository(Enrollment).find({
      where: {
        classId: In(classIds),
        branchId,
        is_active: true,
        ...(task.academic_year_id
          ? { academicYearId: task.academic_year_id }
          : {}),
      },
    });
    for (const enrollment of enrollments) ids.add(enrollment.studentId);
  }
  if (!ids.size) return;
  const students = await manager.getRepository(Student).find({
    where: { id: In([...ids]), branchId, is_active: true },
    relations: ['parents'],
  });
  const inbox = manager.getRepository(Notification);
  const previous = await inbox.find({
    where: { module_id: task.id, module_type: 'TASK' },
  });
  const sent = new Set(
    previous
      .filter((row) => row.metadata?.type === 'task')
      .map((row) => String(row.metadata?.deliveryKey)),
  );
  const slots = await manager
    .getRepository(TaskSubmissionSlot)
    .find({ where: { task_id: task.id } });
  if (publication)
    occurrences.unshift({
      event: 'assigned',
      round: 0,
      dueDate: taskLocalDate(new Date(task.deadline)),
      dueAt: new Date(task.deadline),
      scheduledAt: now,
      key: 'assigned',
    });
  const pending: Notification[] = [];
  for (const student of students) {
    const studentName = [
      student.first_name_lao || student.first_name_eng,
      student.last_name_lao || student.last_name_eng,
    ]
      .filter(Boolean)
      .join(' ');
    for (const occurrence of occurrences) {
      const slot = slots.find(
        (slot) =>
          slot.student_id === student.id &&
          slot.schedule_index === occurrence.round,
      );
      if (
        occurrence.event !== 'assigned' &&
        (slot?.submitted_at ||
          ['submitted', 'late', 'reviewed'].includes(slot?.status || ''))
      )
        continue;
      for (const parent of student.parents || []) {
        if (
          !parent.isActive ||
          parent.isDeleted ||
          parent.approvalStatus !== 'approved' ||
          (parent.branchId && parent.branchId !== branchId)
        )
          continue;
        const deliveryKey = `${student.id}:${parent.id}:${occurrence.key}`;
        if (sent.has(deliveryKey)) continue;
        sent.add(deliveryKey);
        const description = String(task.description || '')
          .replace(/<[^>]*>/g, ' ')
          .replace(/&nbsp;/gi, ' ')
          .trim();
        pending.push(
          inbox.create({
            parent_id: parent.id,
            student_id: student.id,
            branch_id: branchId,
            academic_year_id: task.academic_year_id,
            module_id: task.id,
            module_type: 'TASK',
            title: taskNotificationTitles[occurrence.event].lo,
            description: `${studentName} · ${task.name}`.slice(0, 255),
            message: [
              studentName,
              task.name,
              task.subject,
              description,
              occurrence.dueAt.toISOString(),
            ]
              .filter(Boolean)
              .join('\n'),
            metadata: {
              type: 'task',
              event: occurrence.event,
              taskId: task.id,
              taskTitle: task.name,
              subjectName: task.subject || '',
              description,
              studentId: student.id,
              studentName,
              round: occurrence.round || null,
              dueDate: occurrence.dueDate,
              dueAt: occurrence.dueAt.toISOString(),
              dueTime: task.due_time || '23:59',
              scheduledAt: occurrence.scheduledAt.toISOString(),
              deliveryKey,
            },
            seen: 0,
            clicked: 0,
          }),
        );
      }
    }
  }
  if (pending.length) await inbox.save(pending);
}
