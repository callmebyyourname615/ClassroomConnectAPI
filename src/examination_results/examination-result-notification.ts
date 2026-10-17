import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Examination } from '../examination/examination.entity';
import { Enrollment } from '../enrollments/enrollment.entity';
import { Notification } from '../notifications/notification.entity';
import { ExaminationResult } from './examination-result.entity';

/** Save the owned parent inbox entries in the same transaction as the scores. */
export async function notifyExaminationResults(
  manager: EntityManager,
  results: ExaminationResult[],
) {
  const exams = new Map<string, Examination>();
  const pending: Notification[] = [];
  const recipients = new Set<string>();
  const notifications = manager.getRepository(Notification);
  for (const result of results) {
    let exam = exams.get(result.examinationId);
    if (!exam) {
      exam =
        (await manager.getRepository(Examination).findOne({
          where: { id: result.examinationId, isDeleted: false },
          relations: ['subject', 'subject.subjectType'],
        })) ?? undefined;
      if (!exam) throw new BadRequestException('Examination not found');
      exams.set(exam.id, exam);
    }
    const enrollment = await manager.getRepository(Enrollment).findOne({
      where: {
        id: result.enrollmentId,
        studentId: result.studentId,
        classId: exam.classId,
        branchId: exam.branchId,
        academicYearId: exam.academicYearId,
        is_active: true,
      },
      relations: ['student', 'student.parents'],
    });
    if (!enrollment?.student) {
      throw new BadRequestException(
        'The score enrollment must belong to this student and examination classroom',
      );
    }
    const student = enrollment.student;
    const studentName = [
      student.first_name_lao || student.first_name_eng,
      student.last_name_lao || student.last_name_eng,
    ]
      .filter(Boolean)
      .join(' ');
    const metadata = {
      type: 'examination_score',
      examinationId: exam.id,
      resultId: result.id,
      studentId: student.id,
      studentName,
      subjectId: exam.subjectId,
      subjectName: exam.subject?.subjectType?.name || '',
      examinationTitle: exam.title,
      examDate: new Date(exam.examDate).toISOString(),
      gradedAt: new Date(result.gradedAt).toISOString(),
      score: Number(result.score),
      maxScore: Number(exam.maxScore),
      classId: exam.classId,
      academicYearId: exam.academicYearId,
    };
    for (const parent of student.parents || []) {
      const key = `${result.id}:${parent.id}`;
      if (
        parent.isActive === false ||
        parent.isDeleted === true ||
        parent.approvalStatus !== 'approved' ||
        recipients.has(key)
      )
        continue;
      recipients.add(key);
      pending.push(
        notifications.create({
          parent_id: parent.id,
          student_id: student.id,
          branch_id: exam.branchId,
          academic_year_id: exam.academicYearId,
          module_id: result.id,
          module_type: 'EXAMINATION_SCORE',
          title: 'ຜົນຄະແນນສອບເສັງ',
          description:
            `${studentName} · ${metadata.subjectName} · ${metadata.score} / ${metadata.maxScore}`.slice(
              0,
              255,
            ),
          message: [
            studentName,
            metadata.subjectName,
            exam.title,
            `${metadata.score} / ${metadata.maxScore}`,
            metadata.examDate,
          ].join('\n'),
          metadata,
          seen: 0,
          clicked: 0,
        }),
      );
    }
  }
  if (pending.length) await notifications.save(pending);
}
