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
      getOrSet: jest.fn(async (_key: string, _ttl: number, loader: () => unknown) => loader()),
    };
    const service = new AttendanceService(attendanceRepository as any, {} as any, {} as any, cache as any);

    await service.findAll({
      startDate: '2026-09-24',
      endDate: '2026-09-25',
      branchId: 'branch-1',
    });

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('student.branch_id = :branchId', { branchId: 'branch-1' });
    expect(cache.getOrSet.mock.calls[0][0]).toContain('branchId=branch-1');
  });
});
