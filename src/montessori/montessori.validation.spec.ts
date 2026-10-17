import { validateReport, progress } from './montessori.validation';
const document = () => ({
  studentId: '11111111-1111-4111-8111-111111111111',
  classId: '22222222-2222-4222-8222-222222222222',
  academicYearId: '33333333-3333-4333-8333-333333333333',
  level: 'Twos',
  term: 'Term 2',
  templateVersion: 'v1',
  subjects: [
    { subject: 'Behaviour & Work Habits', skills: ['Self-management'] },
    { subject: 'Sensorial', skills: ['Natural World', 'Natural World'] },
  ],
  ratings: { '1:0': 'Mastered', '1:1': 'Practicing' },
  behaviorRatings: { '0:0': 2 },
  comments: { '1': 'ທົດສອບ' },
  coverage: { '1': 'In progress' },
  reportingStart: '2026-02-01',
  reportingEnd: '2026-06-30',
  attendance: { period: { present: 12, tardy: 1 } },
});
describe('Montessori report validation', () => {
  it('stores repeated skill labels independently and separates behavior ratings', () => {
    const saved = validateReport(document());
    expect(saved.ratings).toEqual({ '1:0': 'Mastered', '1:1': 'Practicing' });
    expect(saved.behaviorRatings).toEqual({ '0:0': 2 });
    expect(progress(saved)).toBe(100);
  });
  it.each(['Toddlers', 'Twos', 'Pre-School', 'Lower Elementary'])(
    'supports %s',
    (level) =>
      expect(validateReport({ ...document(), level }).level).toBe(level),
  );
  it('does not store client status, author or computed progress', () => {
    const saved = validateReport({
      ...document(),
      status: 'Approved',
      createdBy: 'spoofed',
      progress: 999,
    });
    expect(saved).not.toHaveProperty('status');
    expect(saved).not.toHaveProperty('createdBy');
    expect(saved).not.toHaveProperty('progress');
  });
  it('supports a narrative section without adding fictional assessed skills', () => {
    const saved = validateReport({
      ...document(),
      subjects: [
        ...document().subjects,
        { subject: 'Lao', skills: [], narrative: true },
      ],
    });
    expect(saved.subjects.at(-1)).toEqual({
      subject: 'Lao',
      skills: [],
      narrative: true,
    });
    expect(progress(saved)).toBe(100);
    expect(() =>
      validateReport({
        ...document(),
        subjects: [{ subject: 'Lao', skills: [] }],
      }),
    ).toThrow();
  });
  it('rejects wrong skill types and unknown indexes', () => {
    expect(() =>
      validateReport({ ...document(), ratings: { '0:0': 'Mastered' } }),
    ).toThrow();
    expect(() =>
      validateReport({ ...document(), behaviorRatings: { '1:0': 3 } }),
    ).toThrow();
    expect(() =>
      validateReport({ ...document(), ratings: { '99:0': 'Mastered' } }),
    ).toThrow();
    expect(() =>
      validateReport({ ...document(), ratings: { '01:0': 'Mastered' } }),
    ).toThrow();
  });
  it('rejects invalid calendar dates and reversed periods', () => {
    expect(() =>
      validateReport({ ...document(), reportingStart: '2026-02-30' }),
    ).toThrow();
    expect(() =>
      validateReport({ ...document(), reportingStart: '2026-07-01' }),
    ).toThrow();
  });
  it('rejects negative and fractional attendance', () => {
    for (const n of [-1, 1.5])
      expect(() =>
        validateReport({
          ...document(),
          attendance: { period: { present: n } },
        }),
      ).toThrow();
  });
  it('keeps unassessed and unrecorded attendance separate from zero', () => {
    const saved = validateReport({
      ...document(),
      ratings: { '1:0': '' },
      behaviorRatings: { '0:0': null },
      attendance: { period: { present: 0 } },
    });
    expect(saved.attendance.period.present).toBe(0);
    expect(saved.attendance.period.absent).toBeNull();
    expect(progress(saved)).toBe(0);
  });
});
