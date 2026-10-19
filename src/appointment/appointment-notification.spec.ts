import { notifyAppointment } from './appointment-notification';
import { AppointmentService } from './appointment.service';
import { AppointmentPersonService } from '../appointment-person/appointment-person.service';
import { Parent } from '../parents/parent.entity';
import { Admin } from '../admins/admin.entity';
import { Notification } from '../notifications/notification.entity';
import { pushMessage } from '../notifications/web-push.service';

function fixture() {
  const appointment: any = {
    id: 'appointment',
    created_by: 'creator',
    branch_id: 'branch',
    academic_year_id: 'year',
    title: 'Parent meeting',
    description: 'Discuss progress',
    date: '2026-10-14',
    from_time: '09:00:00',
    to_time: '10:00:00',
    appointment_place: 'Room 2',
    status: 'SCHEDULED',
  };
  const participant: any = {
    id: 'participant',
    appointment_id: appointment.id,
    person_id: 'parent',
    person_type: 'PARENT',
    status: 'PENDING',
    is_active: true,
    is_deleted: false,
  };
  const inbox = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
  const parents = {
    findOne: jest.fn(async ({ where }) =>
      ['parent', 'other'].includes(where.id)
        ? {
            id: where.id,
            branchId: 'branch',
            isActive: true,
            approvalStatus: 'approved',
            firstName_lao: 'Parent',
            lastName_lao: 'One',
          }
        : null,
    ),
  };
  const admins = {
    findOne: jest.fn(async ({ where }) =>
      where.id === 'creator' ? { id: 'creator', is_active: true } : null,
    ),
  };
  const manager: any = {
    getRepository: (type) =>
      type === Parent ? parents : type === Admin ? admins : inbox,
    create: (_, x) => x,
    save: jest.fn(async (_, x) => x),
    find: jest.fn(async () => [participant]),
    findOne: jest.fn(async () => appointment),
    update: jest.fn(async () => ({})),
  };
  const dataSource: any = { transaction: jest.fn(async (cb) => cb(manager)) };
  const repo: any = {
    findOne: jest.fn(async () => ({
      ...appointment,
      participants: [participant],
    })),
  };
  const people: any = {
    findOne: jest.fn(async () => ({ ...participant, appointment })),
    manager: dataSource,
  };
  const cache: any = { delPattern: jest.fn(), del: jest.fn() };
  const service = new AppointmentService(
    repo,
    people,
    { findOne: async () => ({}) } as any,
    { findOne: async () => ({}) } as any,
    dataSource,
    cache,
  );
  return {
    appointment,
    participant,
    inbox,
    parents,
    manager,
    dataSource,
    repo,
    people,
    service,
  };
}

test('invitation only reaches assigned people once, inactive and deleted invitees are excluded', async () => {
  const f = fixture();
  await notifyAppointment(f.manager, f.appointment, 'created', [
    f.participant,
    f.participant,
    { ...f.participant, person_id: 'other', is_deleted: true },
  ]);
  const rows = f.inbox.save.mock.calls[0][0];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    parent_id: 'parent',
    module_type: 'APPOINTMENT',
    metadata: { event: 'created', appointmentDate: '2026-10-14' },
  });
  expect(rows[0].student_id).toBeUndefined();
});
test('unapproved, inactive, deleted and different-branch parents do not receive invitations', async () => {
  for (const patch of [
    { approvalStatus: 'pending' },
    { isActive: false },
    { isDeleted: true },
    { branchId: 'other-branch' },
  ]) {
    const f = fixture();
    f.parents.findOne.mockResolvedValue({
      isActive: true,
      approvalStatus: 'approved',
      branchId: 'branch',
      ...patch,
    } as any);
    await notifyAppointment(f.manager, f.appointment, 'created', [
      f.participant,
    ]);
    expect(f.inbox.save).not.toHaveBeenCalled();
  }
});
test('create writes invitations in its appointment transaction', async () => {
  const f = fixture();
  await f.service.create({
    ...f.appointment,
    creator_role: 'ADMIN',
    participants: [f.participant],
  } as any);
  expect(f.dataSource.transaction).toHaveBeenCalledTimes(1);
  expect(f.inbox.save.mock.calls[0][0][0].metadata.event).toBe('created');
});
test('reschedule carries both schedules and identical retries do not send again', async () => {
  const f = fixture();
  await f.service.creatorReschedule('appointment', {
    rescheduled_date: '2026-10-15',
    rescheduled_from_time: '11:00',
    rescheduled_to_time: '12:00',
  });
  expect(f.inbox.save.mock.calls[0][0][0].metadata).toMatchObject({
    event: 'rescheduled',
    appointmentDate: '2026-10-15',
    previousDate: '2026-10-14',
    fromTime: '11:00',
  });
  const g = fixture();
  await g.service.creatorReschedule('appointment', {
    rescheduled_date: '2026-10-14',
    rescheduled_from_time: '09:00',
    rescheduled_to_time: '10:00',
  });
  expect(g.inbox.save).not.toHaveBeenCalled();
});
test('decline alerts the participant and creator without broadcasting to other invitees', async () => {
  const f = fixture();
  await f.service.respond('participant', {
    status: 'DECLINED',
    response_note: 'Unavailable',
  } as any);
  const rows = f.inbox.save.mock.calls[0][0];
  expect(rows).toHaveLength(2);
  expect(rows.map((x) => x.parent_id || x.admin_id)).toEqual([
    'parent',
    'creator',
  ]);
  expect(rows[0].metadata.responseNote).toBe('Unavailable');
});
test('same response retry does not notify twice', async () => {
  const f = fixture();
  f.people.findOne.mockResolvedValue({
    ...f.participant,
    status: 'ACCEPTED',
    appointment: f.appointment,
  });
  await f.service.respond('participant', { status: 'ACCEPTED' } as any);
  expect(f.inbox.save).not.toHaveBeenCalled();
});
test('acceptance alerts the participant and organizer with the response identity', async () => {
  const f = fixture();
  await f.service.respond('participant', { status: 'ACCEPTED' } as any);
  const rows = f.inbox.save.mock.calls[0][0];
  expect(rows.map((x) => x.parent_id || x.admin_id)).toEqual([
    'parent',
    'creator',
  ]);
  expect(rows[0].metadata).toMatchObject({
    event: 'accepted',
    participantName: 'Parent One',
  });
});
test('participant reschedule saves the schedule, count and history in one transaction', async () => {
  const f = fixture();
  await f.service.creatorReschedule('appointment', {
    participant_id: 'participant',
    rescheduled_date: '2026-10-15',
    rescheduled_from_time: '11:00',
    rescheduled_to_time: '12:00',
  });
  expect(f.dataSource.transaction).toHaveBeenCalledTimes(1);
  expect(f.participant).toMatchObject({
    status: 'RESCHEDULED',
    reschedule_count: 1,
  });
  expect(f.participant.response_history[0]).toMatchObject({
    proposed_date: '2026-10-15',
  });
  expect(f.inbox.save.mock.calls[0][0][0].metadata.event).toBe('rescheduled');
});
test('organizer acceptance reaches assigned parents once and excludes inactive invitees', async () => {
  const f = fixture();
  const organizer: any = {
    ...f.participant,
    id: 'organizer',
    person_id: 'creator',
    person_type: 'ADMIN',
  };
  f.people.findOne.mockResolvedValue({
    ...organizer,
    appointment: f.appointment,
  });
  f.manager.find.mockResolvedValue([
    organizer,
    f.participant,
    f.participant,
    { ...f.participant, person_id: 'other', is_active: false },
    { ...f.participant, person_id: 'other', is_deleted: true },
  ]);
  await f.service.respond('organizer', { status: 'ACCEPTED' } as any);
  const rows = f.inbox.save.mock.calls[0][0];
  expect(rows.map((x) => x.parent_id || x.admin_id).sort()).toEqual([
    'creator',
    'parent',
  ]);
  expect(rows.every((x) => x.metadata.event === 'accepted')).toBe(true);
  expect(f.manager.find).toHaveBeenCalledWith(expect.anything(), {
    where: {
      appointment_id: 'appointment',
      is_deleted: false,
      is_active: true,
    },
  });
});
test('invalid reschedule participant cannot change the appointment', async () => {
  const f = fixture();
  await expect(
    f.service.creatorReschedule('appointment', {
      participant_id: 'unassigned',
      rescheduled_date: '2026-10-15',
      rescheduled_from_time: '11:00',
      rescheduled_to_time: '12:00',
    }),
  ).rejects.toThrow('Participant not found');
  expect(f.manager.save).not.toHaveBeenCalled();
});
test('participant cannot reschedule more than three times', async () => {
  const f = fixture();
  f.participant.reschedule_count = 3;
  await expect(
    f.service.creatorReschedule('appointment', {
      participant_id: 'participant',
      rescheduled_date: '2026-10-15',
      rescheduled_from_time: '11:00',
      rescheduled_to_time: '12:00',
    }),
  ).rejects.toThrow('Maximum reschedule attempts reached');
  expect(f.manager.save).not.toHaveBeenCalled();
});
test('failed reschedule notification rejects the atomic change', async () => {
  const f = fixture();
  f.inbox.save.mockRejectedValue(new Error('Inbox failed'));
  await expect(
    f.service.creatorReschedule('appointment', {
      participant_id: 'participant',
      rescheduled_date: '2026-10-15',
      rescheduled_from_time: '11:00',
      rescheduled_to_time: '12:00',
    }),
  ).rejects.toThrow('Inbox failed');
});
test.each(['ACCEPTED', 'DECLINED'])(
  'legacy participant update emits %s once',
  async (status) => {
    const f = fixture();
    const service = new AppointmentPersonService(
      f.people,
      f.repo,
      {} as any,
      {} as any,
    );
    await service.update('participant', { status } as any);
    expect(f.inbox.save.mock.calls[0][0][0].metadata.event).toBe(
      status === 'ACCEPTED' ? 'accepted' : 'declined',
    );
    f.inbox.save.mockClear();
    f.people.findOne.mockResolvedValue({
      ...f.participant,
      status,
      appointment: f.appointment,
    });
    await service.update('participant', { status } as any);
    expect(f.inbox.save).not.toHaveBeenCalled();
  },
);
test('removing a participant alerts them and the organizer before soft deletion', async () => {
  const f = fixture();
  const service = new AppointmentPersonService(
    f.people,
    f.repo,
    {} as any,
    {} as any,
  );
  await service.softDelete('participant');
  expect(f.inbox.save.mock.calls[0][0]).toHaveLength(2);
  expect(f.manager.save.mock.calls[0][1].is_deleted).toBe(true);
});
test('cancelling appointment notifies original invitees even though they are soft deleted', async () => {
  const f = fixture();
  await f.service.softDelete('appointment');
  expect(f.inbox.save.mock.calls[0][0][0].metadata.event).toBe('cancelled');
});
test('failed inbox write fails appointment creation instead of silently losing notification', async () => {
  const f = fixture();
  f.inbox.save.mockRejectedValue(new Error('Inbox failed'));
  await expect(
    f.service.create({
      ...f.appointment,
      participants: [f.participant],
    } as any),
  ).rejects.toThrow('Inbox failed');
});
test('push translates appointment event and includes date/time/place', () => {
  const row = {
    metadata: {
      type: 'appointment',
      event: 'rescheduled',
      appointmentTitle: 'Meeting',
      appointmentDate: '2026-10-15',
      fromTime: '11:00:00',
      toTime: '12:00:00',
      place: 'Room 2',
    },
  };
  expect(pushMessage(row, 'en')).toMatchObject({
    title: 'Appointment rescheduled',
    body: 'Meeting\n2026-10-15\n11:00–12:00\nRoom 2',
  });
  expect(pushMessage(row, 'lo').title).toBe('ເລື່ອນນັດໝາຍ');
});
