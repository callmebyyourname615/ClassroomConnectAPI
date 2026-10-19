import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Teaching } from '../teachings/teaching.entity';
import { Student } from '../students/student.entity';
import { Notification } from '../notifications/notification.entity';
import { TeacherHomework } from './teacher-homework.entity';

/** Called inside the homework write transaction, under its per-homework lock. */
export async function notifyHomework(
  manager: EntityManager,
  homework: TeacherHomework,
) {
  const teaching = await manager.getRepository(Teaching).findOne({
    where: { id: homework.teachingId },
    relations: ['subject', 'subject.subjectType', 'subject.class'],
  });
  if (!teaching) throw new BadRequestException('teachingId not found');
  const classId = homework.classId || teaching.subject?.class_id;
  if (!classId)
    throw new BadRequestException(
      'A homework classroom is required before sending',
    );
  if (teaching.subject?.class_id && classId !== teaching.subject.class_id)
    throw new BadRequestException(
      'Homework classroom must match the teaching subject',
    );
  const students = await manager.getRepository(Student).find({
    where: {
      is_active: true,
      enrollments: {
        classId,
        branchId: teaching.branchId,
        academicYearId: teaching.academicYearId,
        is_active: true,
      },
    },
    relations: ['parents'],
  });
  const notifications = manager.getRepository(Notification);
  const previous = await notifications.find({
    where: { module_id: homework.id, module_type: 'HOMEWORK' },
  });
  const sent = new Set(
    previous.map((row) => `${row.student_id}:${row.parent_id}`),
  );
  const pending: Notification[] = [];
  for (const student of students) {
    const studentName = [
      student.first_name_lao || student.first_name_eng,
      student.last_name_lao || student.last_name_eng,
    ]
      .filter(Boolean)
      .join(' ');
    const metadata = {
      type: 'homework',
      homeworkId: homework.id,
      studentId: student.id,
      studentName,
      subjectId: teaching.subjectId,
      subjectName: teaching.subject?.subjectType?.name || '',
      homeworkTitle: homework.title,
      instruction: homework.overallInstruction || '',
      dueDate: homework.dueDate
        ? new Date(homework.dueDate).toISOString()
        : null,
      classId,
      className: homework.class?.name || teaching.subject?.class?.name || '',
    };
    for (const parent of student.parents || []) {
      const key = `${student.id}:${parent.id}`;
      if (parent.isActive === false || sent.has(key)) continue;
      sent.add(key);
      pending.push(
        notifications.create({
          parent_id: parent.id,
          student_id: student.id,
          branch_id: teaching.branchId,
          academic_year_id: teaching.academicYearId,
          module_id: homework.id,
          module_type: 'HOMEWORK',
          title: 'ວຽກບ້ານໃໝ່',
          description:
            `${studentName} · ${metadata.subjectName} · ${homework.title}`.slice(
              0,
              255,
            ),
          message: [
            studentName,
            metadata.subjectName,
            homework.title,
            metadata.instruction,
            metadata.dueDate,
          ]
            .filter(Boolean)
            .join('\n'),
          metadata,
          seen: 0,
          clicked: 0,
        }),
      );
    }
  }
  if (pending.length) await notifications.save(pending);
}
