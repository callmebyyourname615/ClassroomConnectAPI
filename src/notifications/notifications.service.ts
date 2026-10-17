import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindManyOptions, FindOneOptions, Repository } from 'typeorm';
import { Notification } from './notification.entity';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';
import { TaskAccessService } from '../task-access/task-access.service';
import { CacheService } from '../common/cache.service';
import { SchemaAlignmentService } from '../database/schema-alignment.service';

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private repo: Repository<Notification>,
    private readonly taskAccess: TaskAccessService,
    private readonly cache: CacheService,
    private readonly schemaAlignment: SchemaAlignmentService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.schemaAlignment.alignAllSchemas();
  }

  private isMissingColumnError(error: any): boolean {
    return (
      error?.code === '42703' ||
      String(error?.message || '').includes('does not exist')
    );
  }

  private async findWithRetry(
    options: FindManyOptions<Notification>,
  ): Promise<Notification[]> {
    try {
      return await this.repo.find(options);
    } catch (error: any) {
      if (this.isMissingColumnError(error)) {
        this.logger.warn(
          'Missing column detected during notifications query. Running schema alignment and retrying...',
        );
        await this.schemaAlignment.alignAllSchemas();
        return await this.repo.find(options);
      }
      throw error;
    }
  }

  private async findOneWithRetry(
    options: FindOneOptions<Notification>,
  ): Promise<Notification | null> {
    try {
      return await this.repo.findOne(options);
    } catch (error: any) {
      if (this.isMissingColumnError(error)) {
        this.logger.warn(
          'Missing column detected during notification query. Running schema alignment and retrying...',
        );
        await this.schemaAlignment.alignAllSchemas();
        return await this.repo.findOne(options);
      }
      throw error;
    }
  }

  private readonly notificationRelations = [
    'branch',
    'academic_year',
    'student',
    'parent',
  ] as const;
  private readonly notificationListTtlSeconds = 60;

  // ================= CREATE =================
  async create(dto: CreateNotificationDto) {
    if (dto.module_type === 'TASK') {
      await this.taskAccess.assertAdminCanMutateTask(
        dto.module_id,
        dto.admin_id,
      );
    }
    const data = this.repo.create(dto);
    const saved = await this.repo.save(data);
    await this.clearNotificationCache(saved);
    return saved;
  }

  // ================= GET ALL =================
  async findAll() {
    return this.cache.getOrSet(
      'notifications:all',
      this.notificationListTtlSeconds,
      () =>
        this.findWithRetry({
          where: { is_deleted: false },
          relations: [...this.notificationRelations],
          order: { created_at: 'DESC' },
        }),
    );
  }

  // ================= GET BY ID =================
  async findOne(id: string) {
    return this.cache.getOrSet(`notifications:${id}`, 60, () =>
      this.findOneUncached(id),
    );
  }

  private async findOneUncached(id: string) {
    const data = await this.findOneWithRetry({
      where: { id, is_deleted: false },
      relations: [...this.notificationRelations],
    });

    if (!data) throw new NotFoundException('Notification not found');
    return data;
  }

  // ================= UPDATE =================
  async update(id: string, dto: UpdateNotificationDto) {
    const data = await this.findOneUncached(id);
    if ((dto as any).module_type === 'TASK' || data.module_type === 'TASK') {
      await this.taskAccess.assertAdminCanMutateTask(
        (dto as any).module_id || data.module_id,
        (dto as any).admin_id || data.admin_id,
      );
    }
    Object.assign(data, dto);
    const saved = await this.repo.save(data);
    await this.clearNotificationCache(saved);
    return saved;
  }

  // ================= DELETE (soft delete) =================
  async remove(id: string) {
    const data = await this.findOneUncached(id);
    if (data.module_type === 'TASK') {
      await this.taskAccess.assertAdminCanMutateTask(
        data.module_id,
        data.admin_id,
      );
    }
    data.is_deleted = true;
    const saved = await this.repo.save(data);
    await this.clearNotificationCache(saved);
    return saved;
  }

  // ================= GET BY BRANCH =================
  async findByBranch(body: { branch_id: string }) {
    return this.cache.getOrSet(
      `notifications:branch:${body.branch_id}`,
      this.notificationListTtlSeconds,
      () =>
        this.findWithRetry({
          where: { branch_id: body.branch_id, is_deleted: false },
          relations: [...this.notificationRelations],
          order: { created_at: 'DESC' },
        }),
    );
  }

  // ================= GET BY PARENT =================
  async findByParent(parentId: string) {
    return this.cache.getOrSet(
      `notifications:parent:${parentId}`,
      this.notificationListTtlSeconds,
      () =>
        this.findWithRetry({
          where: { parent_id: parentId, is_deleted: false },
          relations: [...this.notificationRelations],
          order: { created_at: 'DESC' },
        }),
    );
  }

  // ================= GET BY STUDENT =================
  async findByStudent(studentId: string) {
    return this.cache.getOrSet(
      `notifications:student:${studentId}`,
      this.notificationListTtlSeconds,
      () =>
        this.findWithRetry({
          where: { student_id: studentId, is_deleted: false },
          relations: [...this.notificationRelations],
          order: { created_at: 'DESC' },
        }),
    );
  }

  // The parent's inbox is scoped by the authenticated JWT, never a client parent ID.
  async findParentInbox(parentId: string) {
    const rows = await this.repo.find({
      where: { parent_id: parentId, is_deleted: false },
      relations: ['branch', 'student'],
      order: { created_at: 'DESC', id: 'DESC' },
    });
    return rows.map(({ branch, student, ...notification }) => {
      const studentNames = student
        ? {
            la: [student.first_name_lao, student.last_name_lao]
              .filter(Boolean)
              .join(' ')
              .trim(),
            en:
              [student.first_name_eng, student.last_name_eng]
                .filter(Boolean)
                .join(' ')
                .trim() || null,
          }
        : null;
      return {
        ...notification,
        ...(studentNames?.la || studentNames?.en
          ? {
              metadata: {
                ...notification.metadata,
                studentNameTranslations: studentNames,
              },
            }
          : {}),
        sender: branch?.name?.trim() || null,
        ...(branch?.name_translations
          ? { sender_translations: branch.name_translations }
          : {}),
      };
    });
  }

  async setParentRead(id: string, parentId: string, seen: boolean) {
    const notification = await this.repo.findOne({
      where: { id, parent_id: parentId, is_deleted: false },
    });
    if (!notification) throw new NotFoundException('Notification not found');
    notification.seen = seen ? 1 : 0;
    if (seen) notification.clicked = 1;
    const saved = await this.repo.save(notification);
    await this.clearNotificationCache(saved);
    return saved;
  }

  // ================= MARK SEEN =================
  async markSeen(id: string) {
    const data = await this.findOneUncached(id);
    data.seen = 1;
    const saved = await this.repo.save(data);
    await this.clearNotificationCache(saved);
    return saved;
  }

  // ================= MARK CLICKED =================
  async markClicked(id: string) {
    const data = await this.findOneUncached(id);
    data.clicked = 1;
    data.seen = 1;
    const saved = await this.repo.save(data);
    await this.clearNotificationCache(saved);
    return saved;
  }

  private async clearNotificationCache(
    notification?: Notification,
  ): Promise<void> {
    await this.cache.del('notifications:all');
    await this.cache.delPattern('notifications:branch:*');
    await this.cache.delPattern('notifications:parent:*');
    await this.cache.delPattern('notifications:student:*');

    const keys = [
      notification?.id,
      notification?.branch_id ? `branch:${notification.branch_id}` : '',
      notification?.parent_id ? `parent:${notification.parent_id}` : '',
      notification?.student_id ? `student:${notification.student_id}` : '',
    ].filter(Boolean);

    await Promise.all(
      keys.map((key) => this.cache.del(`notifications:${key}`)),
    );
  }
}
