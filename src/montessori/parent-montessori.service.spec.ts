import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ParentMontessoriService } from './parent-montessori.service';

const ids = Array.from(
  { length: 6 },
  (_, i) => `${i + 1}1111111-1111-4111-8111-111111111111`,
);
const [parent, student, branchId, classId, academicYearId, reportId] = ids;
const user = { sub: parent, user_type: 'parent' };
const query = { branchId, classId, academicYearId };
const row = {
  id: reportId,
  student_id: student,
  branch_id: branchId,
  class_id: classId,
  academic_year_id: academicYearId,
  level: 'Twos',
  term: 'Term 1',
  version: 3,
  updated_at: '2026-10-15T12:00:00Z',
  created_by: 'private-staff-id',
  status: 'Draft',
  payload: {
    studentId: 'wrong-payload-scope',
    reportingStart: '2026-10-01',
    reportingEnd: '2026-10-31',
    student: 'Student',
    subjects: [
      { subject: 'Natural World', skills: ['Same', 'Same'] },
      { subject: 'Natural World', skills: ['Same'] },
      { subject: 'Behaviour', skills: ['Observation'] },
      { subject: 'Lao', skills: [], narrative: true },
    ],
    ratings: {
      '0:0': 'Mastered',
      '0:1': '',
      '1:0': 'Improved',
      '99:0': 'Mastered',
    },
    behaviorRatings: { '2:0': 4, '99:0': 1 },
    attendance: { period: { present: 0, sick: null, sentHome: 2 } },
    comments: { '4': 'Narrative' },
    internalNote: 'not for parents',
  },
};

describe('Parent Montessori reports', () => {
  const db = { query: jest.fn() };
  const service = new ParentMontessoriService(db as any);
  beforeEach(() => {
    db.query.mockReset();
    jest.useFakeTimers({ now: new Date('2026-10-15T12:00:00Z') });
  });
  afterEach(() => jest.useRealTimers());

  it('rejects staff access and malformed scope before querying reports', async () => {
    await expect(
      service.list({ ...user, user_type: 'admin' }, student, query),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.list(user, student, { ...query, branchId: 'invalid' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.query).not.toHaveBeenCalled();
  });
  it('rejects unlinked, pending, rejected or inactive parent enrollment without leaking a report', async () => {
    db.query.mockResolvedValueOnce([]);
    await expect(
      service.detail(user, student, reportId, query),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][1]).toEqual([
      parent,
      student,
      branchId,
      classId,
      academicYearId,
    ]);
    expect(db.query.mock.calls[0][0]).toContain('student_parents');
  });
  it('returns all saved reports including partial Drafts, safe metadata, and bounded pagination', async () => {
    db.query
      .mockResolvedValueOnce([
        { id: student, start: '2026-08-01', end: '2027-07-31' },
      ])
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([row]);
    const result = await service.list(user, student, query);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({
      studentId: student,
      assessment: { assessed: 3, total: 4, percent: 75 },
    });
    expect(result.reports[0]).not.toHaveProperty('created_by');
    expect(result.reports[0]).not.toHaveProperty('subjects');
    expect(db.query.mock.calls[2][1]).toEqual([
      branchId,
      student,
      classId,
      academicYearId,
      100,
      0,
    ]);
  });
  it('derives daily attendance for old snapshots while retaining duplicate positions, narrative and manual values', async () => {
    db.query
      .mockResolvedValueOnce([
        { id: student, start: '2026-08-01', end: '2027-07-31' },
      ])
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([
        { attendance_date: '2026-09-02', type: 'LATE' },
        { attendance_date: '2026-10-02', type: 'ABSENT' },
        {
          attendance_date: '2026-10-03',
          type: 'ABSENT',
          reason: 'Leave reason',
        },
      ]);
    const result = await service.detail(user, student, reportId, query);
    expect(result).toMatchObject({
      subjects: row.payload.subjects,
      attendance: {
        period: { present: 0, absent: 1, sick: 1, tardy: 0, sentHome: 2 },
        schoolYear: { present: 1, tardy: 1 },
      },
    });
    expect(result).not.toHaveProperty('internalNote');
    expect(result).not.toHaveProperty('createdBy');
    expect(db.query.mock.calls[1][1]).toEqual([
      branchId,
      student,
      classId,
      academicYearId,
      reportId,
    ]);
  });
  it('hides another child/class/year report and validates pagination', async () => {
    db.query
      .mockResolvedValue([
        { id: student, start: '2026-08-01', end: '2027-07-31' },
      ])
      .mockResolvedValueOnce([
        { id: student, start: '2026-08-01', end: '2027-07-31' },
      ])
      .mockResolvedValueOnce([]);
    await expect(
      service.detail(user, student, reportId, query),
    ).rejects.toBeInstanceOf(NotFoundException);
    db.query.mockResolvedValue([
      { id: student, start: '2026-08-01', end: '2027-07-31' },
    ]);
    for (const limit of ['0', '101', '1.5', 'NaN']) {
      await expect(
        service.list(user, student, { ...query, limit }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
