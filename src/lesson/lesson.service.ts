import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Lesson } from './lesson.entity';
import { SubjectType } from '../subject_types/subject-type.entity';
import { YearLevel } from '../year_levels/year-level.entity';
import { Curriculum } from '../curriculums/curriculum.entity';
import { Subject } from '../subjects/subject.entity';
import { SubjectEvaluation } from '../subject_evaluations/subject-evaluation.entity';
import { Evaluation } from '../evaluations/evaluation.entity';
import { CreateLessonDto } from './dto/create-lesson.dto';
import { UpdateLessonDto } from './dto/update-lesson.dto';
import * as fs from 'fs';
import * as path from 'path';
import { CacheService } from '../common/cache.service';

@Injectable()
export class LessonService {
  constructor(
    @InjectRepository(Lesson)
    private readonly lessonRepo: Repository<Lesson>,

    @InjectRepository(SubjectType)
    private readonly subjectTypeRepo: Repository<SubjectType>,

    @InjectRepository(YearLevel)
    private readonly yearLevelRepo: Repository<YearLevel>,

    @InjectRepository(Curriculum)
    private readonly curriculumRepo: Repository<Curriculum>,

    @InjectRepository(Subject)
    private readonly subjectRepo: Repository<Subject>,

    @InjectRepository(SubjectEvaluation)
    private readonly subjectEvaluationRepo: Repository<SubjectEvaluation>,

    @InjectRepository(Evaluation)
    private readonly evaluationRepo: Repository<Evaluation>,

    private readonly cache: CacheService,
  ) {}

  private readonly RELATIONS = [
    'subjectType',
    'yearLevel',
    'yearLevel.level',
    'curriculums',
  ];

  private lessonUploadPath(file?: Express.Multer.File): string | null {
    if (!file?.filename) return null;
    return `uploads/lessons/${file.filename}`;
  }

  private async syncLessonSubjectLink(
    lessonId: string,
    subjectId?: string,
  ): Promise<void> {
    const normalizedSubjectId = String(subjectId || '').trim();

    if (!normalizedSubjectId) {
      return;
    }

    const linkedSubjects = await this.subjectRepo
      .createQueryBuilder('subject')
      .leftJoinAndSelect('subject.lessons', 'lesson')
      .where('lesson.id = :lessonId', { lessonId })
      .getMany();

    for (const linkedSubject of linkedSubjects) {
      if (linkedSubject.id === normalizedSubjectId) {
        continue;
      }

      linkedSubject.lessons = (
        Array.isArray(linkedSubject.lessons) ? linkedSubject.lessons : []
      ).filter((lesson) => lesson.id !== lessonId);

      await this.subjectRepo.save(linkedSubject);
    }

    const subject = await this.subjectRepo.findOne({
      where: { id: normalizedSubjectId },
      relations: ['lessons'],
    });

    if (!subject) {
      throw new BadRequestException('subjectId not found');
    }

    const lesson = await this.lessonRepo.findOne({ where: { id: lessonId } });

    if (!lesson) {
      throw new NotFoundException(`Lesson ${lessonId} not found`);
    }

    subject.lessons = [
      lesson,
      ...(Array.isArray(subject.lessons) ? subject.lessons : []).filter(
        (item) => item.id !== lessonId,
      ),
    ];

    await this.subjectRepo.save(subject);
  }

  private async unlinkLessonFromSubjects(lessonId: string): Promise<void> {
    const linkedSubjects = await this.subjectRepo
      .createQueryBuilder('subject')
      .leftJoinAndSelect('subject.lessons', 'lesson')
      .where('lesson.id = :lessonId', { lessonId })
      .getMany();

    for (const subject of linkedSubjects) {
      subject.lessons = (
        Array.isArray(subject.lessons) ? subject.lessons : []
      ).filter((lesson) => lesson.id !== lessonId);

      await this.subjectRepo.save(subject);
    }
  }

  async create(
    dto: CreateLessonDto,
    files: {
      s_file?: Express.Multer.File[];
      t_file?: Express.Multer.File[];
      e_file?: Express.Multer.File[];
    },
  ): Promise<Lesson> {
    const subjectType = await this.subjectTypeRepo.findOne({
      where: { id: dto.subjectTypeId },
    });
    if (!subjectType) throw new BadRequestException('subjectTypeId not found');

    const yearLevel = await this.yearLevelRepo.findOne({
      where: { id: dto.yearLevelId },
    });
    if (!yearLevel) throw new BadRequestException('yearLevelId not found');

    const { ids: curriculumIds } = this.extractCurriculumIds(dto);
    const curriculums = await this.resolveCurriculums(curriculumIds);

    const lesson = this.lessonRepo.create({
      subjectTypeId: dto.subjectTypeId,
      subjectType,
      yearLevelId: dto.yearLevelId,
      yearLevel,
      curriculums,
      s_year: dto.s_year ?? null,
      t_year: dto.t_year ?? null,
      s_file: this.lessonUploadPath(files.s_file?.[0]),
      t_file: this.lessonUploadPath(files.t_file?.[0]),
      e_file: this.lessonUploadPath(files.e_file?.[0]),
    });

    const saved = await this.lessonRepo.save(lesson);
    await this.syncLessonSubjectLink(saved.id, dto.subjectId);
    await this.clearLessonRelatedCache(saved.id);
    return this.findOne(saved.id);
  }

  async findAll(
    subjectTypeId?: string,
    yearLevelId?: string,
    curriculumId?: string,
  ): Promise<Lesson[]> {
    const key = [
      'lessons',
      `subject-type:${subjectTypeId || 'all'}`,
      `year-level:${yearLevelId || 'all'}`,
      `curriculum:${curriculumId || 'all'}`,
    ].join(':');

    return this.cache.getOrSet(key, 600, async () => {
      const query = this.lessonRepo
        .createQueryBuilder('lesson')
        .leftJoinAndSelect('lesson.subjectType', 'subjectType')
        .leftJoinAndSelect('lesson.yearLevel', 'yearLevel')
        .leftJoinAndSelect('yearLevel.level', 'level')
        .leftJoinAndSelect('lesson.curriculums', 'curriculum');

      if (subjectTypeId) {
        query.andWhere('lesson.subjectTypeId = :subjectTypeId', {
          subjectTypeId,
        });
      }
      if (yearLevelId) {
        query.andWhere('lesson.yearLevelId = :yearLevelId', { yearLevelId });
      }
      if (curriculumId) {
        query.andWhere('curriculum.id = :curriculumId', { curriculumId });
      }

      return query.orderBy('lesson.createdAt', 'DESC').getMany();
    });
  }

  async findOne(id: string): Promise<Lesson> {
    const lesson = await this.cache.getOrSet(`lessons:${id}`, 600, () =>
      this.findOneUncached(id),
    );
    return lesson;
  }

  private async findOneUncached(id: string): Promise<Lesson> {
    const lesson = await this.lessonRepo.findOne({
      where: { id },
      relations: this.RELATIONS,
    });
    if (!lesson) throw new NotFoundException(`Lesson ${id} not found`);
    return lesson;
  }

  async update(
    id: string,
    dto: UpdateLessonDto,
    files: {
      s_file?: Express.Multer.File[];
      t_file?: Express.Multer.File[];
      e_file?: Express.Multer.File[];
    },
  ): Promise<Lesson> {
    const lesson = await this.findOneUncached(id);

    if (dto.subjectTypeId) {
      const subjectType = await this.subjectTypeRepo.findOne({
        where: { id: dto.subjectTypeId },
      });
      if (!subjectType)
        throw new BadRequestException('subjectTypeId not found');
      lesson.subjectTypeId = dto.subjectTypeId;
      lesson.subjectType = subjectType;
    }

    if (dto.yearLevelId) {
      const yearLevel = await this.yearLevelRepo.findOne({
        where: { id: dto.yearLevelId },
      });
      if (!yearLevel) throw new BadRequestException('yearLevelId not found');
      lesson.yearLevelId = dto.yearLevelId;
      lesson.yearLevel = yearLevel;
    }

    const { ids: curriculumIds, provided: curriculumIdsProvided } =
      this.extractCurriculumIds(dto);
    if (curriculumIdsProvided) {
      lesson.curriculums = await this.resolveCurriculums(curriculumIds);
    }

    if (dto.s_year !== undefined) lesson.s_year = dto.s_year;
    if (dto.t_year !== undefined) lesson.t_year = dto.t_year;

    if (files.s_file?.[0]) {
      this.deleteFile(lesson.s_file);
      lesson.s_file = this.lessonUploadPath(files.s_file[0]);
    }
    if (files.t_file?.[0]) {
      this.deleteFile(lesson.t_file);
      lesson.t_file = this.lessonUploadPath(files.t_file[0]);
    }
    if (files.e_file?.[0]) {
      this.deleteFile(lesson.e_file);
      lesson.e_file = this.lessonUploadPath(files.e_file[0]);
    }

    const saved = await this.lessonRepo.save(lesson);
    await this.syncLessonSubjectLink(saved.id, dto.subjectId);
    await this.clearLessonRelatedCache(saved.id);
    return this.findOne(saved.id);
  }

  async remove(id: string): Promise<{ message: string }> {
    const lesson = await this.findOneUncached(id);
    await this.removeLessonDependencies(id);
    await this.unlinkLessonFromSubjects(id);
    this.deleteFile(lesson.s_file);
    this.deleteFile(lesson.t_file);
    this.deleteFile(lesson.e_file);
    await this.lessonRepo.remove(lesson);
    await this.clearLessonRelatedCache(id);
    return { message: `Lesson ${id} deleted successfully` };
  }

  private async clearLessonRelatedCache(id?: string): Promise<void> {
    await this.cache.delPattern('lessons:*');
    await this.cache.delPattern('subjects:*');
    await this.cache.del('branches:all');
    if (id) await this.cache.del(`lessons:${id}`);
  }

  private async removeLessonDependencies(lessonId: string): Promise<void> {
    const subjectEvaluations = await this.subjectEvaluationRepo.find({
      where: { lessonId },
      select: ['id'],
    });

    const subjectEvaluationIds = subjectEvaluations
      .map((item) => String(item.id || '').trim())
      .filter(Boolean);

    if (!subjectEvaluationIds.length) {
      return;
    }

    await this.evaluationRepo
      .createQueryBuilder()
      .update(Evaluation)
      .set({ subjectEvaluation: null } as any)
      .where('subject_evaluation_id IN (:...subjectEvaluationIds)', {
        subjectEvaluationIds,
      })
      .execute();

    await this.subjectEvaluationRepo.delete({ lessonId });
  }

  private async resolveCurriculums(
    curriculumIds: string[],
  ): Promise<Curriculum[]> {
    if (!curriculumIds.length) return [];

    const curriculums = await this.curriculumRepo.findBy({
      id: In(curriculumIds),
    });

    if (curriculums.length !== curriculumIds.length) {
      throw new BadRequestException('One or more curriculumIds not found');
    }

    return curriculums;
  }

  private extractCurriculumIds(payload: object): {
    ids: string[];
    provided: boolean;
  } {
    const raw = payload as Record<string, unknown>;
    const collected = new Set<string>();
    let provided = false;

    const append = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) append(item);
        return;
      }

      if (typeof value !== 'string') return;

      const trimmed = value.trim();
      if (!trimmed) return;

      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          const parsed = JSON.parse(trimmed);
          append(parsed);
          return;
        } catch {
          // fall through and treat as a single string
        }
      }

      collected.add(trimmed);
    };

    for (const key of [
      'curriculumIds',
      'curriculumIds[]',
      'curriculumIds_json',
      'curriculum_ids',
      'curriculum_ids[]',
      'curriculum_ids_json',
      'curriculums',
      'curriculums[]',
      'curriculums_json',
    ]) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) {
        provided = true;
        append(raw[key]);
      }
    }

    const indexedKeys = Object.keys(raw)
      .filter((key) =>
        /^(curriculumIds|curriculum_ids|curriculums)\\[\\d+\\]$/.test(key),
      )
      .sort(
        (a, b) =>
          Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0),
      );

    if (indexedKeys.length) {
      provided = true;
      for (const key of indexedKeys) {
        append(raw[key]);
      }
    }

    return {
      ids: [...collected],
      provided,
    };
  }

  private deleteFile(filePath: string | null): void {
    if (!filePath) return;
    try {
      const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
      const resolvedPath = path.isAbsolute(filePath)
        ? filePath
        : path.join(process.cwd(), normalizedPath);
      if (fs.existsSync(resolvedPath)) fs.unlinkSync(resolvedPath);
    } catch {
      // silently ignore
    }
  }
}
