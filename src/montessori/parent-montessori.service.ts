import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { behavior, stages, validUuid } from './montessori.validation';
import { summarizeMontessoriAttendance } from './montessori.attendance';

@Injectable()
export class ParentMontessoriService {
  constructor(private readonly db: DataSource) {}

  private async scope(
    user: any,
    student: string,
    query: Record<string, string>,
  ) {
    const { branchId, classId, academicYearId } = query;
    if (![student, branchId, classId, academicYearId].every(validUuid))
      throw new BadRequestException(
        'Student, branch, classroom and school year are required.',
      );
    if (user?.user_type !== 'parent' || !validUuid(user?.sub))
      throw new ForbiddenException('Parent access required.');
    // A pending link request is not a relationship in student_parents.
    const [enrollment] = await this.db.query(
      `SELECT s.id,to_char(y.start_date,'YYYY-MM-DD') AS start,to_char(y.end_date,'YYYY-MM-DD') AS end
       FROM parents p JOIN student_parents sp ON sp.parent_id=p.id
       JOIN students s ON s.id=sp.student_id JOIN enrollments e ON e.student_id=s.id
       JOIN classes c ON c.id=e.class_id
       JOIN academic_years y ON y.id=e.academic_year_id AND y.branch_id=e.branch_id
       WHERE p.id=$1 AND s.id=$2 AND e.branch_id=$3 AND e.class_id=$4 AND e.academic_year_id=$5
       AND p."isActive"=true AND p."isDeleted"=false
       AND s.is_active=true AND s.is_deleted=false AND e.is_active=true AND c.is_deleted=false AND y.is_deleted=false`,
      [user.sub, student, branchId, classId, academicYearId],
    );
    if (!enrollment)
      throw new ForbiddenException(
        'This student enrollment is not linked to your account.',
      );
    return {
      params: [branchId, student, classId, academicYearId],
      year: enrollment,
    };
  }

  private serialize(row: any, detail = false) {
    const p = row.payload || {};
    const subjects = Array.isArray(p.subjects) ? p.subjects : [];
    let total = 0,
      assessed = 0;
    subjects.forEach((s: any, i: number) => {
      (Array.isArray(s.skills) ? s.skills : []).forEach((_: any, j: number) => {
        total++;
        const key = `${i}:${j}`;
        if (
          behavior(String(s.subject))
            ? [1, 2, 3, 4].includes(p.behaviorRatings?.[key])
            : stages.includes(p.ratings?.[key])
        )
          assessed++;
      });
    });
    const summary = {
      id: row.id,
      version: row.version,
      studentId: row.student_id,
      classId: row.class_id,
      academicYearId: row.academic_year_id,
      level: row.level,
      term: row.term,
      student: p.student || '',
      className: p.className || '',
      academicYear: p.academicYear || '',
      reportingStart: p.reportingStart || '',
      reportingEnd: p.reportingEnd || '',
      updatedAt: new Date(row.updated_at).toISOString(),
      assessment: {
        assessed,
        total,
        percent: total ? Math.round((assessed / total) * 100) : 0,
      },
    };
    if (!detail) return summary;
    return {
      ...summary,
      templateVersion: p.templateVersion || '',
      schoolName: p.schoolName || '',
      teacher: p.teacher || '',
      subjects,
      ratings: p.ratings || {},
      behaviorRatings: p.behaviorRatings || {},
      comments: p.comments || {},
      coverage: p.coverage || {},
      summaryComment: p.summaryComment || '',
      attendance: p.attendance || {},
    };
  }

  async list(user: any, student: string, query: Record<string, string>) {
    const { params: scope } = await this.scope(user, student, query);
    const limit = Number(query.limit ?? 100),
      offset = Number(query.offset ?? 0);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0
    )
      throw new BadRequestException('Invalid pagination.');
    const where =
      'branch_id=$1 AND student_id=$2 AND class_id=$3 AND academic_year_id=$4';
    const [count] = await this.db.query(
      `SELECT count(*)::int AS total FROM montessori_reports WHERE ${where}`,
      scope,
    );
    const rows = await this.db.query(
      `SELECT * FROM montessori_reports WHERE ${where} ORDER BY updated_at DESC,id ASC LIMIT $5 OFFSET $6`,
      [...scope, limit, offset],
    );
    return {
      reports: rows.map((r: any) => this.serialize(r)),
      total: count.total,
      limit,
      offset,
    };
  }

  async detail(
    user: any,
    student: string,
    id: string,
    query: Record<string, string>,
  ) {
    const { params: scope, year } = await this.scope(user, student, query);
    if (!validUuid(id)) throw new BadRequestException('Invalid report.');
    const [row] = await this.db.query(
      'SELECT * FROM montessori_reports WHERE branch_id=$1 AND student_id=$2 AND class_id=$3 AND academic_year_id=$4 AND id=$5',
      [...scope, id],
    );
    if (!row) throw new NotFoundException('Report not found.');
    const report = this.serialize(row, true);
    const records = await this.db.query(
      `SELECT to_char(attendance_date,'YYYY-MM-DD') AS attendance_date,type,reason,remark
       FROM attendances WHERE student_id=$1 AND attendance_date BETWEEN $2::date AND $3::date
       ORDER BY attendance_date,updated_at,id`,
      [student, year.start, year.end],
    );
    // Older snapshots may contain only nulls; reads use the same source rules as staff saves.
    const source = summarizeMontessoriAttendance(
      records,
      {
        yearStart: year.start,
        yearEnd: year.end,
        start: report.reportingStart,
        end: report.reportingEnd,
        today: new Date().toLocaleDateString('sv-SE', {
          timeZone: 'Asia/Vientiane',
        }),
        level: report.level,
      },
      row.payload?.attendance || {},
    );
    return { ...report, attendance: source.attendance };
  }
}
