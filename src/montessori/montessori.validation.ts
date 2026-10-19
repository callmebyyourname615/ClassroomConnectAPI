import { BadRequestException } from '@nestjs/common';
export const levels = ['Toddlers', 'Twos', 'Pre-School', 'Lower Elementary'];
export const stages = ['Presented', 'Practicing', 'Improved', 'Mastered'];
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validUuid = (value: unknown): value is string =>
  typeof value === 'string' && uuid.test(value);
const object = (value: any) =>
  value && typeof value === 'object' && !Array.isArray(value);
const fail = (message: string): never => {
  throw new BadRequestException(message);
};
export const behavior = (subject: string) => /behaviou?r/i.test(subject);
export function validDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function validateReport(input: Record<string, any>) {
  if (!object(input) || JSON.stringify(input).length > 300000)
    fail('Report must be an object of at most 300KB.');
  for (const key of ['studentId', 'classId', 'academicYearId'])
    if (!validUuid(input[key])) fail(`Invalid ${key}.`);
  if (
    !levels.includes(input.level) ||
    !['Term 1', 'Term 2'].includes(input.term)
  )
    fail('Invalid level or term.');
  if (
    !Array.isArray(input.subjects) ||
    !input.subjects.length ||
    input.subjects.length > 30
  )
    fail('Invalid template snapshot.');
  let total = 0;
  for (const section of input.subjects) {
    if (
      !object(section) ||
      typeof section.subject !== 'string' ||
      !section.subject.trim() ||
      section.subject.length > 200 ||
      !Array.isArray(section.skills) ||
      (!section.skills.length && section.narrative !== true) ||
      (section.narrative === true && section.skills.length !== 0) ||
      section.skills.length > 200 ||
      section.skills.some(
        (s: any) => typeof s !== 'string' || !s.trim() || s.length > 500,
      )
    )
      fail('Invalid template subject or skill.');
    total += section.skills.length;
  }
  if (total > 1500) fail('Too many assessment items.');
  const indexed = (key: string) => {
    if (!/^(0|[1-9]\d*):(0|[1-9]\d*)$/.test(key))
      fail('Invalid assessment key.');
    const [subject, skill] = key.split(':').map(Number);
    if (!input.subjects[subject]?.skills[skill])
      fail('Unknown assessment item.');
    return input.subjects[subject];
  };
  const maps: Record<string, Record<string, any>> = {};
  for (const key of ['ratings', 'behaviorRatings', 'comments', 'coverage']) {
    const map = input[key] ?? {};
    if (!object(map)) fail(`Invalid ${key}.`);
    maps[key] = {};
    for (const [id, value] of Object.entries(map)) {
      if (key === 'ratings') {
        if (
          behavior(indexed(id).subject) ||
          (value !== '' && !stages.includes(value as string))
        )
          fail('Invalid learning skill rating.');
      } else if (key === 'behaviorRatings') {
        if (
          !behavior(indexed(id).subject) ||
          (value !== null && ![1, 2, 3, 4].includes(value as number))
        )
          fail('Behavior rating must be 1–4 or null.');
      } else {
        if (!/^(0|[1-9]\d*)$/.test(id) || !input.subjects[Number(id)])
          fail('Unknown report subject.');
        if (
          key === 'comments' &&
          (typeof value !== 'string' || value.length > 10000)
        )
          fail('Comments must contain at most 10,000 characters.');
        if (
          key === 'coverage' &&
          !['Not started', 'In progress', 'Covered for this period'].includes(
            value as string,
          )
        )
          fail('Invalid subject coverage.');
      }
      maps[key][id] = value;
    }
  }
  const start = input.reportingStart || '',
    end = input.reportingEnd || '';
  if (
    (start && !validDate(start)) ||
    (end && !validDate(end)) ||
    (start && end && start > end)
  )
    fail('Invalid reporting dates.');
  const attendance: Record<string, Record<string, number | null>> = {};
  const columns = [
    'present',
    'absent',
    'sick',
    'sentHome',
    'vacation',
    'tardy',
    ...(input.level === 'Toddlers' ? ['distanceLearning'] : []),
  ];
  if (input.attendance !== undefined && !object(input.attendance))
    fail('Invalid attendance.');
  for (const row of ['period', 'schoolYear']) {
    if (input.attendance?.[row] !== undefined && !object(input.attendance[row]))
      fail('Invalid attendance row.');
    attendance[row] = {};
    for (const col of columns) {
      const n = input.attendance?.[row]?.[col] ?? null;
      if (n !== null && (!Number.isInteger(n) || n < 0 || n > 10000))
        fail('Attendance counts must be nonnegative whole numbers.');
      attendance[row][col] = n;
    }
  }
  if (
    input.summaryComment !== undefined &&
    (typeof input.summaryComment !== 'string' ||
      input.summaryComment.length > 10000)
  )
    fail('Invalid summary comment.');
  if (
    typeof input.templateVersion !== 'string' ||
    !input.templateVersion ||
    input.templateVersion.length > 100
  )
    fail('Invalid template version.');
  return {
    studentId: input.studentId as string,
    classId: input.classId as string,
    academicYearId: input.academicYearId as string,
    level: input.level as string,
    term: input.term as string,
    reportingStart: start,
    reportingEnd: end,
    templateVersion: input.templateVersion,
    subjects: input.subjects.map((s: any) => ({
      subject: s.subject,
      skills: [...s.skills],
      ...(s.narrative === true ? { narrative: true } : {}),
    })),
    ...maps,
    attendance,
    summaryComment: input.summaryComment || '',
  };
}
export function progress(payload: any) {
  const total = payload.subjects.reduce(
    (n: number, s: any) => n + s.skills.length,
    0,
  );
  return total
    ? Math.round(
        ((Object.values(payload.ratings).filter(Boolean).length +
          Object.values(payload.behaviorRatings).filter((v) => v !== null)
            .length) /
          total) *
          100,
      )
    : 0;
}
