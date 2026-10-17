import { EntityManager } from 'typeorm';
import { Appointment } from './appointment.entity';
import { AppointmentParticipant } from './dto/appointment-participant.entity';
import { PersonType } from './appointment.enum';
import { Parent } from '../parents/parent.entity';
import { Admin } from '../admins/admin.entity';
import { Notification } from '../notifications/notification.entity';

export type AppointmentEvent =
  | 'created'
  | 'rescheduled'
  | 'accepted'
  | 'declined'
  | 'cancelled'
  | 'updated';
export const appointmentEventTitles = {
  created: { lo: 'ນັດໝາຍໃໝ່', en: 'New appointment' },
  rescheduled: { lo: 'ເລື່ອນນັດໝາຍ', en: 'Appointment rescheduled' },
  accepted: { lo: 'ຢືນຢັນການເຂົ້າຮ່ວມນັດໝາຍ', en: 'Appointment accepted' },
  declined: {
    lo: 'ຍົກເລີກການເຂົ້າຮ່ວມນັດໝາຍ',
    en: 'Appointment participation cancelled',
  },
  cancelled: { lo: 'ຍົກເລີກນັດໝາຍ', en: 'Appointment cancelled' },
  updated: { lo: 'ອັບເດດນັດໝາຍ', en: 'Appointment updated' },
};

const dateText = (value?: Date | string | null) =>
  value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value ?? '').slice(0, 10);

/** Inbox writes are atomic with the appointment change. Parent invitations are
 * personal: they have no student ID and must appear for any selected child. */
export async function notifyAppointment(
  manager: EntityManager,
  appointment: Appointment,
  event: AppointmentEvent,
  participants: AppointmentParticipant[],
  actor?: AppointmentParticipant,
) {
  const metadata = {
    type: 'appointment',
    event,
    appointmentId: appointment.id,
    appointmentTitle: appointment.title,
    description: appointment.description || '',
    appointmentDate: dateText(appointment.rescheduled_date ?? appointment.date),
    fromTime: appointment.rescheduled_from_time ?? appointment.from_time ?? '',
    toTime: appointment.rescheduled_to_time ?? appointment.to_time ?? '',
    place: appointment.appointment_place || '',
    previousDate: dateText(appointment.previous_rescheduled_date),
    previousFromTime: appointment.previous_rescheduled_from_time ?? '',
    previousToTime: appointment.previous_rescheduled_to_time ?? '',
    participantId: actor?.id ?? null,
    participantName: '',
    responseNote: actor?.response_note || '',
  };
  const recipients = new Map<string, { id: string; parent: boolean }>();
  async function recipient(id: string, parent: boolean) {
    if (parent) {
      const p = await manager.getRepository(Parent).findOne({ where: { id } });
      if (
        !p ||
        p.isDeleted ||
        !p.isActive ||
        p.approvalStatus !== 'approved' ||
        (p.branchId && p.branchId !== appointment.branch_id)
      )
        return;
      if (actor?.person_id === id)
        metadata.participantName = [
          p.firstName_lao || p.firstName_eng,
          p.lastName_lao || p.lastName_eng,
        ]
          .filter(Boolean)
          .join(' ');
    } else {
      const a = await manager
        .getRepository(Admin)
        .findOne({ where: { id, is_deleted: false, is_active: true } });
      if (!a) return;
      if (actor?.person_id === id)
        metadata.participantName = [
          a.first_name_La || a.first_name,
          a.last_name_La || a.last_name,
        ]
          .filter(Boolean)
          .join(' ');
    }
    recipients.set(`${parent ? 'parent' : 'admin'}:${id}`, { id, parent });
  }
  // Acceptance changes the shared meeting's attendance: all assigned people
  // need the update, including parents when the organizer accepts on the web.
  const notifiedParticipants =
    event === 'accepted'
      ? [
          ...participants,
          ...(await manager.find(AppointmentParticipant, {
            where: {
              appointment_id: appointment.id,
              is_deleted: false,
              is_active: true,
            },
          })),
        ]
      : participants;
  for (const p of notifiedParticipants) {
    if (p.person_id && !p.is_deleted && p.is_active !== false)
      await recipient(p.person_id, p.person_type === PersonType.PARENT);
  }
  if (
    (event === 'declined' ||
      event === 'accepted' ||
      (event === 'rescheduled' && actor)) &&
    appointment.created_by
  ) {
    const parentCreator = await manager
      .getRepository(Parent)
      .findOne({ where: { id: appointment.created_by } });
    await recipient(appointment.created_by, !!parentCreator);
  }
  const repo = manager.getRepository(Notification);
  const rows = [...recipients.values()].map(({ id, parent }) =>
    repo.create({
      ...(parent ? { parent_id: id } : { admin_id: id }),
      branch_id: appointment.branch_id,
      academic_year_id: appointment.academic_year_id,
      module_id: appointment.id,
      module_type: 'APPOINTMENT',
      title: appointmentEventTitles[event].lo,
      description:
        `${appointment.title} · ${metadata.appointmentDate} · ${metadata.fromTime}–${metadata.toTime}`.slice(
          0,
          255,
        ),
      message: [
        appointment.title,
        metadata.appointmentDate,
        `${metadata.fromTime}–${metadata.toTime}`,
        metadata.place,
        metadata.participantName,
        metadata.responseNote,
        metadata.description,
      ]
        .filter(Boolean)
        .join('\n'),
      metadata: { ...metadata },
      seen: 0,
      clicked: 0,
    }),
  );
  if (rows.length) await repo.save(rows);
}
