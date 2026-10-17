import { summarizeMontessoriAttendance } from './montessori.attendance';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { isDeepStrictEqual } from 'node:util';
import { montessoriStudentName as studentName } from './montessori.names';
import {
  montessoriTemplates,
  montessoriTemplateVersion,
} from './montessori.templates';
import { SaveMontessoriReport } from './montessori.dto';
import {
  levels,
  progress,
  validateReport,
  validUuid,
  validDate,
} from './montessori.validation';
const actorName = (a: any) =>
  [a.first_name || a.first_name_La, a.last_name || a.last_name_La]
    .filter(Boolean)
    .join(' ') || 'Staff';
@Injectable()
export class MontessoriService {
  constructor(private readonly db: DataSource) {}
  async authorize(user: any, branch: string) {
    if (
      !validUuid(user?.sub) ||
      user.user_type === 'parent' ||
      !validUuid(branch)
    )
      throw new ForbiddenException('Staff access required.');
    const [admin] = await this.db.query(
      `SELECT a.*, COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL),'{}') AS role_names
      FROM admins a LEFT JOIN admin_roles ar ON ar.admin_id=a.id LEFT JOIN roles r ON r.id=ar.role_id AND r."isDeleted"=false
      WHERE a.id=$1 AND a.branch_id=$2 AND a.is_deleted=false AND a.is_active=true GROUP BY a.id`,
      [user.sub, branch],
    );
    if (!admin)
      throw new ForbiddenException(
        'This branch is not assigned to your account.',
      );
    const roles = admin.role_names.map((r: string) => r.toLowerCase());
    const canManageReports = roles.some((r: string) =>
      [
        'admin',
        'super admin',
        'super super admin',
        'reviewer',
        'director',
        'managing director',
      ].includes(r),
    );
    if (!canManageReports && !roles.includes('teacher'))
      throw new ForbiddenException('Teacher or administrator access required.');
    return { id: admin.id as string, name: actorName(admin), canManageReports };
  }
  async context(user: any, branch: string) {
    const actor = await this.authorize(user, branch);
    const [years, students, schools] = await Promise.all([
      this.db.query(
        'SELECT id,year_name AS name,start_date AS "startDate",end_date AS "endDate",is_active AS active FROM academic_years WHERE branch_id=$1 AND is_deleted=false ORDER BY start_date DESC',
        [branch],
      ),
      this.db.query(
        `SELECT DISTINCT s.id AS "studentId",s.first_name_eng,s.last_name_eng,s.first_name_lao,s.last_name_lao,s.dob,
        c.id AS "classId",c.name AS "className",e.academic_year_id AS "academicYearId",y.year_name AS "academicYear"
        FROM enrollments e JOIN students s ON s.id=e.student_id JOIN classes c ON c.id=e.class_id JOIN academic_years y ON y.id=e.academic_year_id
        WHERE e.branch_id=$1 AND y.branch_id=$1 AND e.is_active=true AND s.is_deleted=false AND c.is_deleted=false AND y.is_deleted=false
        ORDER BY c.name,s.first_name_lao`,
        [branch],
      ),
      this.db.query('SELECT id,name FROM branches WHERE id=$1', [branch]),
    ]);
    return {
      actor,
      templates: montessoriTemplates,
      templateVersion: montessoriTemplateVersion,
      school: schools[0],
      years,
      students: students.map((s: any) => ({
        studentId: s.studentId,
        student: studentName(s),
        initials: studentName(s)
          .split(/\s+/)
          .slice(0, 2)
          .map((x: string) => x[0])
          .join(''),
        birthDate: s.dob ? new Date(s.dob).toISOString().slice(0, 10) : '',
        classId: s.classId,
        className: s.className,
        academicYearId: s.academicYearId,
        academicYear: s.academicYear,
      })),
    };
  }
  private async attendanceSnapshot(
    query: (sql: string, params: any[]) => Promise<any[]>,
    document: Record<string, any>,
    year: { start: string; end: string },
  ) {
    const today = new Date().toLocaleDateString('sv-SE', {
      timeZone: 'Asia/Vientiane',
    });
    const rows = await query(
      `SELECT to_char(attendance_date,'YYYY-MM-DD') AS attendance_date,type,reason,remark
       FROM attendances WHERE student_id=$1 AND attendance_date BETWEEN $2::date AND $3::date
       ORDER BY attendance_date,updated_at,id`,
      [document.studentId, year.start, year.end],
    );
    return summarizeMontessoriAttendance(
      rows,
      {
        yearStart: year.start,
        yearEnd: year.end,
        start: document.reportingStart || '',
        end: document.reportingEnd || '',
        today,
        level: document.level,
      },
      document.attendance,
    );
  }
  async attendance(user: any, branch: string, query: Record<string, string>) {
    await this.authorize(user, branch);
    for (const key of ['studentId', 'classId', 'academicYearId'])
      if (!validUuid(query[key]))
        throw new BadRequestException(`Invalid ${key}.`);
    if (
      !levels.includes(query.level) ||
      (query.start && !validDate(query.start)) ||
      (query.end && !validDate(query.end)) ||
      (query.start && query.end && query.start > query.end)
    )
      throw new BadRequestException('Invalid attendance period or level.');
    const [scope] = await this.db.query(
      `SELECT to_char(y.start_date,'YYYY-MM-DD') AS start,to_char(y.end_date,'YYYY-MM-DD') AS end
       FROM enrollments e JOIN students s ON s.id=e.student_id JOIN classes c ON c.id=e.class_id JOIN academic_years y ON y.id=e.academic_year_id
       WHERE e.branch_id=$1 AND y.branch_id=$1 AND e.student_id=$2 AND e.class_id=$3 AND e.academic_year_id=$4
       AND s.is_deleted=false AND c.is_deleted=false AND y.is_deleted=false LIMIT 1`,
      [branch, query.studentId, query.classId, query.academicYearId],
    );
    if (!scope)
      throw new ForbiddenException(
        'Student is not enrolled in this branch, classroom and school year.',
      );
    return this.attendanceSnapshot(
      this.db.query.bind(this.db),
      { ...query, reportingStart: query.start, reportingEnd: query.end },
      scope,
    );
  }
  private serialize(row: any) {
    return {
      ...row.payload,
      id: row.id,
      version: row.version,
      createdBy: row.created_by,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      updated: new Date(row.updated_at).toISOString(),
      progress: progress(row.payload),
    };
  }
  async list(user: any, branch: string, query: Record<string, string> = {}) {
    await this.authorize(user, branch);
    const limit = Number(query.limit ?? 100),
      offset = Number(query.offset ?? 0);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isInteger(offset) ||
      offset < 0
    )
      throw new BadRequestException('Invalid pagination.');
    const params: any[] = [branch];
    const conditions = ['branch_id=$1'];
    for (const [key, column] of [
      ['studentId', 'student_id'],
      ['classId', 'class_id'],
      ['academicYearId', 'academic_year_id'],
    ]) {
      if (query[key]) {
        if (!validUuid(query[key]))
          throw new BadRequestException(`Invalid ${key}.`);
        params.push(query[key]);
        conditions.push(`${column}=$${params.length}`);
      }
    }
    for (const [key, allowed] of [['level', levels]] as const) {
      if (query[key]) {
        if (!allowed.includes(query[key]))
          throw new BadRequestException(`Invalid ${key}.`);
        params.push(query[key]);
        conditions.push(`${key}=$${params.length}`);
      }
    }
    const where = conditions.join(' AND ');
    const [count] = await this.db.query(
      `SELECT count(*)::int AS total FROM montessori_reports WHERE ${where}`,
      params,
    );
    const rows = await this.db.query(
      `SELECT * FROM montessori_reports WHERE ${where} ORDER BY updated_at DESC,id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return {
      reports: rows.map((r: any) => this.serialize(r)),
      total: count.total,
      limit,
      offset,
    };
  }
  private async record(
    manager: EntityManager | DataSource,
    branch: string,
    id: string,
    lock = false,
  ) {
    const [row] = await manager.query(
      `SELECT * FROM montessori_reports WHERE id=$1 AND branch_id=$2${lock ? ' FOR UPDATE' : ''}`,
      [id, branch],
    );
    if (!row) throw new NotFoundException('Report not found.');
    return row;
  }
  async get(user: any, branch: string, id: string) {
    await this.authorize(user, branch);
    return this.serialize(await this.record(this.db, branch, id));
  }
  async history(user: any, branch: string, id: string) {
    await this.authorize(user, branch);
    await this.record(this.db, branch, id);
    return this.db.query(
      'SELECT version,action,note,actor_id AS "actorId",created_at AS "createdAt" FROM montessori_report_revisions WHERE report_id=$1 ORDER BY version DESC',
      [id],
    );
  }
  private checkEditor(
    actor: { id: string; canManageReports: boolean },
    row: any,
  ) {
    if (!actor.canManageReports && row.created_by !== actor.id)
      throw new ForbiddenException(
        'Only the report author or an administrator can edit this report.',
      );
  }
  private async revision(
    manager: EntityManager,
    row: any,
    actor: string,
    action: string,
    note = '',
  ) {
    await manager.query(
      'INSERT INTO montessori_report_revisions(report_id,version,status,payload,actor_id,action,note) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)',
      [
        row.id,
        row.version,
        row.status,
        JSON.stringify(row.payload),
        actor,
        action,
        note,
      ],
    );
  }
  async save(
    user: any,
    branch: string,
    id: string,
    body: SaveMontessoriReport,
  ) {
    const actor = await this.authorize(user, branch);
    if (
      body.id !== id ||
      !validUuid(id) ||
      !Number.isInteger(body.expectedVersion) ||
      body.expectedVersion < 0
    )
      throw new BadRequestException('Invalid report ID or version.');
    const document = validateReport(body.report);
    return this.db.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);
      const [current] = await manager.query(
        'SELECT * FROM montessori_reports WHERE id=$1 AND branch_id=$2 FOR UPDATE',
        [id, branch],
      );
      if (current) {
        this.checkEditor(actor, current);
        for (const key of [
          'studentId',
          'classId',
          'academicYearId',
          'level',
          'term',
          'templateVersion',
          'subjects',
        ])
          if (!isDeepStrictEqual(document[key], current.payload[key]))
            throw new BadRequestException(
              'Report identity and template snapshot cannot change. Create a new report instead.',
            );
      }
      const [scope] = await manager.query(
        `SELECT s.*,c.name AS class_name,y.year_name,y.start_date,y.end_date,to_char(y.start_date,'YYYY-MM-DD') AS attendance_year_start,to_char(y.end_date,'YYYY-MM-DD') AS attendance_year_end,b.name AS school_name FROM enrollments e
        JOIN students s ON s.id=e.student_id JOIN classes c ON c.id=e.class_id JOIN academic_years y ON y.id=e.academic_year_id JOIN branches b ON b.id=e.branch_id
        WHERE e.branch_id=$1 AND e.student_id=$2 AND e.class_id=$3 AND e.academic_year_id=$4 AND y.branch_id=$1 AND s.is_deleted=false AND c.is_deleted=false AND y.is_deleted=false LIMIT 1`,
        [branch, document.studentId, document.classId, document.academicYearId],
      );
      if (!scope)
        throw new BadRequestException(
          'Student is not enrolled in this branch, class and academic year.',
        );
      const attendance = await this.attendanceSnapshot(
        manager.query.bind(manager),
        document,
        { start: scope.attendance_year_start, end: scope.attendance_year_end },
      );
      const payload = {
        ...document,
        attendance: attendance.attendance,
        student: studentName(scope),
        initials: studentName(scope)
          .split(/\s+/)
          .slice(0, 2)
          .map((x: string) => x[0])
          .join(''),
        birthDate: scope.dob
          ? new Date(scope.dob).toISOString().slice(0, 10)
          : '',
        className: scope.class_name,
        academicYear: scope.year_name,
        schoolName: scope.school_name,
        teacher: current?.payload.teacher || actor.name,
      };
      if ((current?.version || 0) !== body.expectedVersion) {
        if (current && isDeepStrictEqual(current.payload, payload))
          return this.serialize(current);
        throw new ConflictException(
          'This report changed on another device. Reload before saving.',
        );
      }
      let saved: any;
      if (current) {
        const [updatedRows] = await manager.query(
          'UPDATE montessori_reports SET payload=$3::jsonb,version=version+1,updated_by=$4,updated_at=now() WHERE id=$1 AND branch_id=$2 RETURNING *',
          [id, branch, JSON.stringify(payload), actor.id],
        );
        saved = updatedRows[0];
      } else {
        [saved] = await manager.query(
          `INSERT INTO montessori_reports(id,branch_id,student_id,class_id,academic_year_id,level,term,payload,created_by,updated_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9) ON CONFLICT(id) DO NOTHING RETURNING *`,
          [
            id,
            branch,
            document.studentId,
            document.classId,
            document.academicYearId,
            document.level,
            document.term,
            JSON.stringify(payload),
            actor.id,
          ],
        );
        if (!saved) throw new ConflictException('Report ID already exists.');
      }
      await this.revision(
        manager,
        saved,
        actor.id,
        current ? 'save' : 'create',
      );
      return this.serialize(saved);
    });
  }
}
