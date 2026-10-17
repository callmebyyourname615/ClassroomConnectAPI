import { evaluationNotification } from './evaluation-notification';
import { EvaluationService } from './evaluation.service';
import { Evaluation } from './evaluation.entity';
import { Notification } from '../notifications/notification.entity';
import { SubjectEvaluation } from '../subject_evaluations/subject-evaluation.entity';
import { Student } from '../students/student.entity';

describe('Evaluation score notifications', () => {
  const definition: any = {
    id: 'definition',
    lessonId: 'lesson',
    topic: 'Lesson 5',
    lesson: { subjectType: { name: 'Mathematics' } },
    contents: [
      {
        t_title: 'Addition',
        e_title: ['Question 1', 'Question 2'],
        e_page: ['18'],
        maxScore: 10,
      },
      { t_title: 'Subtraction', e_title: ['Question 3'], maxScore: 8 },
    ],
  };
  const student: any = {
    id: 'child',
    first_name_lao: 'Child',
    last_name_lao: 'Name',
    parents: [
      { id: 'parent-a', isActive: true },
      { id: 'parent-a', isActive: true },
      { id: 'parent-b', isActive: false },
    ],
  };
  it('preserves the exact subject, selected assessment, exercises and zero score', () => {
    const notification = evaluationNotification(
      { id: 5, student, score: 0, contentIndex: 1 } as any,
      definition,
      student,
    );
    expect(notification.metadata).toMatchObject({
      assessmentNumber: 2,
      assessmentTitle: 'Subtraction',
      exercises: ['Question 3'],
      score: 0,
      maxScore: 8,
      subjectName: 'Mathematics',
    });
    expect(notification.message).toContain('0 / 8');
    expect(notification.metadata.exercises).not.toContain('Question 1');
  });

  function setup(existingScore?: number) {
    let record: any =
      existingScore == null
        ? null
        : {
            id: 1,
            score: existingScore,
            contentIndex: 0,
            student: { id: 'child' },
            subjectEvaluation: definition,
          };
    let inbox: any[] = [];
    const notificationRepo = {
      create: (value: any) => value,
      save: jest.fn(async (items: any) => {
        inbox.push(...items);
        return items;
      }),
    };
    const evaluationRepo = {
      findOne: jest.fn(async () => record),
      create: (value: any) => value,
      save: jest.fn(async (item: any) => {
        record = { ...item, id: 1 };
        return record;
      }),
    };
    const manager: any = {
      query: jest.fn(async () => []),
      getRepository: (entity: any) =>
        entity === Evaluation
          ? evaluationRepo
          : entity === Notification
            ? notificationRepo
            : entity === SubjectEvaluation
              ? { findOne: async () => definition }
              : entity === Student
                ? { findOne: async () => student }
                : null,
    };
    const transaction = async (fn: any) => {
      const snapshot = record ? { ...record } : null;
      const previous = [...inbox];
      try {
        return await fn(manager);
      } catch (error) {
        record = snapshot;
        inbox = previous;
        throw error;
      }
    };
    const service = new EvaluationService(
      { manager: { transaction } } as any,
      {} as any,
    );
    return {
      service,
      notificationRepo,
      getRecord: () => record,
      getInbox: () => inbox,
    };
  }
  const dto: any = {
    studentId: 'child',
    adminId: 'teacher',
    subjectEvaluationId: 'definition',
    contentIndex: 0,
    score: 7,
  };
  it('notifies active linked parents once and skips an unchanged resubmission', async () => {
    const test = setup();
    await test.service.create(dto);
    await test.service.create(dto);
    expect(test.getInbox()).toHaveLength(1);
    expect(test.getInbox()[0].parent_id).toBe('parent-a');
  });
  it('notifies a correction through PATCH but does not duplicate an identical PATCH', async () => {
    const test = setup(7);
    await test.service.updateScore(1, { score: 8 });
    await test.service.updateScore(1, { score: 8 });
    expect(test.getInbox()).toHaveLength(1);
    expect(test.getInbox()[0].metadata.score).toBe(8);
  });
  it('rolls back the score if the recipient notification cannot be saved', async () => {
    const test = setup(4);
    test.notificationRepo.save.mockRejectedValueOnce(new Error('write failed'));
    await expect(test.service.create(dto)).rejects.toThrow('write failed');
    expect(test.getRecord().score).toBe(4);
    expect(test.getInbox()).toEqual([]);
  });
});
