// ============================================================
// FILE: src/appointment/appointment.service.ts
// ============================================================
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { Appointment } from './appointment.entity';
import { Branch } from '../branches/branch.entity';
import { AcademicYear } from '../academic_years/academic-year.entity';

import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { RespondAppointmentDto } from './dto/respond-appointment.dto';
import { CreatorRescheduleDto } from './dto/creator-reschedule.dto';

import {
  AppointmentStatus,
  ParticipantStatus,
  PersonType,
} from './appointment.enum';
import { AppointmentParticipant } from './dto/appointment-participant.entity';
import { notifyAppointment } from './appointment-notification';
import { CacheService } from '../common/cache.service';

@Injectable()
export class AppointmentService {
  constructor(
    @InjectRepository(Appointment)
    private repo: Repository<Appointment>,

    @InjectRepository(AppointmentParticipant)
    private participantRepo: Repository<AppointmentParticipant>,

    @InjectRepository(Branch)
    private branchRepo: Repository<Branch>,

    @InjectRepository(AcademicYear)
    private yearRepo: Repository<AcademicYear>,

    private dataSource: DataSource,
    private readonly cache: CacheService,
  ) {}

  private readonly appointmentRelations = [
    'branch',
    'academicYear',
    'participants',
  ] as const;

  private readonly appointmentListTtlSeconds = 60;
  private readonly appointmentDetailTtlSeconds = 120;

  // ── Private helpers ────────────────────────────────────────
  private async assertBranch(id: string) {
    const b = await this.branchRepo.findOne({
      where: { id, is_deleted: false },
    });
    if (!b) throw new NotFoundException('Branch not found');
    return b;
  }

  private async assertYear(id: string) {
    const y = await this.yearRepo.findOne({
      where: { id, is_deleted: false },
    });
    if (!y) throw new NotFoundException('Academic Year not found');
    return y;
  }

  private assertTimeRange(from: string, to: string, label = '') {
    if (from >= to) {
      throw new BadRequestException(
        `${label} from_time must be before to_time`.trim(),
      );
    }
  }

  private makeParticipantId(): string {
    return randomUUID().replace(/-/g, '').slice(0, 24);
  }

  private withActiveParticipants<
    T extends { participants?: AppointmentParticipant[] },
  >(appointment: T): T {
    if (Array.isArray(appointment.participants)) {
      appointment.participants = appointment.participants.filter(
        (p) => !p.is_deleted && p.is_active !== false,
      );
    }
    return appointment;
  }

  private appendParticipantHistory(
    participant: AppointmentParticipant,
    status: ParticipantStatus,
    eventAt: Date,
    extra: Record<string, any> = {},
  ) {
    const current = Array.isArray(participant.response_history)
      ? participant.response_history
      : [];

    participant.response_history = [
      ...current,
      {
        action: status,
        status,
        person_id: participant.person_id,
        person_type: participant.person_type,
        appointment_id: participant.appointment_id,
        event_at: eventAt.toISOString(),
        responded_at: eventAt.toISOString(),
        response_note: participant.response_note ?? null,
        reschedule_count: participant.reschedule_count ?? 0,
        ...extra,
      },
    ];
  }

  // ── CREATE ─────────────────────────────────────────────────
  async create(dto: CreateAppointmentDto) {
    await this.assertBranch(dto.branch_id);
    await this.assertYear(dto.academic_year_id);
    this.assertTimeRange(dto.from_time, dto.to_time);

    return this.dataSource.transaction(async (manager) => {
      const now = new Date();
      const appointment = manager.create(Appointment, {
        id: randomUUID(),
        created_by: dto.created_by,
        creator_role: dto.creator_role,
        branch_id: dto.branch_id,
        academic_year_id: dto.academic_year_id,
        title: dto.title,
        description: dto.description,
        appointment_place: dto.appointment_place,
        date: new Date(dto.date),
        from_time: dto.from_time,
        to_time: dto.to_time,
        status: AppointmentStatus.SCHEDULED,
        is_active: true,
        is_deleted: false,
        created_at: now,
        updated_at: now,
      });
      await manager.save(Appointment, appointment);

      const rows = dto.participants.map((p) =>
        manager.create(AppointmentParticipant, {
          id: this.makeParticipantId(),
          appointment_id: appointment.id,
          branch_id: dto.branch_id,
          academic_year_id: dto.academic_year_id,
          person_id: p.person_id,
          person_type: p.person_type,
          status: ParticipantStatus.PENDING,
          reschedule_count: 0,
          declined_count: 0,
          is_active: true,
          is_deleted: false,
          created_at: now,
          updated_at: now,
        }),
      );
      await manager.save(AppointmentParticipant, rows);
      await notifyAppointment(manager, appointment, 'created', rows);

      await this.clearAppointmentCache(appointment.id);
      return { appointment, participants: rows };
    });
  }

  // ── PARTICIPANT RESPONDS ───────────────────────────────────
  async respond(participantId: string, dto: RespondAppointmentDto) {
    const participant = await this.participantRepo.findOne({
      where: { id: participantId, is_deleted: false },
      relations: ['appointment'],
    });
    if (!participant) throw new NotFoundException('Participant not found');

    const appt = participant.appointment!;
    if (appt.is_deleted) throw new NotFoundException('Appointment not found');
    if (appt.status === AppointmentStatus.CANCELLED)
      throw new ForbiddenException('Cannot respond to a cancelled appointment');
    if (participant.status === ParticipantStatus.DECLINED)
      throw new ForbiddenException(
        'You have already declined this appointment',
      );

    const previousStatus = participant.status;
    if (dto.status === previousStatus) return participant;
    switch (dto.status) {
      case ParticipantStatus.ACCEPTED: {
        const now = new Date();
        participant.status = ParticipantStatus.ACCEPTED;
        participant.response_note = dto.response_note ?? undefined;
        participant.responded_at = now;
        this.appendParticipantHistory(
          participant,
          ParticipantStatus.ACCEPTED,
          now,
        );
        break;
      }

      case ParticipantStatus.DECLINED: {
        const now = new Date();
        participant.declined_count += 1;
        participant.status = ParticipantStatus.DECLINED;
        participant.response_note = dto.response_note ?? undefined;
        participant.responded_at = now;
        this.appendParticipantHistory(
          participant,
          ParticipantStatus.DECLINED,
          now,
        );
        break;
      }

      default:
        throw new BadRequestException('Invalid status value');
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const saved = await manager.save(AppointmentParticipant, participant);
      if (
        dto.status === ParticipantStatus.DECLINED ||
        dto.status === ParticipantStatus.ACCEPTED
      ) {
        await notifyAppointment(
          manager,
          appt,
          dto.status === ParticipantStatus.ACCEPTED ? 'accepted' : 'declined',
          [participant],
          participant,
        );
      }
      return saved;
    });
    if (participant.appointment_id) {
      await this.clearAppointmentCache(participant.appointment_id);
    }
    return saved;
  }

  // ── CREATOR SETS NEW OFFICIAL TIME ────────────────────────
  async creatorReschedule(appointmentId: string, dto: CreatorRescheduleDto) {
    const appointment = await this.repo.findOne({
      where: { id: appointmentId, is_deleted: false },
      relations: ['participants'],
    });
    if (!appointment) throw new NotFoundException('Appointment not found');
    if (appointment.status === AppointmentStatus.CANCELLED)
      throw new ForbiddenException('Cannot reschedule a cancelled appointment');

    const actor = dto.participant_id
      ? (appointment.participants ?? []).find(
          (p) =>
            p.id === dto.participant_id &&
            !p.is_deleted &&
            p.is_active !== false,
        )
      : undefined;
    if (dto.participant_id && !actor)
      throw new NotFoundException('Participant not found');

    this.assertTimeRange(
      dto.rescheduled_from_time,
      dto.rescheduled_to_time,
      'Rescheduled',
    );

    const currentDate = appointment.rescheduled_date ?? appointment.date;
    const currentDateText =
      currentDate instanceof Date
        ? currentDate.toISOString().slice(0, 10)
        : String(currentDate).slice(0, 10);
    if (
      currentDateText === dto.rescheduled_date.slice(0, 10) &&
      (appointment.rescheduled_from_time ?? appointment.from_time)?.slice(
        0,
        5,
      ) === dto.rescheduled_from_time.slice(0, 5) &&
      (appointment.rescheduled_to_time ?? appointment.to_time)?.slice(0, 5) ===
        dto.rescheduled_to_time.slice(0, 5)
    )
      return appointment;

    if (actor && (actor.reschedule_count ?? 0) >= 3)
      throw new ForbiddenException('Maximum reschedule attempts reached');

    // Archive the schedule that was active before this reschedule so the
    // timeline can display an accurate "Previous:" snapshot.
    // If rescheduled_date already exists we're doing a 2nd+ reschedule —
    // save the current rescheduled_* values.  For the very first reschedule
    // the original date/from/to fields are saved as previous.
    appointment.previous_rescheduled_date =
      appointment.rescheduled_date ?? appointment.date ?? null;
    appointment.previous_rescheduled_from_time =
      appointment.rescheduled_from_time ?? appointment.from_time ?? null;
    appointment.previous_rescheduled_to_time =
      appointment.rescheduled_to_time ?? appointment.to_time ?? null;

    appointment.rescheduled_date = new Date(dto.rescheduled_date);
    appointment.rescheduled_from_time = dto.rescheduled_from_time;
    appointment.rescheduled_to_time = dto.rescheduled_to_time;
    appointment.rescheduled_at = new Date();
    appointment.status = AppointmentStatus.RESCHEDULED;

    const toReset = (appointment.participants ?? []).filter(
      (p) => !p.is_deleted && p.is_active !== false,
    );
    for (const p of toReset) {
      p.status = ParticipantStatus.PENDING;
      p.response_note = undefined;
      p.responded_at = null;
    }
    if (actor) {
      actor.reschedule_count = (actor.reschedule_count ?? 0) + 1;
      actor.status = ParticipantStatus.RESCHEDULED;
      actor.responded_at = appointment.rescheduled_at;
      this.appendParticipantHistory(
        actor,
        ParticipantStatus.RESCHEDULED,
        appointment.rescheduled_at,
        {
          proposed_date: dto.rescheduled_date,
          proposed_from_time: dto.rescheduled_from_time,
          proposed_to_time: dto.rescheduled_to_time,
        },
      );
    }

    return this.dataSource.transaction(async (manager) => {
      await manager.save(Appointment, appointment);
      if (toReset.length) {
        await manager.save(AppointmentParticipant, toReset);
      }
      await notifyAppointment(
        manager,
        appointment,
        'rescheduled',
        toReset,
        actor,
      );
      await this.clearAppointmentCache(appointment.id);
      return appointment;
    });
  }

  // ── FIND ALL (paginated) ───────────────────────────────────
  async findAll(page = 1, limit = 20) {
    return this.cache.getOrSet(
      `appointments:all:page:${page}:limit:${limit}`,
      this.appointmentListTtlSeconds,
      async () => {
        const [data, total] = await this.repo.findAndCount({
          where: { is_deleted: false },
          relations: [...this.appointmentRelations],
          order: { date: 'DESC' },
          skip: (page - 1) * limit,
          take: limit,
        });
        return {
          data: data.map((appointment) =>
            this.withActiveParticipants(appointment),
          ),
          total,
          page,
          limit,
        };
      },
    );
  }

  // ── FIND BY DATE RANGE ─────────────────────────────────────
  async findByDate(dateFrom?: string, dateTo?: string) {
    const where: any = { is_deleted: false };
    if (dateFrom && dateTo) {
      if (dateFrom > dateTo)
        throw new BadRequestException(
          'dateFrom must be before or equal to dateTo',
        );
      where.date = Between(new Date(dateFrom), new Date(dateTo));
    }
    return this.cache.getOrSet(
      `appointments:date:${dateFrom || 'all'}:${dateTo || 'all'}`,
      this.appointmentListTtlSeconds,
      async () => {
        const appointments = await this.repo.find({
          where,
          relations: [...this.appointmentRelations],
          order: { date: 'ASC' },
        });
        return appointments.map((appointment) =>
          this.withActiveParticipants(appointment),
        );
      },
    );
  }

  // ── FIND ONE ───────────────────────────────────────────────
  async findOne(id: string) {
    return this.cache.getOrSet(
      `appointments:${id}`,
      this.appointmentDetailTtlSeconds,
      () => this.findOneUncached(id),
    );
  }

  private async findOneUncached(id: string) {
    const a = await this.repo.findOne({
      where: { id, is_deleted: false },
      relations: [...this.appointmentRelations],
    });
    if (!a) throw new NotFoundException('Appointment not found');
    return this.withActiveParticipants(a);
  }

  // ── FIND BY BRANCH ─────────────────────────────────────────
  async findByBranch(branch_id: string, page = 1, limit = 20) {
    await this.assertBranch(branch_id);
    return this.cache.getOrSet(
      `appointments:branch:${branch_id}:page:${page}:limit:${limit}`,
      this.appointmentListTtlSeconds,
      async () => {
        const [data, total] = await this.repo.findAndCount({
          where: { branch_id, is_deleted: false },
          relations: [...this.appointmentRelations],
          order: { date: 'DESC' },
          skip: (page - 1) * limit,
          take: limit,
        });
        return {
          data: data.map((appointment) =>
            this.withActiveParticipants(appointment),
          ),
          total,
          page,
          limit,
        };
      },
    );
  }

  // ── FIND BY PERSON (my appointments) ──────────────────────
  async findByPerson(personId: string, page = 1, limit = 20) {
    return this.cache.getOrSet(
      `appointments:person:${personId}:page:${page}:limit:${limit}`,
      this.appointmentListTtlSeconds,
      async () => {
        const [rows, total] = await this.participantRepo.findAndCount({
          where: { person_id: personId, is_deleted: false },
          relations: [
            'appointment',
            'appointment.branch',
            'appointment.academicYear',
          ],
          order: { created_at: 'DESC' },
          skip: (page - 1) * limit,
          take: limit,
        });
        return { data: rows, total, page, limit };
      },
    );
  }

  // ── FIND BY CREATOR ────────────────────────────────────────
  async findByCreator(creatorId: string, page = 1, limit = 20) {
    return this.cache.getOrSet(
      `appointments:creator:${creatorId}:page:${page}:limit:${limit}`,
      this.appointmentListTtlSeconds,
      async () => {
        const [data, total] = await this.repo.findAndCount({
          where: { created_by: creatorId, is_deleted: false },
          relations: [...this.appointmentRelations],
          order: { date: 'DESC' },
          skip: (page - 1) * limit,
          take: limit,
        });
        return {
          data: data.map((appointment) =>
            this.withActiveParticipants(appointment),
          ),
          total,
          page,
          limit,
        };
      },
    );
  }

  // ── FIND RESCHEDULE REQUESTS (for creator to review) ──────
  async findRescheduleRequests(appointmentId: string) {
    const appointment = await this.findOne(appointmentId);
    const requests = (appointment.participants ?? []).filter(
      (p) => p.status === ParticipantStatus.RESCHEDULED,
    );
    return {
      appointment_id: appointmentId,
      reschedule_requests: requests,
    };
  }

  // ── UPDATE basic info ──────────────────────────────────────
  async update(id: string, dto: UpdateAppointmentDto) {
    // Load WITHOUT participants relation — loading + filtering participants
    // client-side then calling save() with cascade:true causes TypeORM to
    // NULL-out the appointment_id of soft-deleted rows, violating the constraint.
    const existing = await this.repo.findOne({
      where: { id, is_deleted: false },
    });
    if (!existing) throw new NotFoundException('Appointment not found');

    if (dto.branch_id) await this.assertBranch(dto.branch_id);
    if (dto.academic_year_id) await this.assertYear(dto.academic_year_id);

    const from = dto.from_time ?? existing.from_time;
    const to = dto.to_time ?? existing.to_time;
    if (from && to) {
      this.assertTimeRange(from, to);
    }

    const before = JSON.stringify([
      existing.date,
      existing.from_time,
      existing.to_time,
      existing.title,
      existing.description,
      existing.appointment_place,
      existing.status,
    ]);
    Object.assign(existing, dto);
    const after = JSON.stringify([
      existing.date,
      existing.from_time,
      existing.to_time,
      existing.title,
      existing.description,
      existing.appointment_place,
      existing.status,
    ]);
    const saved = await this.dataSource.transaction(async (manager) => {
      const saved = await manager.save(Appointment, existing);
      if (before !== after) {
        const participants = await manager.find(AppointmentParticipant, {
          where: { appointment_id: id, is_deleted: false },
        });
        await notifyAppointment(
          manager,
          saved,
          saved.status === AppointmentStatus.CANCELLED
            ? 'cancelled'
            : 'updated',
          participants,
        );
      }
      return saved;
    });
    await this.clearAppointmentCache(id);
    return saved;
  }

  // ── SOFT DELETE ────────────────────────────────────────────
  async softDelete(id: string) {
    return this.dataSource.transaction(async (manager) => {
      const a = await manager.findOne(Appointment, {
        where: { id, is_deleted: false },
      });
      if (!a) throw new NotFoundException('Appointment not found');

      const participants = await manager.find(AppointmentParticipant, {
        where: { appointment_id: id, is_deleted: false },
      });
      if (a.status !== AppointmentStatus.CANCELLED)
        await notifyAppointment(manager, a, 'cancelled', participants);
      a.is_deleted = true;
      a.is_active = false;
      a.status = AppointmentStatus.CANCELLED;

      await manager.update(
        AppointmentParticipant,
        { appointment_id: id, is_deleted: false },
        { is_deleted: true, is_active: false },
      );

      const saved = await manager.save(Appointment, a);
      await this.clearAppointmentCache(id);
      return saved;
    });
  }

  private async clearAppointmentCache(id?: string): Promise<void> {
    await this.cache.delPattern('appointments:*');
    if (id) await this.cache.del(`appointments:${id}`);
  }
}
