import { summarizeMontessoriAttendance as summarize } from './montessori.attendance';
const options = {
  yearStart: '2026-08-01',
  yearEnd: '2027-07-31',
  start: '2026-10-01',
  end: '2026-12-31',
  today: '2026-10-15',
  level: 'Toddlers',
};
describe('Montessori attendance from daily attendance records', () => {
  it('maps absence reason to Sick, keeps remarks as Absent, and counts late arrivals as present and tardy', () => {
    const result = summarize(
      [
        { attendance_date: '2026-09-01', type: 'PRESENT' },
        {
          attendance_date: '2026-10-01',
          type: 'ABSENT',
          reason: '  ',
          remark: 'AUTO ABSENT',
        },
        {
          attendance_date: '2026-10-02',
          type: 'ABSENT',
          reason: 'Family leave',
        },
        { attendance_date: '2026-10-03', type: 'LATE' },
        { attendance_date: '2026-10-04', type: 'PRESENT', remark: 'LATE' },
        { attendance_date: '2026-10-20', type: 'ABSENT' },
        { attendance_date: '2025-10-01', type: 'ABSENT' },
      ],
      options,
      { period: { sentHome: 2, distanceLearning: 0 } },
    );
    expect(result.through).toBe('2026-10-15');
    expect(result.attendance.period).toEqual({
      present: 2,
      absent: 1,
      sick: 1,
      sentHome: 2,
      vacation: null,
      tardy: 2,
      distanceLearning: 0,
    });
    expect(result.attendance.schoolYear.present).toBe(3);
    expect(result.attendance.schoolYear.absent).toBe(1);
  });
  it('keeps missing ranges unrecorded and real zero counts distinct', () => {
    expect(summarize([], options).attendance.period.present).toBeNull();
    const row = { attendance_date: '2026-09-01', type: 'PRESENT' };
    const result = summarize([row], { ...options, start: '' });
    expect(result.attendance.period.absent).toBeNull();
    expect(result.attendance.schoolYear.absent).toBe(0);
  });
  it('counts duplicate dates once, clips to the academic year/report end, and removes toddler-only columns', () => {
    const result = summarize(
      [
        { attendance_date: '2026-10-01', type: 'ABSENT' },
        { attendance_date: '2026-10-01', type: 'PRESENT' },
        { attendance_date: '2026-10-03', type: 'PRESENT' },
      ],
      { ...options, end: '2026-10-02', level: 'Twos' },
    );
    expect(result.attendance.period.present).toBe(1);
    expect(result.attendance.period.absent).toBe(0);
    expect(result.attendance.period).not.toHaveProperty('distanceLearning');
  });
});
