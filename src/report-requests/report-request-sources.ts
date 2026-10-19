import { createHash } from 'node:crypto';
import { studentReportTemplate } from '../kindergarten/student-reports.service';
import {
  behavior,
  stages,
  validDate,
} from '../montessori/montessori.validation';

const months = [9, 10, 11, 12, 1, 2, 3, 4, 5, 6];
const monthLo = [
  'ກັນຍາ',
  'ຕຸລາ',
  'ພະຈິກ',
  'ທັນວາ',
  'ມັງກອນ',
  'ກຸມພາ',
  'ມີນາ',
  'ເມສາ',
  'ພຶດສະພາ',
  'ມິຖຸນາ',
];
const number = (v: any) => typeof v === 'number' && Number.isFinite(v);
const positive = (v: any) => Number.isSafeInteger(v) && v > 0;

export interface ReportSelection {
  termId: string;
  term: string;
  termLo: string;
  option: Record<string, any>;
  snapshot: Record<string, any>;
}

export function primaryRequestDocuments(snapshot: any) {
  const student = snapshot.students?.[0];
  const subjects = (snapshot.subjectDefinitions || [])
    .filter((d: any) => {
      const score = student?.scores?.[d.slotKey];
      return (
        d.enabled !== false &&
        score?.method === 'evaluation' &&
        Array.isArray(score.breakdown) &&
        score.breakdown.some((item: any) => number(item.score))
      );
    })
    .map((d: any) => ({
      id: d.slotKey,
      label: d.subjectName,
      labelLo: d.subjectName,
      subjectId: d.subjectId || '',
    }));
  return [
    {
      id: 'primary-monthly',
      label: 'Monthly report',
      labelLo: 'ລາຍງານປະຈຳເດືອນ',
      canRequest: true,
    },
    {
      id: 'primary-evaluation',
      label: 'Evaluation form',
      labelLo: 'ແບບປະເມີນ',
      canRequest: subjects.length > 0,
      subjects,
      unavailableReason: 'No recorded subject evaluation is available.',
      unavailableReasonLo: 'ຍັງບໍ່ມີຂໍ້ມູນແບບປະເມີນລາຍວິຊາ',
    },
    {
      id: 'primary-yellow-book',
      label: 'Yellow Book',
      labelLo: 'ປຶ້ມເຫຼືອງ',
      canRequest: true,
    },
  ];
}

function selection(
  term: number,
  option: Record<string, any>,
  snapshot: any,
): ReportSelection {
  return {
    termId: `term-${term}`,
    term: `Term ${term}`,
    termLo: `ພາກຮຽນທີ ${term}`,
    option,
    snapshot,
  };
}

function availability(
  option: Record<string, any>,
  scores: boolean,
  mapping: boolean,
) {
  return {
    ...option,
    canRequest: scores && mapping,
    mappingReady: mapping,
    description: 'Results recorded',
    descriptionLo: 'ບັນທຶກຜົນແລ້ວ',
    ...(!scores || !mapping
      ? {
          unavailableReason: mapping
            ? 'No scores recorded for this period.'
            : 'The school must complete the report template mapping.',
          unavailableReasonLo: mapping
            ? 'ຍັງບໍ່ມີຜົນປະເມີນໃນໄລຍະນີ້'
            : 'ໂຮງຮຽນຕ້ອງກຳນົດແບບລາຍງານໃຫ້ສຳເລັດ',
        }
      : {}),
  };
}

export function reportSelections(
  scope: any,
  school: any,
  montessori: any[],
  primary: any[],
  assessments: any[],
  kindergartenReports: any[] = [],
  kindergartenRecords: any[] = [],
  kindergartenAttendance: any[] = [],
): ReportSelection[] {
  // Montessori records are passed only when the class has no primary/kindergarten mapping.
  if (montessori.length)
    return montessori.map((row) => {
      const p = row.payload || {};
      const term = row.term === 'Term 2' ? 2 : 1;
      const scored = (Array.isArray(p.subjects) ? p.subjects : []).some(
        (s: any, i: number) =>
          (Array.isArray(s.skills) ? s.skills : []).some((_: any, j: number) =>
            behavior(String(s.subject))
              ? [1, 2, 3, 4].includes(p.behaviorRatings?.[`${i}:${j}`])
              : stages.includes(p.ratings?.[`${i}:${j}`]),
          ),
      );
      const dates =
        validDate(p.reportingStart) &&
        validDate(p.reportingEnd) &&
        p.reportingStart <= p.reportingEnd;
      const label = dates
        ? `${p.reportingStart} – ${p.reportingEnd}`
        : 'Reporting period';
      const template = {
        family: 'montessori',
        level: row.level,
        templateVersion: p.templateVersion || '',
      };
      return selection(
        term,
        availability(
          {
            id: `montessori:${row.id}`,
            sourceReportId: row.id,
            sourceVersion: row.version,
            label,
            labelLo: dates ? label : 'ໄລຍະປະເມີນ',
            reportingStart: p.reportingStart || '',
            reportingEnd: p.reportingEnd || '',
            format: `Montessori — ${row.level}`,
            formatLo: `Montessori — ${row.level}`,
            template,
          },
          scored,
          Boolean(p.templateVersion && dates),
        ),
        p,
      );
    });
  let mappings = {};
  try {
    mappings = JSON.parse(school?.reportTemplates || '{}');
  } catch {
    /* No valid manual mapping. */
  }
  const mapped = studentReportTemplate(scope, mappings);
  if (mapped === 'primary') {
    const latest = new Map<number, any>();
    for (const row of primary) {
      const p = row.payload || {};
      if (
        !positive(p.version) ||
        !Number.isInteger(p.reportMonth) ||
        p.reportMonth < 1 ||
        p.reportMonth > months.length
      )
        continue;
      if (
        row.kind === 'monthly-report-snapshot-v2'
          ? p.status !== 'published'
          : p.status !== 'reviewed'
      )
        continue;
      const old = latest.get(p.reportMonth);
      const published = row.kind === 'monthly-report-snapshot-v2';
      if (
        !old ||
        (published && old.kind !== row.kind) ||
        (old.kind === row.kind && p.version > old.payload.version)
      )
        latest.set(p.reportMonth, row);
    }
    const yearStart = Number(scope.year_name.match(/\d{4}/)?.[0]);
    if (!Number.isInteger(yearStart)) return [];
    // Same academic calendar as the report portal: September start, February term boundary unless configured.
    const boundary =
      validDate(school?.term2Start) &&
      school.term2Start >= `${yearStart}-09-01` &&
      school.term2Start <= `${yearStart + 1}-08-31`
        ? school.term2Start
        : `${yearStart + 1}-02-01`;
    return [...latest.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([index, row]) => {
        const p = row.payload;
        const student = (Array.isArray(p.students) ? p.students : []).find(
          (s: any) => s.studentId === scope.studentId,
        );
        if (!student) return [];
        const month = months[index - 1],
          year = month >= 9 ? yearStart : yearStart + 1;
        const start = `${year}-${String(month).padStart(2, '0')}-01`;
        const end = `${year}-${String(month).padStart(2, '0')}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`;
        const template = {
          family: 'primary',
          templateId: 'primary-monthly-v2',
          configurationId: p.configurationId || '',
        };
        const scored = (
          Array.isArray(p.subjectDefinitions) ? p.subjectDefinitions : []
        ).some((d: any) => {
          const s = student.scores?.[d.slotKey];
          return (
            d.enabled !== false &&
            d.scoreMethod !== 'none' &&
            s?.method !== 'none' &&
            number(s?.value) &&
            number(s?.reportMaximum ?? d.reportMaximum) &&
            (s.reportMaximum ?? d.reportMaximum) > 0
          );
        });
        // Freeze only this child's row; class snapshots also contain other children's results.
        const snapshot = {
          configurationId: p.configurationId,
          version: p.version,
          status: p.status,
          reportMonth: p.reportMonth,
          reportYear: p.reportYear,
          academicYearId: p.academicYearId,
          classId: p.classId,
          subjectDefinitions: p.subjectDefinitions,
          students: [student],
          studentComments: (Array.isArray(p.studentComments)
            ? p.studentComments
            : []
          ).filter((c: any) => c.studentId === scope.studentId),
        };
        return [
          selection(
            start >= boundary ? 2 : 1,
            availability(
              {
                id: `primary:${row.id}`,
                sourceReportId: row.id,
                sourceVersion: p.version,
                label: `${new Date(`${start}T00:00:00Z`).toLocaleString('en', { month: 'long', timeZone: 'UTC' })} ${year}`,
                labelLo: `${monthLo[index - 1]} ${year}`,
                reportingStart: start,
                reportingEnd: end,
                format: 'Primary monthly report',
                formatLo: 'ລາຍງານປະຖົມປະຈຳເດືອນ',
                template,
                documents: primaryRequestDocuments(snapshot),
              },
              scored,
              Boolean(p.configurationId),
            ),
            snapshot,
          ),
        ];
      });
  }
  if (!mapped.startsWith('kindergarten-')) return [];
  const sourceRows = kindergartenRecords.length
    ? kindergartenRecords
    : assessments.map((row) => ({ ...row, collection: 'assessments' }));
  const groups = new Map<string, { term: number; round: number; month: string; rows: any[]; attendance: any[] }>();
  const ensureGroup = (term: number, round: number, month: string) => {
    const id = `${term}:${round}:${month}`;
    let group = groups.get(id);
    if (!group) {
      group = { term, round, month, rows: [], attendance: [] };
      groups.set(id, group);
    }
    return group;
  };
  const recordKey = (row: any) => String(row.key || row.record_key || '');
  const payload = (row: any) => row.value || row.payload;
  const monthFrom = (row: any, parts: string[]) => {
    const value = parts[3]?.match(/^\d{4}-\d{2}$/)?.[0] || payload(row)?.date?.slice?.(0, 7) || '';
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : '';
  };
  const startYear = Number(String(scope.year_name || '').match(/\d{4}/)?.[0]);
  const defaultTerm2 = Number.isInteger(startYear) ? `${startYear + 1}-02-01` : '';
  const term2Start = validDate(school?.term2Start) ? school.term2Start : defaultTerm2;
  const termForMonth = (month: string) => month && term2Start
    ? `${month}-01` >= term2Start ? 2 : 1
    : 1;
  const monthlyRows: any[] = [];
  const activityRows: any[] = [];
  for (const row of sourceRows) {
    const collection = row.collection || 'assessments';
    const parts = recordKey(row).split('|');
    if (!payload(row) || !['growth', 'assessments', 'activities', 'daily', 'weekly', 'reviews'].includes(collection)) continue;
    if (collection === 'assessments' && parts.length === 7 && ['1', '2'].includes(parts[5]) && ['1', '2'].includes(parts[6])) {
      const month = monthFrom(row, parts);
      ensureGroup(Number(parts[5]), Number(parts[6]), month).rows.push(row);
    } else if (collection === 'growth' && parts.length === 6 && ['1', '2'].includes(parts[4]) && ['1', '2'].includes(parts[5])) {
      const month = monthFrom(row, parts);
      ensureGroup(Number(parts[4]), Number(parts[5]), month).rows.push(row);
    } else if (collection === 'activities') {
      activityRows.push(row);
    } else if (['daily', 'weekly', 'reviews'].includes(collection)) {
      monthlyRows.push(row);
    }
  }
  const monthsWithRecords = new Set<string>();
  for (const row of monthlyRows) {
    const parts = recordKey(row).split('|');
    const month = monthFrom(row, parts);
    if (!month) continue;
    const term = termForMonth(month);
    monthsWithRecords.add(month);
    const matches = [...groups.values()].filter((group) => group.term === term && group.month === month);
    (matches.length ? matches : [ensureGroup(term, 1, month)]).forEach((group) => group.rows.push(row));
  }
  for (const row of activityRows) {
    const parts = recordKey(row).split('|');
    const month = monthFrom(row, parts);
    if (!month) continue;
    const term = termForMonth(month);
    const matches = [...groups.values()].filter((group) => group.term === term && group.month === month);
    (matches.length ? matches : [ensureGroup(term, 1, month)]).forEach((group) => group.rows.push(row));
  }
  for (const row of kindergartenAttendance) {
    const date = String(row.attendance_date || '').slice(0, 10);
    if (!validDate(date)) continue;
    const month = date.slice(0, 7);
    const term = termForMonth(month);
    const matches = [...groups.values()].filter((group) => group.term === term && group.month === month);
    const target = matches.length ? matches : [ensureGroup(term, 1, month)];
    for (const group of target) group.attendance.push(row);
  }
  for (const report of kindergartenReports) {
    if (!Array.isArray(report.snapshot?.options?.studentIds) || !report.snapshot.options.studentIds.includes(scope.studentId)) continue;
    const options = report.snapshot.options;
    if (report.kind === 'art' && options.kind === 'art' && /^\d{4}-(0[1-9]|1[0-2])$/.test(options.month || '')) {
      ensureGroup(termForMonth(options.month), 1, options.month);
    } else if (report.kind === 'main' && options.kind === 'main' && options.document === 'development'
      && [1, 2].includes(options.assessmentRound)) {
      ensureGroup(1, options.assessmentRound, '');
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => {
      const rows = [...new Map(group.rows.map((row) => [recordKey(row), row])).values()]
        .sort((a, b) => recordKey(a).localeCompare(recordKey(b)));
      const records = rows.map((row) => ({ collection: row.collection || 'assessments', key: recordKey(row), value: payload(row) }));
      const attendance = [...new Map(group.attendance.map((row) => [row.attendance_date, row])).values()]
        .sort((a, b) => String(a.attendance_date).localeCompare(String(b.attendance_date)));
      // Hash the actual portal inputs so a changed record refreshes the selectable request.
      const digest = createHash('sha256').update(JSON.stringify({ records, attendance, school })).digest('hex');
      const { term, round, month } = group;
      const dates = [
        ...rows.map((row) => payload(row)?.date),
        ...attendance.map((row) => String(row.attendance_date || '').slice(0, 10)),
      ].filter(validDate).sort();
      const studentIn = (report: any) =>
        Array.isArray(report.snapshot?.options?.studentIds) &&
        report.snapshot.options.studentIds.includes(scope.studentId);
      const art = kindergartenReports.find(
        (report) =>
          report.kind === 'art' &&
          report.snapshot?.options?.kind === 'art' &&
          report.snapshot.options.month === month &&
          studentIn(report),
      );
      const development = kindergartenReports.find(
        (report) =>
          report.kind === 'main' &&
          report.snapshot?.options?.kind === 'main' &&
          report.snapshot.options.document === 'development' &&
          report.snapshot.options.assessmentRound === round &&
          studentIn(report),
      );
      const template = {
        family: 'kindergarten',
        templateId: mapped,
        templateVersion: `kg${mapped.slice(-1)}-original-1`,
      };
      const hasArtData = records.some((row) => ['daily', 'activities'].includes(row.collection));
      const hasDevelopmentData = records.some((row) => ['growth', 'assessments', 'daily', 'weekly', 'reviews'].includes(row.collection)) || attendance.length > 0;
      const artTemplateVersion = `kg${mapped.slice(-1)}-original-1`;
      const developmentTemplateVersion = `kg${mapped.slice(-1)}-individual-development-2014-1`;
      const documents: Record<string, any>[] = [
        {
          id: 'kindergarten-art-monthly',
          label: 'Monthly art book',
          labelLo: 'ຜົນງານສິລະປະປະຈຳເດືອນ',
          canRequest: Boolean(art) || hasArtData,
          ...(art
            ? {
                sourceReportId: art.id,
                sourceVersion: Math.max(1, Number(art.revision) || 1),
                templateVersion: art.snapshot.templateVersion,
                sourceMode: 'snapshot',
              }
            : hasArtData
              ? { sourceMode: 'records', templateVersion: artTemplateVersion }
              : {
                  unavailableReason: 'No monthly artwork has been entered for this period.',
                  unavailableReasonLo: 'ຍັງບໍ່ມີຜົນງານສິລະປະໃນໄລຍະນີ້',
                }),
        },
        {
          id: 'kindergarten-development',
          label: 'Development book',
          labelLo: 'ປຶ້ມຕິດຕາມພັດທະນາການ',
          canRequest: Boolean(development) || hasDevelopmentData,
          ...(development
            ? {
                sourceReportId: development.id,
                sourceVersion: Math.max(1, Number(development.revision) || 1),
                templateVersion: development.snapshot.templateVersion,
                sourceMode: 'snapshot',
              }
            : hasDevelopmentData
              ? { sourceMode: 'records', templateVersion: developmentTemplateVersion }
              : {
                  unavailableReason: 'No development data has been entered for this period.',
                  unavailableReasonLo: 'ຍັງບໍ່ມີຂໍ້ມູນພັດທະນາການໃນໄລຍະນີ້',
                }),
        },
      ];
      const sources = Object.fromEntries(
        documents.flatMap((document) =>
          document.canRequest
            ? [[document.id, document.sourceMode === 'snapshot'
                ? {
                    mode: 'snapshot', reportId: document.sourceReportId,
                    sourceVersion: document.sourceVersion, templateVersion: document.templateVersion,
                  }
                : { mode: 'records', templateVersion: document.templateVersion }]]
            : [],
        ),
      );
      const sourceDigest = createHash('sha256')
        .update(JSON.stringify({ digest, sources }))
        .digest('hex');
      const sourceReportId = `kg-${sourceDigest}`;
      const sourceVersion = Math.max(1, Number.parseInt(sourceDigest.slice(0, 12), 16));
      return selection(
        term,
        availability(
          {
          id: `kindergarten:${term}:${round}:${month || 'all'}:${sourceDigest}`,
          sourceReportId,
          sourceVersion,
          label: month ? `${new Date(`${month}-01T00:00:00Z`).toLocaleString('en', { month: 'long', timeZone: 'UTC' })} ${month.slice(0, 4)} · Round ${round}` : `Assessment ${round}`,
          labelLo: month ? `${monthLo[months.indexOf(Number(month.slice(5, 7)))] || 'ໄລຍະ'} ${month.slice(0, 4)} · ຄັ້ງທີ ${round}` : `ການປະເມີນຄັ້ງທີ ${round}`,
            reportingStart: dates[0] || (month ? `${month}-01` : ''),
            reportingEnd: dates.at(-1) || (month ? `${month}-${new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()}` : ''),
            format: `Kindergarten ${mapped.slice(-1)}`,
            formatLo: `ອະນຸບານ ${mapped.slice(-1)}`,
            template,
            documents,
          },
          documents.some((document) => document.canRequest),
          true,
        ),
        {
          template, term, round, month, sourceReportId, sourceVersion, studentId: scope.studentId, branchId: scope.branchId,
          classId: scope.classId, academicYearId: scope.academicYearId,
          academicYear: scope.academicYear, gradeId: scope.grade_id, records, attendance, school: school || {}, documentSources: sources,
        },
      );
    });
}
