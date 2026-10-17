export interface AttendanceRow {
  attendance_date: string;
  type: string;
  reason?: string | null;
  remark?: string | null;
}
export const attendanceSourceColumns = [
  'present',
  'absent',
  'sick',
  'tardy',
] as const;
/** Counts recorded days only; absence remarks are never treated as leave reasons. */
export function summarizeMontessoriAttendance(
  rows: AttendanceRow[],
  options: {
    yearStart: string;
    yearEnd: string;
    start: string;
    end: string;
    today: string;
    level: string;
  },
  existing: Record<string, Record<string, number | null>> = {},
) {
  const through = [
    options.end || options.today,
    options.yearEnd,
    options.today,
  ].sort()[0];
  const periodStart = options.start
    ? [options.start, options.yearStart].sort().at(-1)!
    : '';
  const columns = [
    'present',
    'absent',
    'sick',
    'sentHome',
    'vacation',
    'tardy',
    ...(options.level === 'Toddlers' ? ['distanceLearning'] : []),
  ];
  const unique = new Map(rows.map((row) => [row.attendance_date, row]));
  const attendance: Record<string, Record<string, number | null>> = {};
  for (const [key, from] of [
    ['period', periodStart],
    ['schoolYear', options.yearStart],
  ]) {
    const records = from
      ? [...unique.values()].filter(
          (row) =>
            row.attendance_date >= from &&
            row.attendance_date <= through &&
            ['PRESENT', 'ABSENT', 'LATE'].includes(row.type),
        )
      : [];
    const counts = { present: 0, absent: 0, sick: 0, tardy: 0 };
    for (const row of records) {
      if (row.type === 'ABSENT')
        counts[row.reason?.trim() ? 'sick' : 'absent']++;
      else {
        counts.present++;
        if (row.type === 'LATE' || row.remark?.trim().toUpperCase() === 'LATE')
          counts.tardy++;
      }
    }
    attendance[key] = Object.fromEntries(
      columns.map((column) => [
        column,
        attendanceSourceColumns.includes(column as any)
          ? records.length
            ? counts[column as keyof typeof counts]
            : null
          : (existing[key]?.[column] ?? null),
      ]),
    );
  }
  return {
    attendance,
    through,
    periodStart,
    yearStart: options.yearStart,
    records: unique.size,
  };
}
