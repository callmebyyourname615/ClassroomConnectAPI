import {
  montessoriTemplates,
  montessoriTemplateVersion,
} from './montessori.templates';
import { validateReport } from './montessori.validation';

describe('Report_mon source templates', () => {
  it.each([
    ['Toddlers', 6, 39],
    ['Twos', 7, 49],
    ['Pre-School', 11, 51],
    ['Lower Elementary', 16, 138],
  ])(
    'keeps the verified %s document section and item counts',
    (level, sections, items) => {
      const subjects = montessoriTemplates[level];
      expect(subjects).toHaveLength(sections);
      expect(
        subjects.reduce((sum, section) => sum + section.skills.length, 0),
      ).toBe(items);
      expect(() =>
        validateReport({
          studentId: '11111111-1111-4111-8111-111111111111',
          classId: '22222222-2222-4222-8222-222222222222',
          academicYearId: '33333333-3333-4333-8333-333333333333',
          level,
          term: 'Term 2',
          reportingStart: '',
          reportingEnd: '',
          templateVersion: montessoriTemplateVersion,
          subjects,
          ratings: {},
          behaviorRatings: {},
          comments: {},
          coverage: {},
          attendance: {},
        }),
      ).not.toThrow();
    },
  );
  it('preserves intentional duplicate document rows and a narrative-only Lao section', () => {
    expect(
      montessoriTemplates.Twos.find(
        (s) => s.subject === 'Sensorial',
      )?.skills.filter((s) => s === 'Natural World'),
    ).toHaveLength(2);
    expect(montessoriTemplates['Lower Elementary'].at(-1)).toEqual({
      subject: 'Lao',
      skills: [],
      narrative: true,
    });
  });
});
