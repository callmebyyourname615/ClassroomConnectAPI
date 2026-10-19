import type { Evaluation } from './evaluation.entity';
import type { SubjectEvaluation } from '../subject_evaluations/subject-evaluation.entity';
import type { Student } from '../students/student.entity';

export function evaluationNotification(
  evaluation: Evaluation,
  definition: SubjectEvaluation,
  student: Student,
) {
  const content = definition.contents?.[evaluation.contentIndex];
  const studentName = [
    student.first_name_lao || student.first_name_eng,
    student.last_name_lao || student.last_name_eng,
  ]
    .filter(Boolean)
    .join(' ');
  const subjectName = definition.lesson?.subjectType?.name || '';
  const exercises = content?.e_title || [];
  const metadata = {
    type: 'evaluation_score',
    evaluationId: evaluation.id,
    studentId: student.id,
    studentName,
    subjectId: evaluation.subject?.id || null,
    subjectName,
    lessonId: definition.lessonId,
    lessonTitle: definition.topic,
    assessmentTitle: content?.t_title || definition.topic,
    assessmentNumber: evaluation.contentIndex + 1,
    exercises,
    pages: content?.e_page || [],
    score: evaluation.score,
    maxScore: content?.maxScore ?? null,
    className: evaluation.class?.name || '',
  };
  return {
    title: 'ຜົນການປະເມີນໃໝ່',
    description: `${studentName} · ${subjectName} · ${definition.topic}`.slice(
      0,
      255,
    ),
    message: [
      `ນັກຮຽນ: ${studentName}`,
      `ວິຊາ: ${subjectName}`,
      `ບົດຮຽນ: ${definition.topic}`,
      `ຊຸດປະເມີນ ${metadata.assessmentNumber}: ${metadata.assessmentTitle}`,
      exercises.length ? `ຂໍ້/ແບບຝຶກຫັດ: ${exercises.join(', ')}` : '',
      `ຄະແນນ: ${evaluation.score}${metadata.maxScore != null ? ` / ${metadata.maxScore}` : ''}`,
    ]
      .filter(Boolean)
      .join('\n'),
    metadata,
  };
}
