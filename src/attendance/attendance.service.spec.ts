import { AttendanceService } from './attendance.service';

describe('AttendanceService list scope', () => {
  it('applies the branch filter directly to the attendance query', async () => {
    const queryBuilder = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    const attendanceRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const cache = {
      getOrSet: jest.fn(
        async (_key: string, _ttl: number, loader: () => unknown) => loader(),
      ),
    };
    const service = new AttendanceService(
      attendanceRepository as any,
      {} as any,
      {} as any,
      cache as any,
    );

    await service.findAll({
      startDate: '2026-09-24',
      endDate: '2026-09-25',
      branchId: 'branch-1',
    });

    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'student.branch_id = :branchId',
      { branchId: 'branch-1' },
    );
    expect(cache.getOrSet.mock.calls[0][0]).toContain('branchId=branch-1');
  });
});

describe('Attendance parent notifications', () => {
  function fixture() {
    let stored: any = null;
    const notifications = {
      create: jest.fn((value) => value),
      save: jest.fn().mockResolvedValue([]),
    };
    const attendance = {
      findOne: jest.fn(async () => stored && { ...stored }),
      create: jest.fn((value) => ({ ...value })),
      save: jest.fn(
        async (value) =>
          (stored = { ...value, id: value.id || 'attendance-1' }),
      ),
    };
    const student = {
      findOne: jest.fn().mockResolvedValue({
        id: 'student-1',
        first_name_lao: 'ມາລີ',
        last_name_lao: 'ສີສົມບັດ',
        parents: [
          { id: 'parent-1', isActive: true },
          { id: 'parent-1', isActive: true },
          { id: 'parent-2', isActive: false },
          { id: 'parent-3', isActive: true },
        ],
      }),
    };
    const manager = {
      query: jest.fn().mockResolvedValue([]),
      getRepository: jest.fn((entity) =>
        entity.name === 'Attendance'
          ? attendance
          : entity.name === 'Student'
            ? student
            : notifications,
      ),
    };
    const repo = {
      ...attendance,
      manager: {
        transaction: jest.fn(async (work) => {
          const before = stored && { ...stored };
          try {
            return await work(manager);
          } catch (error) {
            stored = before;
            throw error;
          }
        }),
      },
    };
    const cache = { del: jest.fn(), delPattern: jest.fn() };
    return {
      service: new AttendanceService(
        repo as any,
        {} as any,
        student as any,
        cache as any,
      ),
      notifications,
      attendance,
      student,
      manager,
    };
  }

  it('creates one notification per active parent with student and attendance details', async () => {
    const f = fixture();
    await f.service.create({
      student_id: 'student-1',
      attendance_date: '2026-10-10',
      type: 'LATE' as any,
      check_in: '08:45',
    });
    const rows = f.notifications.save.mock.calls[0][0];
    expect(rows.map((row: any) => row.parent_id)).toEqual([
      'parent-1',
      'parent-3',
    ]);
    expect(rows[0]).toMatchObject({
      student_id: 'student-1',
      module_type: 'ATTENDANCE',
      module_id: 'attendance-1',
      seen: 0,
      metadata: {
        type: 'attendance',
        event: 'check_in',
        studentId: 'student-1',
        status: 'LATE',
        checkIn: '08:45',
      },
    });
  });

  it('does not repeat notifications for equivalent times but notifies checkout and corrected status', async () => {
    const f = fixture();
    await f.service.create({
      student_id: 'student-1',
      attendance_date: '2026-10-10',
      type: 'PRESENT' as any,
      check_in: '08:00:00',
    });
    await f.service.update('attendance-1', { check_in: '08:00' });
    expect(f.notifications.save).toHaveBeenCalledTimes(1);
    await f.service.update('attendance-1', { check_out: '15:00' });
    expect(f.notifications.save.mock.calls[1][0][0].metadata.event).toBe(
      'check_out',
    );
    await f.service.update('attendance-1', {
      type: 'ABSENT' as any,
      reason: 'Sick',
      check_in: null as any,
      check_out: null as any,
    });
    expect(f.notifications.save.mock.calls[2][0][0].metadata).toMatchObject({
      status: 'ABSENT',
      reason: 'Sick',
      event: 'updated',
    });
  });

  it('rolls back the attendance save if notification persistence fails', async () => {
    const f = fixture();
    f.notifications.save.mockRejectedValue(
      new Error('notification save failed'),
    );
    await expect(
      f.service.create({
        student_id: 'student-1',
        attendance_date: '2026-10-10',
        type: 'PRESENT' as any,
      }),
    ).rejects.toThrow('notification save failed');
    expect(await f.attendance.findOne()).toBeNull();
  });

  it('blocks a duplicate QR check-in inside the transaction', async () => {
    const f = fixture();
    const saved = await f.service.create({
      student_id: 'student-1',
      attendance_date: '2026-10-10',
      type: 'PRESENT' as any,
      check_in: '08:00',
    });
    await expect(
      (f.service as any).saveWithNotification(
        saved,
        { check_in: '08:01' },
        true,
      ),
    ).rejects.toThrow('already been checked in');
    expect(f.notifications.save).toHaveBeenCalledTimes(1);
  });
});
