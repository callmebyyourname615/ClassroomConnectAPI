import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import sharp from 'sharp';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalize = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[໐-໙]/g, (c) => String(c.charCodeAt(0) - '໐'.charCodeAt(0)))
    .replace(/[๐-๙]/g, (c) => String(c.charCodeAt(0) - '๐'.charCodeAt(0)))
    .replace(/[.\s_-]+/g, '');

export function studentReportTemplate(grade: any, mappings: any): string {
  const manual = mappings?.[grade.grade_id];
  if (['kindergarten-1', 'kindergarten-2', 'kindergarten-3'].includes(manual))
    return manual;
  if (manual === '') return 'unmapped';
  const labels = [
    grade.grade_name,
    grade.grade_translations?.la,
    grade.grade_translations?.en,
  ]
    .filter((v): v is string => typeof v === 'string')
    .flatMap((v) => [
      v.split('(')[0],
      ...Array.from(v.matchAll(/\(([^)]+)\)/g), (m) => m[1]),
    ]);
  const level = normalize(grade.level_name || '');
  if (/primary|elementary|ປະຖົມ|ประถม/.test(level)) return 'primary';
  for (const label of labels) {
    const n = normalize(label);
    const kg =
      n.match(
        /^(?:ອະນຸບານ|ອານຸບານ|ອນຸບານ|ອບ|ອນ|อนุบาล|อนบ|อบ|kindergarten|kg|k)(?:ຊັ້ນ|ชั้น|level)?([123])(?:\/\d+)?$/,
      ) ||
      (/kindergarten|ອະນຸບານ|ອານຸບານ|อนุบาล/.test(level)
        ? n.match(/^([123])(?:\/\d+)?$/)
        : null);
    if (kg) return `kindergarten-${kg[1]}`;
    if (/^(?:primary|elementary|grade|p|ປ|ປະຖົມ|ประถม)[1-6](?:\/\d+)?$/.test(n))
      return 'primary';
  }
  return 'unmapped';
}

export function visibleStudentRecords(
  records: any[],
  student: string,
  month: string,
) {
  // Review status describes the saved work; it is not a publication switch.
  // Keep the same student/month boundaries for both draft and reviewed work.
  return records
    .filter((r) => {
      if (!r.value || typeof r.value !== 'object') return false;
      const p = r.key.split('|');
      switch (r.collection) {
        case 'growth':
          return p.length === 6 && p[3] === student;
        case 'assessments':
          return p.length === 7 && p[3] === student;
        case 'reviews':
          return p.length === 5 && p[3] === month && p[4] === student;
        case 'activities':
          return p.length === 6 && p[3] === month;
        case 'daily':
          return (
            p.length === 7 && p[3] === month && p[6] === student
          );
        case 'weekly':
          return (
            p.length === 6 && p[3] === month && p[4] === student
          );
        default:
          return false;
      }
    })
    .map(({ collection, key, value }) => ({ collection, key, value }));
}

@Injectable()
export class StudentReportsService {
  constructor(private readonly db: DataSource) {}

  private async scope(
    user: any,
    student: string,
    query: Record<string, string>,
  ) {
    const { branchId, classId, academicYearId } = query;
    if (
      ![student, branchId, classId, academicYearId].every((v) =>
        uuid.test(v || ''),
      )
    )
      throw new BadRequestException(
        'Student, branch, class and academic year are required.',
      );
    if (!user?.sub)
      throw new ForbiddenException('Sign in to view this report.');
    // The relationship is checked on every request, including image downloads.
    if (user.user_type === 'parent') {
      const [parent] = await this.db.query(
        `SELECT p.id FROM parents p
        JOIN student_parents sp ON sp.parent_id=p.id
        WHERE p.id=$1 AND sp.student_id=$2 AND p."isActive"=true AND p."isDeleted"=false`,
        [user.sub, student],
      );
      if (!parent)
        throw new ForbiddenException(
          'This student is not linked to your account.',
        );
    } else {
      const [admin] = await this.db.query(
        'SELECT id FROM admins WHERE id=$1 AND branch_id=$2 AND is_active=true AND is_deleted=false',
        [user.sub, branchId],
      );
      if (!admin)
        throw new ForbiddenException(
          'This branch is not assigned to your account.',
        );
    }
    const [scope] = await this.db.query(
      `SELECT y.year_name,y.start_date,y.end_date,
      g.id AS grade_id,g.name AS grade_name,g.name_translations AS grade_translations,l.name AS level_name
      FROM enrollments e JOIN students s ON s.id=e.student_id JOIN classes c ON c.id=e.class_id
      JOIN academic_years y ON y.id=e.academic_year_id JOIN year_levels g ON g.id=c.year_level_id
      JOIN levels l ON l.id=g.level_id WHERE e.student_id=$1 AND e.branch_id=$2 AND e.class_id=$3
      AND e.academic_year_id=$4 AND e.is_active=true AND s.is_active=true AND s.is_deleted=false AND c.is_deleted=false`,
      [student, branchId, classId, academicYearId],
    );
    if (!scope)
      throw new ForbiddenException(
        'Student is not enrolled in this class and academic year.',
      );
    return scope;
  }

  async report(user: any, student: string, query: Record<string, string>) {
    const scope = await this.scope(user, student, query);
    const { branchId, classId, academicYearId } = query;
    const [school] = await this.db.query(
      "SELECT payload FROM kindergarten_records WHERE branch_id=$1 AND collection='school' AND record_key=$1::text",
      [branchId],
    );
    let mappings = {};
    try {
      mappings = JSON.parse(school?.payload?.reportTemplates || '{}');
    } catch {
      /* No manual mapping. */
    }
    const template = studentReportTemplate(scope, mappings);
    const yearLabel = scope.year_name.replace('–', '-');
    const start = Number(yearLabel.match(/\d{4}/)?.[0]);
    if (!Number.isInteger(start))
      throw new BadRequestException('Invalid academic year label.');
    const months = Array.from(
      { length: 9 },
      (_, i) =>
        `${i < 4 ? start : start + 1}-${String(((i + 8) % 12) + 1).padStart(2, '0')}`,
    );
    const now = new Date()
      .toLocaleDateString('sv-SE', { timeZone: 'Asia/Vientiane' })
      .slice(0, 7);
    const calendarMonth = query.calendarMonth
      ? Number(query.calendarMonth)
      : null;
    if (
      query.calendarMonth &&
      (!Number.isInteger(calendarMonth) ||
        calendarMonth! < 1 ||
        calendarMonth! > 12)
    )
      throw new BadRequestException('Invalid calendar month.');
    const month =
      query.month ||
      months.find((m) => Number(m.slice(-2)) === calendarMonth) ||
      (months.includes(now) ? now : months[0]);
    if (!months.includes(month) && template.startsWith('kindergarten-'))
      throw new BadRequestException('Month is outside this academic year.');
    const context = {
      studentId: student,
      branchId,
      classId,
      academicYearId,
      academicYear: yearLabel,
      template,
      month,
      months,
    };
    if (!template.startsWith('kindergarten-'))
      return { ...context, records: [] };
    // Filter by the full scope before projecting only this child's records.
    const records = await this.db.query(
      `SELECT collection,record_key AS key,payload AS value FROM kindergarten_records
      WHERE branch_id=$1 AND split_part(record_key,'|',1)=$1::text AND split_part(record_key,'|',2)=$2
      AND split_part(record_key,'|',3) IN ($3,$3 || '::' || $4)
      AND ((collection IN ('growth','assessments') AND split_part(record_key,'|',4)=$5)
        OR (collection='activities' AND split_part(record_key,'|',4)=$6)
        OR (collection='daily' AND split_part(record_key,'|',4)=$6 AND split_part(record_key,'|',7)=$5)
        OR (collection IN ('reviews','weekly') AND split_part(record_key,'|',4)=$6 AND split_part(record_key,'|',5)=$5))`,
      [branchId, yearLabel, classId, academicYearId, student, month],
    );
    return {
      ...context,
      records: visibleStudentRecords(records, student, month),
    };
  }

  async image(
    user: any,
    student: string,
    assetId: string,
    query: Record<string, string>,
  ) {
    const report = await this.report(user, student, query);
    let attachment: any;
    let evidence = false;
    for (const record of report.records) {
      if (record.collection === 'daily') {
        attachment ||= record.value.attachments?.find(
          (a: any) => a.assetId === assetId && a.id === query.attachmentId,
        );
      }
      if (record.collection === 'assessments') {
        evidence ||= record.value.evidenceFiles?.some(
          (f: any) => f.assetId === assetId && f.mime?.startsWith('image/'),
        );
      }
    }
    if (!attachment && !evidence)
      throw new NotFoundException('Image is not part of this student report.');
    const [asset] = await this.db.query(
      'SELECT mime,content FROM kindergarten_assets WHERE branch_id=$1 AND id=$2',
      [query.branchId, assetId],
    );
    if (!asset?.mime?.startsWith('image/'))
      throw new NotFoundException('Image not found.');
    let content: Buffer = asset.content;
    if (attachment) {
      const meta = await sharp(content).metadata();
      const width = meta.width!,
        height = meta.height!;
      const overlays = (attachment.redactions || []).map((r: any) => {
        const left = Math.min(width - 1, Math.floor(r.x * width));
        const top = Math.min(height - 1, Math.floor(r.y * height));
        return {
          left,
          top,
          input: {
            create: {
              width: Math.max(
                1,
                Math.min(width - left, Math.ceil(r.w * width)),
              ),
              height: Math.max(
                1,
                Math.min(height - top, Math.ceil(r.h * height)),
              ),
              channels: 4 as const,
              background: '#000000',
            },
          },
        };
      });
      // Mask the source before cropping/rotating; never send unmasked artwork to parents.
      if (overlays.length)
        content = await sharp(content).composite(overlays).png().toBuffer();
      const crop = attachment.crop;
      const left = Math.floor(Math.max(0, Math.min(0.95, crop.x)) * width);
      const top = Math.floor(Math.max(0, Math.min(0.95, crop.y)) * height);
      content = await sharp(content)
        .extract({
          left,
          top,
          width: Math.max(
            1,
            Math.min(width - left, Math.floor(crop.w * width)),
          ),
          height: Math.max(
            1,
            Math.min(height - top, Math.floor(crop.h * height)),
          ),
        })
        .toBuffer();
      content = await sharp(content)
        .rotate(attachment.rotation)
        .resize({
          width: 1600,
          height: 1600,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();
    }
    return {
      mime: attachment ? 'image/png' : asset.mime,
      data: content.toString('base64'),
    };
  }
}
