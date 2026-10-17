import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { TeacherHomework } from './teacher-homework.entity';
import { TeacherHomeworkItem } from './teacher-homework-item.entity';
import { CreateTeacherHomeworkDto } from './dto/create-teacher-homework.dto';
import { UpdateTeacherHomeworkDto } from './dto/update-teacher-homework.dto';
import { CreateTeacherHomeworkItemDto } from './dto/create-teacher-homework-item.dto';
import { UpdateTeacherHomeworkItemDto } from './dto/update-teacher-homework-item.dto';
import { TeacherHomeworkStatus } from './teacher-homework-status.enum';
import { TeachLearning } from '../teach_learning/teach-learning.entity';
import { Teaching } from '../teachings/teaching.entity';
import { Class } from '../classes/class.entity'; // ✅ new
import { notifyHomework } from './homework-notification';

@Injectable()
export class TeacherHomeworkService {
  constructor(
    @InjectRepository(TeacherHomework)
    private readonly teacherHomeworkRepo: Repository<TeacherHomework>,

    @InjectRepository(TeacherHomeworkItem)
    private readonly teacherHomeworkItemRepo: Repository<TeacherHomeworkItem>,

    @InjectRepository(TeachLearning)
    private readonly teachLearningRepo: Repository<TeachLearning>,

    @InjectRepository(Teaching)
    private readonly teachingRepo: Repository<Teaching>,

    @InjectRepository(Class) // ✅ new
    private readonly classRepo: Repository<Class>,
  ) {}

  async create(
    createDto: CreateTeacherHomeworkDto,
    file?: Express.Multer.File,
  ): Promise<TeacherHomework> {
    const teaching = await this.teachingRepo.findOne({
      where: { id: createDto.teachingId },
      relations: ['branch', 'subject', 'subject.class', 'subject.subjectType'],
    });
    if (!teaching) throw new BadRequestException('teachingId not found');

    const teachLearning = await this.teachLearningRepo.findOne({
      where: { id: createDto.teachLearningId },
      relations: ['admin', 'subject'],
    });
    if (!teachLearning)
      throw new BadRequestException('teachLearningId not found');

    // ✅ Resolve class if provided
    let cls: Class | null = null;
    const classId = createDto.classId || teaching.subject?.class_id;
    if (classId) {
      cls = await this.classRepo.findOne({ where: { id: classId } });
      if (!cls) throw new BadRequestException('classId not found');
    }

    const items = (createDto.items ?? []).map((item, index) =>
      this.teacherHomeworkItemRepo.create({
        title: item.title,
        teacherGuidePage: item.teacherGuidePage ?? null,
        itemInstruction: item.itemInstruction ?? null,
        imageUrl: item.imageUrl ?? null,
        sortOrder: item.sortOrder ?? index + 1,
        score: item.score,
        // ✅ Each item inherits class from parent by default
        classId: cls?.id ?? null,
        class: cls ?? undefined,
      }),
    );
    this.validateAllItemsHaveScore(items);
    const totalScore = this.validateTotalScore(items);

    const status = createDto.status ?? TeacherHomeworkStatus.DRAFT;
    if (status === TeacherHomeworkStatus.SENT) {
      this.validateCanPublish(items);
    }

    const homework = this.teacherHomeworkRepo.create({
      teachingId: teaching.id,
      teaching,
      branchId: teaching.branch.id,
      branch: teaching.branch,
      teachLearningId: teachLearning.id,
      teachLearning,
      classId: cls?.id ?? null, // ✅ new
      class: cls ?? undefined, // ✅ new
      title: createDto.title,
      overallInstruction: createDto.overallInstruction ?? null,
      dueDate: createDto.dueDate ? new Date(createDto.dueDate) : null,
      status,
      sentAt: status === TeacherHomeworkStatus.SENT ? new Date() : null,
      totalScore,
      items,
    });

    const saved = await this.teacherHomeworkRepo.manager.transaction(
      async (manager) => {
        const saved = await manager
          .getRepository(TeacherHomework)
          .save(homework);
        if (saved.status === TeacherHomeworkStatus.SENT)
          await notifyHomework(manager, saved);
        return saved;
      },
    );
    return this.findOne(saved.id);
  }

  async findAll(
    teachingId?: string,
    status?: TeacherHomeworkStatus,
    classId?: string, // ✅ new filter
  ): Promise<TeacherHomework[]> {
    const query = this.teacherHomeworkRepo
      .createQueryBuilder('teacherHomework')
      .leftJoinAndSelect('teacherHomework.teaching', 'teaching')
      .leftJoinAndSelect('teacherHomework.branch', 'branch')
      .leftJoinAndSelect('teacherHomework.class', 'class'); // ✅ new

    if (teachingId) {
      query.andWhere('teacherHomework.teachingId = :teachingId', {
        teachingId,
      });
    }
    if (status) {
      query.andWhere('teacherHomework.status = :status', { status });
    }
    if (classId) {
      // ✅ new
      query.andWhere('teacherHomework.classId = :classId', { classId });
    }

    const homeworks = await query
      .orderBy('teacherHomework.createdAt', 'DESC')
      .getMany();
    await this.attachItems(homeworks);
    return homeworks;
  }

  async findOne(id: string): Promise<TeacherHomework> {
    const homework = await this.teacherHomeworkRepo.findOne({
      where: { id },
      relations: ['teaching', 'branch', 'class', 'items', 'items.class'], // ✅ added class & items.class
      order: { items: { sortOrder: 'ASC' } },
    });

    if (!homework) {
      throw new NotFoundException(`Teacher homework with ID ${id} not found`);
    }

    return homework;
  }

  private async attachItems(homeworks: TeacherHomework[]) {
    if (!homeworks.length) return;

    const homeworkIds = homeworks.map((homework) => homework.id);
    const items = await this.teacherHomeworkItemRepo.find({
      where: { teacherHomeworkId: In(homeworkIds) },
      relations: ['class'],
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });

    const itemsByHomeworkId = new Map<string, TeacherHomeworkItem[]>();

    for (const item of items) {
      const list = itemsByHomeworkId.get(item.teacherHomeworkId) ?? [];
      list.push(item);
      itemsByHomeworkId.set(item.teacherHomeworkId, list);
    }

    for (const homework of homeworks) {
      homework.items = itemsByHomeworkId.get(homework.id) ?? [];
    }
  }

  async update(
    id: string,
    updateDto: UpdateTeacherHomeworkDto,
  ): Promise<TeacherHomework> {
    return this.teacherHomeworkRepo.manager.transaction(async (manager) => {
      const existing = await this.lockedHomework(manager, id);
      const wasSent = existing.status === TeacherHomeworkStatus.SENT;

      if (updateDto.teachLearningId) {
        const teachLearning = await this.teachLearningRepo.findOne({
          where: { id: updateDto.teachLearningId },
          relations: ['admin', 'subject'],
        });
        if (!teachLearning)
          throw new BadRequestException('teachLearningId not found');
        existing.teachLearningId = updateDto.teachLearningId;
        existing.teachLearning = teachLearning;
      }

      // ✅ Update class on homework
      if (updateDto.classId !== undefined) {
        if (updateDto.classId === null) {
          existing.classId = null;
          existing.class = null;
        } else {
          const cls = await this.classRepo.findOne({
            where: { id: updateDto.classId },
          });
          if (!cls) throw new BadRequestException('classId not found');
          existing.classId = cls.id;
          existing.class = cls;
        }
      }

      if (updateDto.title !== undefined) existing.title = updateDto.title;
      if (updateDto.overallInstruction !== undefined)
        existing.overallInstruction = updateDto.overallInstruction ?? null;
      if (updateDto.dueDate !== undefined)
        existing.dueDate = updateDto.dueDate
          ? new Date(updateDto.dueDate)
          : null;

      if (updateDto.status !== undefined) {
        existing.status = updateDto.status;
        if (updateDto.status === TeacherHomeworkStatus.SENT) {
          this.validateCanPublish(existing.items);
          existing.sentAt = existing.sentAt ?? new Date();
        }
        if (updateDto.status === TeacherHomeworkStatus.DRAFT) {
          existing.sentAt = null;
        }
      }

      this.validateAllItemsHaveScore(existing.items);
      existing.totalScore = this.validateTotalScore(existing.items);

      const saved = await manager.getRepository(TeacherHomework).save(existing);
      if (!wasSent && saved.status === TeacherHomeworkStatus.SENT)
        await notifyHomework(manager, saved);
      return saved;
    });
  }

  async remove(id: string): Promise<{ message: string }> {
    const homework = await this.findOne(id);
    await this.teacherHomeworkRepo.remove(homework);
    return { message: 'Teacher homework deleted successfully' };
  }

  async publish(id: string): Promise<TeacherHomework> {
    return this.teacherHomeworkRepo.manager.transaction(async (manager) => {
      const homework = await this.lockedHomework(manager, id);
      if (homework.status === TeacherHomeworkStatus.SENT) return homework;
      this.validateCanPublish(homework.items);
      homework.status = TeacherHomeworkStatus.SENT;
      homework.sentAt = homework.sentAt ?? new Date();
      homework.totalScore = this.validateTotalScore(homework.items);
      const saved = await manager.getRepository(TeacherHomework).save(homework);
      await notifyHomework(manager, saved);
      return saved;
    });
  }

  private async lockedHomework(manager: EntityManager, id: string) {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `homework:${id}`,
    ]);
    const homework = await manager.getRepository(TeacherHomework).findOne({
      where: { id },
      relations: ['teaching', 'branch', 'class', 'items', 'items.class'],
      order: { items: { sortOrder: 'ASC' } },
    });
    if (!homework)
      throw new NotFoundException(`Teacher homework with ID ${id} not found`);
    return homework;
  }

  async createItem(
    homeworkId: string,
    createDto: CreateTeacherHomeworkItemDto,
    file?: Express.Multer.File,
  ): Promise<TeacherHomeworkItem> {
    const homework = await this.teacherHomeworkRepo.findOne({
      where: { id: homeworkId },
      relations: ['items', 'class'], // ✅ load class so we can inherit it
    });

    if (!homework) {
      throw new NotFoundException(
        `Teacher homework with ID ${homeworkId} not found`,
      );
    }

    if (createDto.score === null || createDto.score === undefined) {
      throw new BadRequestException('score is required');
    }

    // ✅ Resolve class: use item-level override, fallback to homework's class
    let cls: Class | null = homework.class ?? null;
    if (createDto.classId !== undefined) {
      if (createDto.classId === null) {
        cls = null;
      } else {
        cls = await this.classRepo.findOne({
          where: { id: createDto.classId },
        });
        if (!cls) throw new BadRequestException('classId not found');
      }
    }

    const imageUrl = file
      ? `uploads/homeworks/${file.filename}`
      : (createDto.imageUrl ?? null);

    const item = this.teacherHomeworkItemRepo.create({
      teacherHomeworkId: homeworkId,
      teacherHomework: homework,
      classId: cls?.id ?? null, // ✅ new
      class: cls ?? undefined, // ✅ new
      title: createDto.title,
      teacherGuidePage: createDto.teacherGuidePage ?? null,
      itemInstruction: createDto.itemInstruction ?? null,
      imageUrl,
      sortOrder: createDto.sortOrder ?? (homework.items?.length ?? 0) + 1,
      score: createDto.score,
    });

    this.validateTotalScore([...(homework.items ?? []), item]);
    const savedItem = await this.teacherHomeworkItemRepo.save(item);
    await this.refreshTotalScore(homeworkId);
    return this.findItem(savedItem.id);
  }

  async findItems(homeworkId: string): Promise<TeacherHomeworkItem[]> {
    const homework = await this.teacherHomeworkRepo.findOne({
      where: { id: homeworkId },
    });
    if (!homework) {
      throw new NotFoundException(
        `Teacher homework with ID ${homeworkId} not found`,
      );
    }

    return this.teacherHomeworkItemRepo.find({
      where: { teacherHomeworkId: homeworkId },
      relations: ['class'], // ✅ new
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  async findItem(itemId: string): Promise<TeacherHomeworkItem> {
    const item = await this.teacherHomeworkItemRepo.findOne({
      where: { id: itemId },
      relations: ['teacherHomework', 'class'], // ✅ added class
    });
    if (!item) {
      throw new NotFoundException(
        `Teacher homework item with ID ${itemId} not found`,
      );
    }
    return item;
  }

  async updateItem(
    itemId: string,
    updateDto: UpdateTeacherHomeworkItemDto,
  ): Promise<TeacherHomeworkItem> {
    const existingItem = await this.findItem(itemId);

    if (updateDto.score === null || updateDto.score === undefined) {
      throw new BadRequestException('score is required');
    }

    // ✅ Update class on item
    if (updateDto.classId !== undefined) {
      if (updateDto.classId === null) {
        existingItem.classId = null;
        existingItem.class = null;
      } else {
        const cls = await this.classRepo.findOne({
          where: { id: updateDto.classId },
        });
        if (!cls) throw new BadRequestException('classId not found');
        existingItem.classId = cls.id;
        existingItem.class = cls;
      }
    }

    if (updateDto.title !== undefined) existingItem.title = updateDto.title;
    if (updateDto.teacherGuidePage !== undefined)
      existingItem.teacherGuidePage = updateDto.teacherGuidePage ?? null;
    if (updateDto.itemInstruction !== undefined)
      existingItem.itemInstruction = updateDto.itemInstruction ?? null;
    if (updateDto.imageUrl !== undefined)
      existingItem.imageUrl = updateDto.imageUrl ?? null;
    if (updateDto.sortOrder !== undefined)
      existingItem.sortOrder = updateDto.sortOrder;
    existingItem.score = updateDto.score;

    const siblingItems = await this.teacherHomeworkItemRepo.find({
      where: { teacherHomeworkId: existingItem.teacherHomeworkId },
    });
    this.validateTotalScore(
      siblingItems.map((item) =>
        item.id === existingItem.id ? existingItem : item,
      ),
    );

    const savedItem = await this.teacherHomeworkItemRepo.save(existingItem);
    await this.refreshTotalScore(existingItem.teacherHomeworkId);
    return this.findItem(savedItem.id);
  }

  async removeItem(itemId: string): Promise<{ message: string }> {
    const item = await this.findItem(itemId);
    const homeworkId = item.teacherHomeworkId;
    await this.teacherHomeworkItemRepo.remove(item);
    await this.refreshTotalScore(homeworkId);
    return { message: 'Teacher homework item deleted successfully' };
  }

  private validateAllItemsHaveScore(items: Array<{ score?: number | null }>) {
    if (!items || items.length === 0) return;
    if (items.some((item) => item.score === null || item.score === undefined)) {
      throw new BadRequestException('All homework items must have score');
    }
  }

  private validateCanPublish(items: Array<{ score?: number | null }>) {
    if (!items || items.length === 0) {
      throw new BadRequestException(
        'Cannot send homework without at least one item',
      );
    }
    this.validateAllItemsHaveScore(items);
  }

  private calculateTotalScore(items: Array<{ score?: number | null }>): number {
    if (!items || items.length === 0) return 0;
    return items.reduce((sum, item) => sum + (Number(item.score) || 0), 0);
  }

  private validateTotalScore(items: Array<{ score?: number | null }>): number {
    const totalScore = this.calculateTotalScore(items);
    if (totalScore > 100) {
      throw new BadRequestException(
        'Homework item scores cannot total more than 100',
      );
    }
    return totalScore;
  }

  private async refreshTotalScore(homeworkId: string): Promise<void> {
    const homework = await this.teacherHomeworkRepo.findOne({
      where: { id: homeworkId },
      relations: ['items'],
    });
    if (!homework) return;
    homework.totalScore = this.validateTotalScore(homework.items);
    await this.teacherHomeworkRepo.save(homework);
  }
}
