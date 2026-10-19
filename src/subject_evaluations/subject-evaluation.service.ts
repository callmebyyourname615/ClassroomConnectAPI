import { Injectable, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { SubjectEvaluation } from './subject-evaluation.entity';
import { Lesson } from '../lesson/lesson.entity';
import { CreateSubjectEvaluationDto } from './dto/create-subject-evaluation.dto';
import { UpdateSubjectEvaluationDto } from './dto/update-subject-evaluation.dto';
import {
  evaluationTextTranslations,
  localizeEvaluationContents,
} from './subject-evaluation-localization';

const RELATIONS = [
  'lesson',
  'lesson.subjectType',
  'lesson.yearLevel',
  'lesson.yearLevel.level',
  'lesson.curriculums',
];

@Injectable()
export class SubjectEvaluationService {
  constructor(
    @InjectRepository(SubjectEvaluation)
    private readonly evalRepo: Repository<SubjectEvaluation>,
    @InjectRepository(Lesson)
    private readonly lessonRepo: Repository<Lesson>,
  ) {}

  private resolveLessonId(dto: { lesson_id?: string; lessonId?: string }) {
    return dto.lesson_id || dto.lessonId;
  }

  async findAll(): Promise<SubjectEvaluation[]> {
    return this.evalRepo.find({
      relations: RELATIONS,
    });
  }

  async findOne(id: string): Promise<SubjectEvaluation> {
    const evalEntity = await this.evalRepo.findOne({
      where: { id },
      relations: RELATIONS,
    });

    if (!evalEntity) throw new NotFoundException(`Evaluation ${id} not found`);
    return evalEntity;
  }

  async create(dto: CreateSubjectEvaluationDto): Promise<SubjectEvaluation> {
    const lessonId = this.resolveLessonId(dto);
    const lesson = await this.lessonRepo.findOne({
      where: { id: lessonId },
    });

    if (!lesson) throw new NotFoundException(`Lesson ${lessonId} not found`);

    const evalEntity = this.evalRepo.create({
      lessonId,
      lesson,
      topic: dto.topic,
      topic_translations: evaluationTextTranslations(dto.topic),
      description: dto.description,
      description_translations: evaluationTextTranslations(dto.description),
      contents: localizeEvaluationContents(dto.contents),
    });

    const saved = await this.evalRepo.save(evalEntity);
    return this.findOne(saved.id);
  }

  async update(
    id: string,
    dto: UpdateSubjectEvaluationDto,
  ): Promise<SubjectEvaluation> {
    const evalEntity = await this.evalRepo.findOne({
      where: { id },
      relations: ['lesson'],
    });

    if (!evalEntity) throw new NotFoundException(`Evaluation ${id} not found`);

    const lessonId = this.resolveLessonId(dto);

    if (lessonId && lessonId !== evalEntity.lessonId) {
      const lesson = await this.lessonRepo.findOne({ where: { id: lessonId } });
      if (!lesson) throw new NotFoundException(`Lesson ${lessonId} not found`);
      evalEntity.lesson = lesson;
      evalEntity.lessonId = lessonId;
    }

    evalEntity.topic = dto.topic ?? evalEntity.topic;
    if (dto.topic !== undefined)
      evalEntity.topic_translations = evaluationTextTranslations(dto.topic);
    evalEntity.description = dto.description ?? evalEntity.description;
    if (dto.description !== undefined)
      evalEntity.description_translations = evaluationTextTranslations(
        dto.description,
      );
    evalEntity.contents =
      dto.contents !== undefined
        ? localizeEvaluationContents(dto.contents)
        : evalEntity.contents;

    await this.evalRepo.save(evalEntity);
    return this.findOne(id);
  }

  async findBySubjectName(name: string): Promise<SubjectEvaluation[]> {
    return this.evalRepo
      .createQueryBuilder('se')
      .leftJoinAndSelect('se.lesson', 'lesson')
      .leftJoinAndSelect('lesson.subjectType', 'subjectType')
      .leftJoinAndSelect('lesson.yearLevel', 'yearLevel')
      .leftJoinAndSelect('yearLevel.level', 'level')
      .leftJoinAndSelect('lesson.curriculums', 'curriculums')
      .where('subjectType.name = :name', { name })
      .getMany();
  }

  async remove(id: string): Promise<void> {
    const result = await this.evalRepo.delete(id);
    if (result.affected === 0)
      throw new NotFoundException(`Evaluation ${id} not found`);
  }
}
