import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { Notification } from '../notifications/notification.entity';
import { Student } from '../students/student.entity';
import { evaluationNotification } from './evaluation-notification';
import { Evaluation } from './evaluation.entity';
import { CreateEvaluationDto } from './dto/create-evaluation.dto';
import { UpdateEvaluationDto } from './dto/update-evaluation.dto';
import { SubjectEvaluation } from '../subject_evaluations/subject-evaluation.entity';

@Injectable()
export class EvaluationService {
  constructor(
    @InjectRepository(Evaluation)
    private readonly evaluationRepo: Repository<Evaluation>,
    @InjectRepository(SubjectEvaluation)
    private readonly subjectEvaluationRepo: Repository<SubjectEvaluation>,
  ) {}

  private async lockScore(
    manager: EntityManager,
    studentId: string,
    definitionId: string | undefined,
    index: number,
  ) {
    // Serialize upserts and PATCH updates for the same score, including retries.
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `evaluation:${studentId}:${definitionId || ''}:${index}`,
    ]);
  }

  private async notifyParents(manager: EntityManager, evaluation: Evaluation) {
    if (evaluation.score == null || !evaluation.subjectEvaluation?.id) return;
    const definition = await manager.getRepository(SubjectEvaluation).findOne({
      where: { id: evaluation.subjectEvaluation.id },
      relations: ['lesson', 'lesson.subjectType'],
    });
    const student = await manager.getRepository(Student).findOne({
      where: { id: evaluation.student.id },
      relations: ['parents'],
    });
    if (!definition || !student) return;
    const recipients = [
      ...new Set(
        (student.parents || [])
          .filter((parent) => parent.isActive !== false)
          .map((parent) => parent.id),
      ),
    ];
    if (!recipients.length) return;
    const content = evaluationNotification(evaluation, definition, student);
    const repository = manager.getRepository(Notification);
    await repository.save(
      recipients.map((parentId) =>
        repository.create({
          ...content,
          parent_id: parentId,
          student_id: student.id,
          branch_id: student.branchId || undefined,
          module_type: 'EVALUATION',
          module_id: definition.id,
          seen: 0,
          clicked: 0,
        }),
      ),
    );
  }

  async create(dto: CreateEvaluationDto): Promise<Evaluation> {
    return this.evaluationRepo.manager.transaction(async (manager) => {
      const index = Number.isInteger(dto.contentIndex) ? dto.contentIndex! : 0;
      await this.lockScore(
        manager,
        dto.studentId,
        dto.subjectEvaluationId,
        index,
      );
      const repository = manager.getRepository(Evaluation);
      const definition = dto.subjectEvaluationId
        ? await manager.getRepository(SubjectEvaluation).findOne({
            where: { id: dto.subjectEvaluationId },
          })
        : null;
      if (dto.subjectEvaluationId && !definition)
        throw new NotFoundException(
          `Subject evaluation ${dto.subjectEvaluationId} not found`,
        );
      const existing = dto.subjectEvaluationId
        ? await repository.findOne({
            where: {
              student: { id: dto.studentId },
              subjectEvaluation: { id: dto.subjectEvaluationId },
              contentIndex: index,
            },
          })
        : null;
      const changed =
        !existing ||
        existing.score !== dto.score ||
        (dto.subjectId && existing.subject?.id !== dto.subjectId);
      const evaluation =
        existing ||
        repository.create({
          student: { id: dto.studentId },
          subjectEvaluation: definition || undefined,
          contentIndex: index,
          created_at: new Date(),
        });
      evaluation.admin = { id: dto.adminId } as Evaluation['admin'];
      evaluation.score = dto.score;
      if (dto.subjectId)
        evaluation.subject = { id: dto.subjectId } as Evaluation['subject'];
      if (dto.classId)
        evaluation.class = { id: dto.classId } as Evaluation['class'];
      evaluation.updated_at = new Date();
      const saved = await repository.save(evaluation);
      if (changed) await this.notifyParents(manager, saved);
      return saved;
    });
  }

  async findAll(): Promise<Evaluation[]> {
    return this.evaluationRepo.find({
      order: { created_at: 'DESC', id: 'DESC' },
    });
  }

  async findReportSource(classId: string, subjectEvaluationIds: string[]) {
    const definitionIds = [...new Set(subjectEvaluationIds)].slice(0, 250);
    if (!classId || !definitionIds.length)
      return { evaluations: [], definitions: [] };

    const [definitions, rows] = await Promise.all([
      this.subjectEvaluationRepo.find({
        where: { id: In(definitionIds) },
        relations: ['lesson', 'lesson.subjectType'],
      }),
      this.evaluationRepo
        .createQueryBuilder('evaluation')
        .select('evaluation.id', 'id')
        .addSelect('evaluation.student_id', 'studentId')
        .addSelect('evaluation.subject_evaluation_id', 'subjectEvaluationId')
        .addSelect('evaluation.content_index', 'contentIndex')
        .addSelect('evaluation.score', 'score')
        .addSelect('evaluation.updated_at', 'updatedAt')
        .where('evaluation.class_id = :classId', { classId })
        .andWhere('evaluation.subject_evaluation_id IN (:...definitionIds)', {
          definitionIds,
        })
        .orderBy('evaluation.student_id', 'ASC')
        .addOrderBy('evaluation.subject_evaluation_id', 'ASC')
        .addOrderBy('evaluation.content_index', 'ASC')
        .getRawMany(),
    ]);

    return { evaluations: rows, definitions };
  }

  async findByStudent(studentId: string): Promise<Evaluation[]> {
    return this.evaluationRepo.find({
      where: {
        student: {
          id: studentId,
        },
      },
      order: { created_at: 'DESC', id: 'DESC' },
    });
  }

  async updateScore(id: number, dto: UpdateEvaluationDto): Promise<Evaluation> {
    return this.evaluationRepo.manager.transaction(async (manager) => {
      const repository = manager.getRepository(Evaluation);
      let evaluation = await repository.findOne({ where: { id } });
      if (!evaluation)
        throw new NotFoundException(`Evaluation ${id} not found`);
      await this.lockScore(
        manager,
        evaluation.student.id,
        evaluation.subjectEvaluation?.id,
        evaluation.contentIndex,
      );
      evaluation = await repository.findOne({ where: { id } });
      if (!evaluation)
        throw new NotFoundException(`Evaluation ${id} not found`);
      const changed =
        (dto.score !== undefined && dto.score !== evaluation.score) ||
        (Number.isInteger(dto.contentIndex) &&
          dto.contentIndex !== evaluation.contentIndex) ||
        (dto.subjectId && dto.subjectId !== evaluation.subject?.id);
      if (dto.score !== undefined) evaluation.score = dto.score;
      if (Number.isInteger(dto.contentIndex))
        evaluation.contentIndex = dto.contentIndex!;
      if (dto.subjectId)
        evaluation.subject = { id: dto.subjectId } as Evaluation['subject'];
      if (dto.classId)
        evaluation.class = { id: dto.classId } as Evaluation['class'];
      evaluation.updated_at = new Date();
      const saved = await repository.save(evaluation);
      if (changed) await this.notifyParents(manager, saved);
      return saved;
    });
  }

  async remove(id: number): Promise<{ message: string }> {
    const evaluation = await this.evaluationRepo.findOne({
      where: { id },
    });

    if (!evaluation) {
      throw new NotFoundException(`Evaluation ${id} not found`);
    }

    await this.evaluationRepo.remove(evaluation);

    return { message: `Evaluation ${id} deleted successfully` };
  }
}
