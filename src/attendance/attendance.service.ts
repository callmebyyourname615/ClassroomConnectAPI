// src/attendance/attendance.service.ts

import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Attendance, AttendanceType } from './attendance.entity';
import { Student } from '../students/student.entity';
import { AttendanceRule } from './attendance_rules';
import { CacheService } from '../common/cache.service';
import { Notification } from '../notifications/notification.entity';

export const ATTENDANCE_TIME_ZONE = 'Asia/Vientiane';

export function attendanceLocalDateKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ATTENDANCE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${value('year')}-${value('month')}-${value('day')}`;
}

@Injectable()
export class AttendanceService {
  constructor(
    @InjectRepository(Attendance)
    private repo: Repository<Attendance>,

    @InjectRepository(AttendanceRule)
    private ruleRepo: Repository<AttendanceRule>,

    @InjectRepository(Student)
    private studentRepo: Repository<Student>,

    private readonly cache: CacheService,
  ) {}

  private readonly attendanceListTtlSeconds = 45;
  private readonly attendanceDetailTtlSeconds = 120;

  private async saveWithNotification(
    attendance: Attendance,
    patch?: Partial<Attendance>,
    scan = false,
  ) {
    return this.repo.manager.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `attendance:${attendance.student_id}:${attendance.attendance_date}`,
      ]);
      const repository = manager.getRepository(Attendance);
      const previous = await repository.findOne({
        where: {
          student_id: attendance.student_id,
          attendance_date: attendance.attendance_date,
        },
      });
      if (scan && previous?.check_in) {
        throw new ConflictException(
          'This student has already been checked in today.',
        );
      }
      if (previous && !attendance.id && !scan) {
        throw new ConflictException(
          'Attendance already exists for this student and date.',
        );
      }
      if (previous && patch)
        attendance = repository.create({ ...previous, ...patch });
      // Compare normalized times: PostgreSQL returns HH:mm:ss even for HH:mm input.
      const time = (value?: string | null) =>
        !value ? null : value.length === 5 ? `${value}:00` : value;
      const snapshot = (row?: Attendance | null) =>
        row &&
        JSON.stringify([
          row.type,
          time(row.check_in),
          time(row.check_out),
          row.reason || null,
          row.remark || null,
          row.check_out_remark || null,
        ]);
      const changed = snapshot(previous) !== snapshot(attendance);
      const saved = await repository.save(attendance);
      if (!changed) return saved;
      const student = await manager.getRepository(Student).findOne({
        where: { id: saved.student_id, is_deleted: false },
        relations: ['parents'],
      });
      if (!student) return saved;
      const recipients = [
        ...new Set(
          (student.parents || [])
            .filter((parent) => parent.isActive !== false)
            .map((parent) => parent.id),
        ),
      ];
      if (!recipients.length) return saved;
      const event =
        saved.check_out && time(saved.check_out) !== time(previous?.check_out)
          ? 'check_out'
          : saved.check_in && !previous?.check_in
            ? 'check_in'
            : 'updated';
      const studentName = [
        student.first_name_lao || student.first_name_eng,
        student.last_name_lao || student.last_name_eng,
      ]
        .filter(Boolean)
        .join(' ');
      const metadata = {
        type: 'attendance',
        event,
        attendanceId: saved.id,
        studentId: student.id,
        studentName,
        attendanceDate: saved.attendance_date,
        status: saved.type,
        checkIn: saved.check_in || null,
        checkOut: saved.check_out || null,
        reason: saved.reason || null,
        remark: saved.remark || null,
        checkOutRemark: saved.check_out_remark || null,
      };
      const notifications = manager.getRepository(Notification);
      await notifications.save(
        recipients.map((parentId) =>
          notifications.create({
            parent_id: parentId,
            student_id: student.id,
            branch_id: student.branchId || undefined,
            module_type: 'ATTENDANCE',
            module_id: saved.id,
            seen: 0,
            clicked: 0,
            title: 'Attendance update',
            message: `${studentName}\n${saved.attendance_date}: ${saved.type}\nCheck in: ${saved.check_in || '-'}\nCheck out: ${saved.check_out || '-'}`,
            metadata,
          }),
        ),
      );
      return saved;
    });
  }

  // =====================================================
  // QR SCAN (CHECK-IN)
  // =====================================================
  async scan(dto: {
    studentId: string;
    attendanceDate: string;
    deviceTime?: string;
  }) {
    // Validate UUID format before hitting the DB
    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!dto.studentId || !uuidRe.test(dto.studentId)) {
      throw new BadRequestException(
        'Invalid student QR code. Please scan a valid student card.',
      );
    }
    if (
      !dto.attendanceDate ||
      !/^\d{4}-\d{2}-\d{2}$/.test(dto.attendanceDate)
    ) {
      throw new BadRequestException(
        'Invalid attendance date format. Expected YYYY-MM-DD.',
      );
    }

    const levelId = await this.getStudentLevelId(
      dto.studentId,
      'Student not found. This QR code may be outdated.',
    );

    if (!levelId) throw new BadRequestException('Student level not found');

    const day = new Date(dto.attendanceDate)
      .toLocaleDateString('en-US', { weekday: 'long' })
      .toLowerCase();

    const rule = await this.getAttendanceRule(levelId, day);

    if (!rule) throw new BadRequestException('Rule not found');

    const now = dto.deviceTime ?? this.nowTime();

    let attendance = await this.repo.findOne({
      where: {
        student_id: dto.studentId,
        attendance_date: dto.attendanceDate,
      },
    });

    // Already checked in today — block duplicate scan
    if (attendance?.check_in) {
      throw new ConflictException({
        message: 'This student has already been checked in today.',
        check_in: attendance.check_in,
        type: attendance.type,
        remark: attendance.remark,
      });
    }

    if (!attendance) {
      attendance = this.repo.create({
        student_id: dto.studentId,
        attendance_date: dto.attendanceDate,
      });
    }

    attendance.check_in = now;

    const current = this.toMinutes(now);
    const start = this.toMinutes(rule.checkInStart);
    const late = this.toMinutes(rule.lateAfter);

    if (current < start) {
      attendance.type = AttendanceType.PRESENT;
      attendance.remark = 'EARLY';
    } else if (current <= late) {
      attendance.type = AttendanceType.PRESENT;
      attendance.remark = 'ON_TIME';
    } else {
      attendance.type = AttendanceType.LATE;
      attendance.remark = 'LATE';
    }

    const saved = await this.saveWithNotification(
      attendance,
      {
        check_in: attendance.check_in,
        type: attendance.type,
        remark: attendance.remark,
      },
      true,
    );
    await this.clearAttendanceCache(saved.id);
    return saved;
  }

  // =====================================================
  // CHECKOUT
  // =====================================================
  async checkout(dto: {
    studentId: string;
    attendanceDate: string;
    deviceTime?: string;
  }) {
    dto.studentId = await this.resolveStudentId(dto.studentId);

    // ── 1. Load only the level needed by the rule engine ──────────────────
    const levelId = await this.getStudentLevelId(
      dto.studentId,
      'Student not found',
    );
    if (!levelId) throw new BadRequestException('Student level not found');

    // ── 2. Load rule for the day ──────────────────────────────────────────
    const day = new Date(dto.attendanceDate)
      .toLocaleDateString('en-US', { weekday: 'long' })
      .toLowerCase();

    const rule = await this.getAttendanceRule(levelId, day);

    if (!rule) throw new BadRequestException('Rule not found');

    // ── 3. Find existing check-in record ──────────────────────────────────
    const attendance = await this.repo.findOne({
      where: {
        student_id: dto.studentId,
        attendance_date: dto.attendanceDate,
      },
    });

    if (!attendance) throw new NotFoundException('Check-in record not found');

    // ── 4. Rule engine (mirrors scan logic) ───────────────────────────────
    const now = dto.deviceTime ?? this.nowTime();
    const current = this.toMinutes(now);
    const early = this.toMinutes(rule.earlyBefore); // e.g. 14:00
    const end = this.toMinutes(rule.checkOutEnd); // e.g. 15:30

    if (current < early) {
      attendance.check_out_remark = 'EARLY_CHECKOUT';
    } else if (current <= end) {
      attendance.check_out_remark = 'ON_TIME';
    } else {
      attendance.check_out_remark = 'LATE_CHECKOUT';
    }

    attendance.check_out = now;

    const saved = await this.saveWithNotification(attendance, {
      check_out: attendance.check_out,
      check_out_remark: attendance.check_out_remark,
    });
    await this.clearAttendanceCache(saved.id);
    return saved;
  }

  // =====================================================
  // ADMIN OVERRIDE
  // =====================================================
  async adminUpdate(id: string, dto: Partial<Attendance>) {
    const attendance = await this.repo.findOne({ where: { id } });

    if (!attendance) throw new NotFoundException('Not found');

    Object.assign(attendance, dto);

    const saved = await this.saveWithNotification(attendance, dto);
    await this.clearAttendanceCache(saved.id);
    return saved;
  }

  // =====================================================
  // 🔵 AUTO ABSENT (CRON SUPPORT)
  // =====================================================
  async markAbsent(date: string, clearCache = true) {
    if (this.isFutureDate(date)) return;

    await this.repo.query(
      `
        INSERT INTO "attendances" (
          "student_id",
          "attendance_date",
          "type",
          "scan_method",
          "remark",
          "created_at",
          "updated_at"
        )
        SELECT
          "students"."id",
          $1::date,
          $2,
          'QR',
          'AUTO ABSENT (NO SCAN)',
          NOW(),
          NOW()
        FROM "students"
        WHERE "students"."is_deleted" = false
          AND NOT EXISTS (
          SELECT 1
          FROM "attendances"
          WHERE "attendances"."student_id" = "students"."id"
            AND "attendances"."attendance_date" = $1::date
        )
        ON CONFLICT ("student_id", "attendance_date") DO NOTHING
      `,
      [date, AttendanceType.ABSENT],
    );
    if (clearCache) await this.clearAttendanceCache();
  }

  // =====================================================
  // HELPERS
  // =====================================================
  private async resolveStudentId(input: string): Promise<string> {
    const raw = String(input || '').trim();
    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRe.test(raw)) {
      const student = await this.studentRepo.findOne({
        where: { id: raw, is_deleted: false },
        select: ['id'],
      });
      if (student?.id) {
        return student.id;
      }
      throw new BadRequestException(
        'Invalid student QR code. Student not found or deleted.',
      );
    }
    const student = await this.studentRepo.findOne({
      where: { student_id: raw, is_deleted: false },
      select: ['id'],
    });
    if (student?.id) {
      return student.id;
    }
    throw new BadRequestException(
      'Invalid student QR code. Please scan a valid student card.',
    );
  }

  private async getStudentLevelId(
    studentId: string,
    notFoundMessage: string,
  ): Promise<string | null> {
    const row = await this.studentRepo
      .createQueryBuilder('student')
      .leftJoin('student.enrollments', 'enrollment')
      .leftJoin('enrollment.class', 'class')
      .leftJoin('class.yearLevel', 'yearLevel')
      .leftJoin('yearLevel.level', 'level')
      .select('student.id', 'student_id')
      .addSelect('level.id', 'level_id')
      .where('student.id = :studentId', { studentId })
      .getRawOne<{ student_id: string; level_id: string | null }>();

    if (!row) throw new NotFoundException(notFoundMessage);
    return row.level_id ?? null;
  }

  private async getAttendanceRule(levelId: string, dayOfWeek: string) {
    return this.cache.getOrSet(
      `attendance-rule:${levelId}:${dayOfWeek}`,
      600,
      () => this.ruleRepo.findOne({ where: { levelId, dayOfWeek } }),
    );
  }

  private toMinutes(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  }

  private nowTime(): string {
    return new Date().toTimeString().slice(0, 8);
  }

  // =====================================================
  // CRUD
  // =====================================================
  async create(dto: Partial<Attendance>) {
    const saved = await this.saveWithNotification(this.repo.create(dto));
    await this.clearAttendanceCache(saved.id);
    return saved;
  }

  async findAll(filters?: {
    startDate?: string;
    endDate?: string;
    classId?: string;
    branchId?: string;
  }) {
    const today = attendanceLocalDateKey();

    // Determine the single date being queried (if any)
    const singleDate =
      filters?.startDate &&
      filters?.endDate &&
      filters.startDate === filters.endDate
        ? filters.startDate
        : !filters?.startDate && !filters?.endDate
          ? today
          : null;

    // Auto-mark absent for the queried date (today or any specific past date)
    if (singleDate) {
      await this.ensureAbsentMarked(singleDate);
    }

    return this.cache.getOrSet(
      `attendances:list:${this.stableCacheKey({
        startDate: filters?.startDate,
        endDate: filters?.endDate,
        classId: filters?.classId,
        branchId: filters?.branchId,
      })}`,
      this.attendanceListTtlSeconds,
      async () => {
        const qb = this.repo
          .createQueryBuilder('attendance')
          .innerJoinAndSelect(
            'attendance.student',
            'student',
            '(student.is_deleted = false OR student.is_deleted IS NULL)',
          )
          .leftJoinAndSelect('student.enrollments', 'enrollment')
          .leftJoinAndSelect('enrollment.class', 'class')
          .leftJoinAndSelect('class.yearLevel', 'yearLevel')
          .leftJoinAndSelect('yearLevel.level', 'level');
        qb.where('student.is_deleted = false');

        if (singleDate) {
          qb.andWhere('attendance.attendance_date = :singleDate', {
            singleDate,
          });
        } else if (filters?.startDate && filters?.endDate) {
          qb.andWhere(
            'attendance.attendance_date BETWEEN :startDate AND :endDate',
            {
              startDate: filters.startDate,
              endDate: filters.endDate,
            },
          );
        } else if (filters?.startDate) {
          qb.andWhere('attendance.attendance_date >= :startDate', {
            startDate: filters.startDate,
          });
        } else if (filters?.endDate) {
          qb.andWhere('attendance.attendance_date <= :endDate', {
            endDate: filters.endDate,
          });
        }

        qb.andWhere(
          '(student.is_deleted = false OR student.is_deleted IS NULL)',
        );

        const normalizedClassId = filters?.classId?.trim();
        if (normalizedClassId) {
          qb.andWhere('enrollment.class_id = :classId', {
            classId: normalizedClassId,
          });
        }

        const normalizedBranchId = filters?.branchId?.trim();
        if (normalizedBranchId) {
          qb.andWhere('student.branch_id = :branchId', {
            branchId: normalizedBranchId,
          });
        }

        return qb
          .orderBy('attendance.attendance_date', 'DESC')
          .addOrderBy('attendance.created_at', 'DESC')
          .getMany();
      },
    );
  }

  async findOne(id: string) {
    return this.cache.getOrSet(
      `attendances:${id}`,
      this.attendanceDetailTtlSeconds,
      () => this.findOneUncached(id),
    );
  }

  private async findOneUncached(id: string) {
    const attendance = await this.repo.findOne({ where: { id } });

    if (!attendance) throw new NotFoundException('Attendance not found');

    return attendance;
  }

  async update(id: string, dto: Partial<Attendance>) {
    const attendance = await this.findOneUncached(id);
    Object.assign(attendance, dto);
    const saved = await this.saveWithNotification(attendance, dto);
    await this.clearAttendanceCache(saved.id);
    return saved;
  }

  async remove(id: string) {
    const attendance = await this.findOneUncached(id);
    const removed = await this.repo.remove(attendance);
    await this.clearAttendanceCache(id);
    return removed;
  }

  private async clearAttendanceCache(id?: string): Promise<void> {
    await Promise.all([
      this.cache.delPattern('attendances:list:*'),
      id ? this.cache.del(`attendances:${id}`) : Promise.resolve(),
    ]);
  }

  private async ensureAbsentMarked(date: string): Promise<void> {
    if (this.isFutureDate(date)) return;

    await this.cache.getOrSet(
      `attendances:auto-absent:${date}`,
      this.attendanceListTtlSeconds,
      async () => {
        await this.markAbsent(date, false);
        return true;
      },
    );
  }

  private stableCacheKey(value: Record<string, unknown>): string {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined && item !== null && item !== '')
      .sort(([left], [right]) => left.localeCompare(right));

    if (!entries.length) return 'default';

    return entries
      .map(([key, item]) => `${key}=${String(item).trim()}`)
      .join(':');
  }

  private isFutureDate(date: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && date > attendanceLocalDateKey();
  }
}
