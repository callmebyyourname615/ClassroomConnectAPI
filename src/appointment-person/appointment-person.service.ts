// ============================================================
// FILE: src/appointment-person/appointment-person.service.ts
// ============================================================
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { CheckConflictsDto } from './dto/check-conflicts.dto';

import { AppointmentParticipant } from '../appointment/dto/appointment-participant.entity';
import { CreateAppointmentPersonDto } from './dto/create-appointment-person.dto';
import { UpdateAppointmentPersonDto } from './dto/update-appointment-person.dto';
import { notifyAppointment } from '../appointment/appointment-notification';
import { Appointment } from '../appointment/appointment.entity';
import { Branch } from '../branches/branch.entity';
import { AcademicYear } from '../academic_years/academic-year.entity';
import { ParticipantStatus, PersonType } from '../appointment/appointment.enum';

@Injectable()
export class AppointmentPersonService {
  constructor(
    @InjectRepository(AppointmentParticipant)
    private repo: Repository<AppointmentParticipant>,

    @InjectRepository(Appointment)
    private appointmentRepo: Repository<Appointment>,

    @InjectRepository(Branch)
    private branchRepo: Repository<Branch>,

    @InjectRepository(AcademicYear)
    private yearRepo: Repository<AcademicYear>,
  ) {}

  private normalizePersonType(value: string): PersonType {
    const normalized = String(value || '').toUpperCase();
    if (normalized === 'PARENT') return PersonType.PARENT;
    if (normalized === 'TEACHER') return PersonType.TEACHER;
    if (
      normalized === 'ADMIN' ||
      normalized === 'STAFF' ||
      normalized === 'OTHER'
    )
      return PersonType.ADMIN;
    if (normalized === 'SUPER_ADMIN') return PersonType.SUPER_ADMIN;
    if (normalized === 'SUPER_SUPER_ADMIN') return PersonType.SUPER_SUPER_ADMIN;
    return normalized as PersonType;
  }

  private normalizeStatus(value?: string): ParticipantStatus | undefined {
    return value
      ? (String(value).toUpperCase() as ParticipantStatus)
      : undefined;
  }

  private normalizeDate(value: Date | string | null | undefined): string {
    if (!value) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
  }

  private async findPersonConflict(
    personId: string,
    date: Date | string,
    fromTime: string,
    toTime: string,
  ) {
    const result = await this.checkConflicts({
      date: this.normalizeDate(date),
      from_time: fromTime,
      to_time: toTime,
      person_ids: [personId],
    });

    return result.conflicts[0]?.appointment;
  }

  async create(dto: CreateAppointmentPersonDto) {
    const branch = await this.branchRepo.findOne({
      where: { id: dto.branch_id },
    });
    if (!branch) throw new NotFoundException('Branch not found');

    const appointment = await this.appointmentRepo.findOne({
      where: { id: dto.appointment_id },
    });
    if (!appointment) throw new NotFoundException('Appointment not found');

    if (appointment.date && appointment.from_time && appointment.to_time) {
      const conflict = await this.findPersonConflict(
        dto.person_id,
        appointment.date,
        appointment.from_time,
        appointment.to_time,
      );
      if (conflict) {
        throw new BadRequestException({
          message:
            'This person already has an appointment during the selected time.',
          conflict: {
            appointment_id: conflict.id,
            title: conflict.title,
            date: this.normalizeDate(conflict.date),
            from_time: conflict.from_time,
            to_time: conflict.to_time,
          },
        });
      }
    }

    const year = await this.yearRepo.findOne({
      where: { id: dto.academic_year_id },
    });
    if (!year) throw new NotFoundException('Academic Year not found');

    // ✅ Fixed: explicitly map fields instead of spreading dto
    // This ensures person_type is cast to enum, not left as plain string
    const ap = this.repo.create({
      id: randomUUID().replace(/-/g, '').slice(0, 24),
      appointment_id: dto.appointment_id,
      branch_id: dto.branch_id,
      academic_year_id: dto.academic_year_id,
      person_id: dto.person_id,
      person_type: this.normalizePersonType(dto.person_type),
      status: this.normalizeStatus(dto.status),
      response_note: dto.notes,
      declined_count: dto.declined_count ?? 0,
      reschedule_count: dto.rescheduled_count ?? 0,
      is_active: dto.is_active ?? true,
      is_deleted: false,
    });

    return this.repo.manager.transaction(async (manager) => {
      const saved = await manager.save(AppointmentParticipant, ap);
      await notifyAppointment(manager, appointment, 'created', [saved]);
      return saved;
    });
  }

  async findAll() {
    return this.repo.find({ where: { is_deleted: false } });
  }

  async findOne(id: string) {
    const ap = await this.repo.findOne({ where: { id, is_deleted: false } });
    if (!ap) throw new NotFoundException('AppointmentPerson not found');
    return ap;
  }

  async findByAppointment(appointmentId: string) {
    return this.repo.find({
      where: { appointment_id: appointmentId, is_deleted: false },
    });
  }

  async findByAppointmentBody(appointmentId: string) {
    return this.repo.find({
      where: { appointment_id: appointmentId, is_deleted: false },
    });
  }

  async findByBranch(branchId: string) {
    return this.repo.find({
      where: { branch_id: branchId, is_deleted: false },
    });
  }

  async update(id: string, dto: UpdateAppointmentPersonDto) {
    const existing = await this.findOne(id);
    const previousRescheduleCount = Number(existing.reschedule_count ?? 0);
    const previousStatus = String(existing.status || '').toUpperCase();

    // ✅ Fixed: assign fields explicitly to preserve enum types
    if (dto.appointment_id) existing.appointment_id = dto.appointment_id;
    if (dto.person_id) existing.person_id = dto.person_id;
    if (dto.person_type)
      existing.person_type = this.normalizePersonType(dto.person_type);
    if (dto.status) existing.status = this.normalizeStatus(dto.status);
    if (dto.notes !== undefined) existing.response_note = dto.notes;
    if (dto.branch_id) existing.branch_id = dto.branch_id;
    if (dto.academic_year_id) existing.academic_year_id = dto.academic_year_id;
    if (dto.is_active !== undefined) existing.is_active = dto.is_active;
    if (dto.declined_count !== undefined)
      existing.declined_count = dto.declined_count;
    if (dto.rescheduled_count !== undefined)
      existing.reschedule_count = dto.rescheduled_count;

    const nextStatus = String(existing.status || '').toUpperCase();
    const nextRescheduleCount = Number(existing.reschedule_count ?? 0);
    const statusChanged = !!dto.status && nextStatus !== previousStatus;
    const shouldRecordResponse =
      ['ACCEPTED', 'DECLINED'].includes(nextStatus) ||
      (nextStatus === 'RESCHEDULED' &&
        nextRescheduleCount > previousRescheduleCount);

    if (statusChanged && shouldRecordResponse) {
      const now = new Date();
      existing.responded_at = now;
      const current = Array.isArray(existing.response_history)
        ? existing.response_history
        : [];
      existing.response_history = [
        ...current,
        {
          action: nextStatus,
          status: nextStatus,
          person_id: existing.person_id,
          person_type: existing.person_type,
          appointment_id: existing.appointment_id,
          event_at: now.toISOString(),
          responded_at: now.toISOString(),
          response_note: existing.response_note ?? null,
          reschedule_count: nextRescheduleCount,
        },
      ];
    }

    return this.repo.manager.transaction(async (manager) => {
      const saved = await manager.save(AppointmentParticipant, existing);
      if (statusChanged && ['ACCEPTED', 'DECLINED'].includes(nextStatus)) {
        const appointment = await manager.findOne(Appointment, {
          where: { id: saved.appointment_id! },
        });
        if (appointment)
          await notifyAppointment(
            manager,
            appointment,
            nextStatus === 'ACCEPTED' ? 'accepted' : 'declined',
            [saved],
            saved,
          );
      }
      return saved;
    });
  }

  async softDelete(id: string) {
    const ap = await this.findOne(id);
    return this.repo.manager.transaction(async (manager) => {
      const appointment = await manager.findOne(Appointment, {
        where: { id: ap.appointment_id! },
      });
      if (appointment && ap.status !== ParticipantStatus.DECLINED)
        await notifyAppointment(manager, appointment, 'declined', [ap], ap);
      ap.is_deleted = true;
      ap.is_active = false;
      return manager.save(AppointmentParticipant, ap);
    });
  }

  async checkConflicts(dto: CheckConflictsDto) {
    if (!dto.person_ids || dto.person_ids.length === 0) {
      return { conflicts: [] };
    }

    // Step 1: find appointment_persons for these people (any type)
    const records = await this.repo.find({
      where: {
        person_id: In(dto.person_ids),
        is_deleted: false,
      },
    });

    if (!records.length) return { conflicts: [] };

    const appointmentIds = [
      ...new Set(records.map((r) => r.appointment_id).filter(Boolean)),
    ] as string[];

    if (!appointmentIds.length) return { conflicts: [] };

    // Step 2: find appointments on the same date whose time overlaps
    // Let PostgreSQL do all comparisons — avoids JS string / Date format issues
    const overlapping = await this.appointmentRepo
      .createQueryBuilder('appt')
      .where('appt.id IN (:...ids)', { ids: appointmentIds })
      .andWhere('appt.date = :date', { date: dto.date })
      .andWhere('appt.from_time < :to_time', { to_time: dto.to_time })
      .andWhere('appt.to_time > :from_time', { from_time: dto.from_time })
      .andWhere('appt.is_deleted = false')
      .getMany();

    if (!overlapping.length) return { conflicts: [] };

    const overlappingIds = new Set(overlapping.map((a) => a.id));

    const conflicts = records
      .filter((r) => r.appointment_id && overlappingIds.has(r.appointment_id))
      .map((r) => ({
        person_id: r.person_id,
        appointment: overlapping.find((a) => a.id === r.appointment_id),
      }));

    return { conflicts };
  }
}
