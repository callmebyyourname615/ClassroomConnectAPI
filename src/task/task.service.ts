import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { Task } from './task.entity';
import { FileService } from '../file/file.service';
import { CreateTaskDto } from './dto/CreateTaskDto';
import { UpdateTaskDto } from './dto/UpdateTaskDto';
import { Enrollment } from '../enrollments/enrollment.entity';
import { Student } from '../students/student.entity';
import { TaskSubmissionSlot } from '../task-submission/task-submission-slot.entity';
import { File } from '../file/files.entity';
import { notifyTask } from './task-notification';
import { CacheService } from '../common/cache.service';

@Injectable()
export class TaskService {
  constructor(
    @InjectRepository(Task)
    private readonly taskRepo: Repository<Task>,
    @InjectRepository(Enrollment)
    private readonly enrollmentRepo: Repository<Enrollment>,
    @InjectRepository(Student)
    private readonly studentRepo: Repository<Student>,
    @InjectRepository(TaskSubmissionSlot)
    private readonly submissionSlotRepo: Repository<TaskSubmissionSlot>,
    @InjectRepository(File)
    private readonly fileRepo: Repository<File>,
    private readonly fileService: FileService,
    private readonly cache: CacheService,
  ) {}

  private readonly taskListTtlSeconds = 60;
  private readonly taskDetailTtlSeconds = 120;
  private readonly taskWorkloadTtlSeconds = 60;
  private readonly activeTaskStatuses = [
    'assigned',
    'in_progress',
    'submitted',
    'overdue',
  ] as const;

  async create(
    data: CreateTaskDto,
    files?: Express.Multer.File[],
  ): Promise<Task> {
    const {
      student_id,
      class_id,
      deadline,
      start_date,
      reminders,
      settings,
      assignment_student_ids,
      assignment_class_ids,
      status,
      assignment_mode,
      ...rest
    } = data;

    // Multipart bodies arrive as strings — normalize obvious ones.
    const normalizedReminders = this.parseJsonMaybe(reminders);
    const normalizedSettings = this.parseJsonMaybe(settings);
    const normalizedStudentIds = this.parseJsonArrayMaybe(
      assignment_student_ids,
    );
    const normalizedClassIds = this.parseJsonArrayMaybe(assignment_class_ids);

    // Cross-field defaults derived from assignment_mode
    const resolvedMode =
      assignment_mode ??
      this.inferAssignmentMode({
        student_id,
        class_id,
        normalizedStudentIds,
        normalizedClassIds,
      });

    if (
      !this.hasAssignment({
        student_id,
        class_id,
        normalizedStudentIds,
        normalizedClassIds,
      })
    ) {
      throw new BadRequestException(
        'Task must be assigned to at least one student or class.',
      );
    }
    if (status === 'assigned') {
      this.assertReadyForAssignment({
        name: data.name,
        description: data.description,
        subject: data.subject,
        deadline,
        settings: normalizedSettings,
      });
    }

    const newTask = this.taskRepo.create({
      ...rest,
      deadline: deadline ? new Date(deadline) : undefined,
      start_date: start_date ? new Date(start_date) : undefined,
      status: status ?? 'draft',
      assignment_mode: resolvedMode,
      assignment_student_ids: normalizedStudentIds ?? undefined,
      assignment_class_ids: normalizedClassIds ?? undefined,
      reminders: normalizedReminders ?? undefined,
      settings: normalizedSettings ?? undefined,
      class: class_id ? ({ id: class_id } as any) : undefined,
      student: student_id ? ({ id: student_id } as any) : undefined,
      added_by_id: data.added_by_id,
      added_by_type: data.added_by_type,
    });

    const savedTask = await this.taskRepo.manager.transaction(
      async (manager) => {
        const saved = await manager.save(Task, newTask);
        if (files?.length) {
          const repo = manager.getRepository(File);
          await repo.save(
            files
              .filter((file) => file.path)
              .map((file) =>
                repo.create({
                  module: 'task',
                  task_id: saved.id,
                  file_path: file.path,
                }),
              ),
          );
        }
        await notifyTask(manager, saved, new Date(), true);
        return saved;
      },
    );

    const task = await this.taskRepo.findOne({
      where: { id: savedTask.id },
      relations: ['student', 'files', 'class'],
    });

    if (!task) {
      throw new NotFoundException('Task not found after saving');
    }

    await this.clearTaskCache(savedTask.id);
    return task;
  }

  // Multipart form-data serializes nested objects as JSON strings; accept both.
  private parseJsonMaybe<T>(value: T | string | undefined): T | undefined {
    if (value == null) return undefined;
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }

  private parseJsonArrayMaybe(value: unknown): string[] | undefined {
    if (value == null) return undefined;
    if (Array.isArray(value)) return value as string[];
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : undefined;
      } catch {
        // fallback: comma-separated form field
        return value
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
      }
    }
    return undefined;
  }

  private inferAssignmentMode(input: {
    student_id?: string;
    class_id?: string;
    normalizedStudentIds?: string[];
    normalizedClassIds?: string[];
  }) {
    if (input.normalizedClassIds && input.normalizedClassIds.length > 1)
      return 'multiple';
    if (
      input.class_id ||
      (input.normalizedClassIds && input.normalizedClassIds.length === 1)
    )
      return 'class';
    if (
      input.student_id ||
      (input.normalizedStudentIds && input.normalizedStudentIds.length)
    )
      return 'individual';
    return undefined;
  }

  private hasAssignment(input: {
    student_id?: string;
    class_id?: string;
    normalizedStudentIds?: string[];
    normalizedClassIds?: string[];
  }) {
    return Boolean(
      input.student_id ||
        input.class_id ||
        (input.normalizedStudentIds && input.normalizedStudentIds.length > 0) ||
        (input.normalizedClassIds && input.normalizedClassIds.length > 0),
    );
  }

  /** Draft tasks may be incomplete. Once a task is assigned, enforce the
   * same required wizard data even when a caller bypasses the web portal. */
  private assertReadyForAssignment(input: {
    name?: string;
    description?: string;
    subject?: string;
    deadline?: string | Date;
    settings?: unknown;
  }) {
    const missing: string[] = [];
    if (!input.name?.trim()) missing.push('task title');
    const description = String(input.description || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .trim();
    if (!description) missing.push('instructions');
    if (!input.subject?.trim()) missing.push('subject or task category');

    const deadline = input.deadline ? new Date(input.deadline) : null;
    if (!deadline || Number.isNaN(deadline.getTime())) missing.push('due date');

    const submissionSchedule = (input.settings as any)?.submission_schedule;
    const count = Number(submissionSchedule?.count);
    const dates = Array.isArray(submissionSchedule?.dates)
      ? submissionSchedule.dates
      : [];
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 52 ||
      dates.length !== count
    )
      missing.push('submission plan');
    else if (
      dates.some((date) => Number.isNaN(new Date(String(date)).getTime()))
    )
      missing.push('valid submission dates');

    if (missing.length)
      throw new BadRequestException({
        message: `Complete the task before assigning it: ${missing.join(', ')}`,
        missing,
      });
  }

  async findAll(): Promise<Task[]> {
    return this.cache.getOrSet(
      'tasks:all',
      this.taskListTtlSeconds,
      async () => {
        const tasks = await this.taskRepo.find({
          relations: ['student'],
          order: { created_at: 'DESC' },
        });
        await this.attachFiles(tasks);
        return tasks;
      },
    );
  }

  /**
   * Workload for students assigned to one task. A task counts as active until
   * completed; this includes overdue work because it still needs attention.
   */
  async getWorkload(taskId?: string) {
    return this.cache.getOrSet(
      taskId ? `tasks:${taskId}:workload` : 'tasks:workload:all',
      this.taskWorkloadTtlSeconds,
      () => this.getWorkloadUncached(taskId),
    );
  }

  private async getWorkloadUncached(taskId?: string) {
    const selectedTask = taskId
      ? await this.taskRepo.findOne({
          where: { id: taskId },
          relations: ['student'],
        })
      : null;
    if (taskId && !selectedTask) throw new NotFoundException('Task not found');

    const directStudentIds = new Set<string>([
      ...(selectedTask?.assignment_student_ids || []),
      ...(selectedTask?.student?.id ? [selectedTask.student.id] : []),
    ]);
    const selectedUsesClass = ['class', 'multiple'].includes(
      selectedTask?.assignment_mode || '',
    );
    const classIds = new Set<string>(
      selectedUsesClass
        ? [
            ...(selectedTask?.assignment_class_ids || []),
            ...(selectedTask?.class_id ? [selectedTask.class_id] : []),
          ]
        : [],
    );
    const activeEnrollments = await this.loadWorkloadEnrollments({
      taskId,
      classIds: [...classIds],
      directStudentIds: [...directStudentIds],
    });
    const targetStudents = new Map<string, any>();
    if (!taskId) {
      for (const enrollment of activeEnrollments) {
        if (enrollment.student?.id)
          targetStudents.set(enrollment.student.id, enrollment.student);
      }
    }
    for (const enrollment of activeEnrollments) {
      if (!classIds.has(enrollment.classId) || !enrollment.student?.id)
        continue;
      targetStudents.set(enrollment.student.id, enrollment.student);
    }
    if (directStudentIds.size) {
      for (const enrollment of activeEnrollments) {
        if (
          directStudentIds.has(enrollment.studentId) &&
          enrollment.student?.id
        )
          targetStudents.set(enrollment.student.id, enrollment.student);
      }
      const directStudents = await this.studentRepo.find({
        where: { id: In([...directStudentIds]) },
      });
      for (const student of directStudents)
        targetStudents.set(student.id, student);
    }
    if (selectedTask?.student?.id)
      targetStudents.set(selectedTask.student.id, selectedTask.student);

    const activeStatuses = new Set<string>(this.activeTaskStatuses);
    const threshold = 5;
    const now = new Date();
    const soon = new Date(now);
    soon.setDate(soon.getDate() + 7);
    const targetStudentIds = [...targetStudents.keys()];
    const targetClassIds = [
      ...new Set(
        activeEnrollments
          .filter((entry) => targetStudentIds.includes(entry.studentId))
          .map((entry) => entry.classId),
      ),
    ];
    const activeTasks = await this.loadActiveTasksForWorkload({
      targetStudentIds,
      targetClassIds,
      allStudents: !taskId,
    });
    const activeTaskIds = activeTasks.map((task) => task.id);
    const submissionSlots =
      targetStudentIds.length && activeTaskIds.length
        ? await this.submissionSlotRepo.find({
            where: {
              task_id: In(activeTaskIds),
              student_id: In(targetStudentIds),
            },
          })
        : [];
    const slotByTaskStudentRound = new Map(
      submissionSlots.map((slot) => [
        `${slot.task_id}:${slot.student_id}:${slot.schedule_index}`,
        slot,
      ]),
    );
    const roomsByStudentId = new Map<string, string[]>();
    const studentIdsByClassId = new Map<string, string[]>();
    for (const enrollment of activeEnrollments) {
      if (enrollment.class?.name) {
        const rooms = roomsByStudentId.get(enrollment.studentId) ?? [];
        rooms.push(enrollment.class.name);
        roomsByStudentId.set(enrollment.studentId, rooms);
      }

      const studentList = studentIdsByClassId.get(enrollment.classId) ?? [];
      studentList.push(enrollment.studentId);
      studentIdsByClassId.set(enrollment.classId, studentList);
    }

    const activeTasksByStudentId = new Map<string, Task[]>();
    const pushTaskForStudent = (studentId: string, task: Task) => {
      if (!targetStudents.has(studentId)) return;
      const list = activeTasksByStudentId.get(studentId) ?? [];
      if (!list.some((existing) => existing.id === task.id)) list.push(task);
      activeTasksByStudentId.set(studentId, list);
    };

    for (const task of activeTasks) {
      if (!activeStatuses.has(task.status)) continue;
      for (const studentId of task.assignment_student_ids || []) {
        pushTaskForStudent(studentId, task);
      }
      if (task.student?.id) {
        pushTaskForStudent(task.student.id, task);
      }

      const taskUsesClass = ['class', 'multiple'].includes(
        task.assignment_mode || '',
      );
      if (!taskUsesClass) continue;

      const taskClassIds = [
        ...(task.assignment_class_ids || []),
        ...(task.class_id ? [task.class_id] : []),
      ];
      for (const classId of taskClassIds) {
        for (const studentId of studentIdsByClassId.get(classId) ?? []) {
          pushTaskForStudent(studentId, task);
        }
      }
    }

    const students = [...targetStudents.values()].map((student) => {
      const active = activeTasksByStudentId.get(student.id) ?? [];
      const dueSoon = active.filter(
        (task) => task.deadline >= now && task.deadline <= soon,
      );
      const rooms = roomsByStudentId.get(student.id) ?? [];
      return {
        id: student.id,
        student_id: student.student_id,
        first_name_eng: student.first_name_eng,
        last_name_eng: student.last_name_eng,
        first_name_lao: student.first_name_lao,
        last_name_lao: student.last_name_lao,
        active_task_count: active.length,
        due_soon_count: dueSoon.length,
        estimated_minutes: active.reduce(
          (sum, task) => sum + (Number(task.estimated_time_minutes) || 0),
          0,
        ),
        class_name: rooms.join(', ') || 'No class',
        assigned_tasks: active.map((task) => ({
          id: task.id,
          title: task.name || 'Untitled task',
          submission_plan: (Array.isArray(
            (task.settings as any)?.submission_schedule?.dates,
          )
            ? (task.settings as any).submission_schedule.dates
            : task.deadline
              ? [task.deadline.toISOString().slice(0, 10)]
              : []
          ).map((date: string, index: number) => {
            const slot = slotByTaskStudentRound.get(
              `${task.id}:${student.id}:${index + 1}`,
            );
            const dueAt =
              slot?.due_at ??
              new Date(`${date}T${task.due_time || '23:59'}:00`);
            const isPastDue = dueAt < now;
            const lateAllowed = task.settings?.allow_late_submission === true;
            const submittedAt = slot?.submitted_at
              ? new Date(slot.submitted_at)
              : null;
            // Keep the workload chips aligned with Task Submission: a
            // reviewed round is still late when its original upload was
            // after the round deadline.
            const status =
              slot?.status === 'missed'
                ? 'missed'
                : submittedAt
                  ? submittedAt.getTime() < dueAt.getTime()
                    ? 'early'
                    : submittedAt.getTime() > dueAt.getTime()
                      ? 'late'
                      : 'on_time'
                  : isPastDue && !lateAllowed
                    ? 'missed'
                    : 'pending';
            return {
              date,
              due_at: dueAt,
              submitted_at: slot?.submitted_at ?? null,
              status,
            };
          }),
        })),
        overload: active.length >= threshold,
      };
    });
    return { overload_threshold: threshold, students };
  }

  async findOne(id: string): Promise<Task> {
    return this.cache.getOrSet(`tasks:${id}`, this.taskDetailTtlSeconds, () =>
      this.findOneUncached(id),
    );
  }

  private async findOneUncached(id: string): Promise<Task> {
    const task = await this.taskRepo.findOne({
      where: { id },
      relations: ['student'],
    });

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    await this.attachFiles([task]);
    return task; // ตอนนี้ guaranteed non-null
  }

  private async attachFiles(tasks: Task[]) {
    if (!tasks.length) return;

    const taskIds = tasks.map((task) => task.id);
    const files = await this.fileRepo.find({
      where: {
        task_id: In(taskIds),
        is_deleted: false,
      },
      order: { created_at: 'ASC' },
    });

    const filesByTaskId = new Map<string, File[]>();
    for (const file of files) {
      if (!file.task_id) continue;
      const list = filesByTaskId.get(file.task_id) ?? [];
      list.push(file);
      filesByTaskId.set(file.task_id, list);
    }

    for (const task of tasks) {
      task.files = filesByTaskId.get(task.id) ?? [];
    }
  }

  async update(
    id: string,
    data: UpdateTaskDto,
    files?: Express.Multer.File[], // รับไฟล์ใหม่จาก frontend
  ): Promise<Task> {
    const updatedTask = await this.taskRepo.manager.transaction(
      async (manager) => {
        const locked = await manager.findOne(Task, {
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!locked) throw new NotFoundException('Task not found');
        const task = await manager.findOne(Task, {
          where: { id },
          relations: ['student'],
        });
        if (!task) throw new NotFoundException('Task not found');

        const {
          student_id,
          class_id,
          deadline,
          start_date,
          reminders,
          settings,
          assignment_student_ids,
          assignment_class_ids,
          ...rest
        } = data;

        // ถ้ามี student_id ให้ map ไปยัง relation
        if (student_id) {
          task.student = { id: student_id } as any;
        }

        if (class_id) {
          task.class = { id: class_id } as any;
        }

        // แปลง deadline/start_date ถ้าเป็น string ให้เป็น Date
        if (deadline) {
          task.deadline = new Date(deadline);
        }
        if (start_date) {
          task.start_date = new Date(start_date);
        }

        // Multipart bodies arrive as strings — normalize the same way create() does.
        const normalizedReminders = this.parseJsonMaybe(reminders);
        if (normalizedReminders !== undefined)
          task.reminders = normalizedReminders;

        const normalizedSettings = this.parseJsonMaybe(settings);
        if (normalizedSettings !== undefined)
          task.settings = normalizedSettings;

        const normalizedStudentIds = this.parseJsonArrayMaybe(
          assignment_student_ids,
        );
        if (normalizedStudentIds !== undefined)
          task.assignment_student_ids = normalizedStudentIds;

        const normalizedClassIds =
          this.parseJsonArrayMaybe(assignment_class_ids);
        if (normalizedClassIds !== undefined)
          task.assignment_class_ids = normalizedClassIds;

        if (data.status === 'assigned') {
          const hasNextAssignment = this.hasAssignment({
            student_id: student_id ?? task.student?.id,
            class_id: class_id ?? task.class_id,
            normalizedStudentIds:
              normalizedStudentIds ?? task.assignment_student_ids,
            normalizedClassIds: normalizedClassIds ?? task.assignment_class_ids,
          });
          if (!hasNextAssignment)
            throw new BadRequestException(
              'Task must be assigned to at least one student or class.',
            );
          this.assertReadyForAssignment({
            name: data.name ?? task.name,
            description: data.description ?? task.description,
            subject: data.subject ?? task.subject,
            deadline: deadline ?? task.deadline,
            settings: normalizedSettings ?? task.settings,
          });
        }

        // update field อื่น ๆ (name, description, status, subject, difficulty,
        // estimated_time_minutes, points, assignment_mode, due_time, visibility, ...)
        Object.assign(task, rest);
        const saved = await manager.save(Task, task);
        if (files?.length) {
          const repo = manager.getRepository(File);
          await repo.save(
            files
              .filter((file) => file.path)
              .map((file) =>
                repo.create({
                  module: 'task',
                  task_id: saved.id,
                  file_path: file.path,
                }),
              ),
          );
        }
        await notifyTask(manager, saved, new Date(), true);
        return saved;
      },
    );

    await this.clearTaskCache(id);
    return updatedTask;
  }

  async delete(id: string): Promise<{ message: string }> {
    const task = await this.findOneUncached(id); // findOne throws NotFoundException

    // 1️⃣ ดึงไฟล์ทั้งหมดที่เกี่ยวข้องกับ Task
    const files = await this.fileService.findByModuleAndOwner('task', id);

    // 2️⃣ ลบไฟล์ทั้งหมด (soft delete)
    for (const file of files) {
      await this.fileService.softDelete(file.id);
    }

    // 3️⃣ ลบ Task
    await this.taskRepo.remove(task);

    await this.clearTaskCache(id);
    return { message: 'Task and its files deleted' };
  }

  private async loadWorkloadEnrollments(input: {
    taskId?: string;
    classIds: string[];
    directStudentIds: string[];
  }): Promise<Enrollment[]> {
    if (!input.taskId) {
      return this.enrollmentRepo.find({
        where: { is_active: true },
        relations: ['student', 'class'],
      });
    }

    const where: any[] = [];
    if (input.classIds.length) {
      where.push({ classId: In(input.classIds), is_active: true });
    }
    if (input.directStudentIds.length) {
      where.push({ studentId: In(input.directStudentIds), is_active: true });
    }
    if (!where.length) return [];

    return this.enrollmentRepo.find({
      where,
      relations: ['student', 'class'],
    });
  }

  private async loadActiveTasksForWorkload(input: {
    targetStudentIds: string[];
    targetClassIds: string[];
    allStudents: boolean;
  }): Promise<Task[]> {
    if (input.allStudents) {
      return this.taskRepo.find({
        where: { status: In([...this.activeTaskStatuses]) },
        relations: ['student'],
      });
    }

    if (!input.targetStudentIds.length && !input.targetClassIds.length) {
      return [];
    }

    const qb = this.taskRepo
      .createQueryBuilder('task')
      .leftJoinAndSelect('task.student', 'student')
      .where('task.status IN (:...statuses)', {
        statuses: [...this.activeTaskStatuses],
      })
      .andWhere(
        new Brackets((scope) => {
          if (input.targetStudentIds.length) {
            scope.orWhere('student.id IN (:...targetStudentIds)', {
              targetStudentIds: input.targetStudentIds,
            });
            scope.orWhere('task.assignment_student_ids ?| :targetStudentIds', {
              targetStudentIds: input.targetStudentIds,
            });
          }
          if (input.targetClassIds.length) {
            scope.orWhere('task.class_id IN (:...targetClassIds)', {
              targetClassIds: input.targetClassIds,
            });
            scope.orWhere('task.assignment_class_ids ?| :targetClassIds', {
              targetClassIds: input.targetClassIds,
            });
          }
        }),
      );

    return qb.getMany();
  }

  private async clearTaskCache(id?: string): Promise<void> {
    await this.cache.delPattern('tasks:*');
    if (id) {
      await this.cache.del(`tasks:${id}`);
      await this.cache.del(`tasks:${id}:workload`);
    }
  }
}
