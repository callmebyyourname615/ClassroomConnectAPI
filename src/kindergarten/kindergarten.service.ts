import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import sharp from 'sharp';
import { KindergartenChange } from './kindergarten.dto';
const collections = [
  'school',
  'rosterOrders',
  'holidays',
  'growth',
  'assessments',
  'activities',
  'daily',
  'weekly',
  'reviews',
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
@Injectable()
export class KindergartenService {
  constructor(private readonly db: DataSource) {}
  async authorize(user: any, branch: string) {
    // Resolve branch membership from DB, not from client query or stale JWT roles.
    if (!user?.sub || user.user_type === 'parent' || !uuid.test(branch))
      throw new ForbiddenException('Teacher access required.');
    const [admin] = await this.db.query(
      'SELECT branch_id FROM admins WHERE id=$1 AND is_deleted=false AND is_active=true',
      [user.sub],
    );
    if (!admin || admin.branch_id !== branch)
      throw new ForbiddenException(
        'This branch is not assigned to your account.',
      );
    return user.sub as string;
  }
  private async scope(manager: EntityManager, branch: string, key: string) {
    const parts = key.split('|');
    const [room, yearId] = (parts[2] || '').split('::');
    if (parts[0] !== branch || !uuid.test(room || ''))
      throw new BadRequestException('Invalid record scope.');
    const [scope] = await manager.query(
      `SELECT DISTINCT e.class_id,e.academic_year_id FROM enrollments e JOIN academic_years y ON y.id=e.academic_year_id JOIN classes c ON c.id=e.class_id
   WHERE e.branch_id=$1 AND e.class_id=$2 AND replace(y.year_name,'–','-')=$3 AND ($4::text IS NULL OR e.academic_year_id::text=$4) AND c.is_deleted=false`,
      [branch, room, parts[1], yearId || null],
    );
    if (!scope)
      throw new BadRequestException(
        'The class/year does not belong to this branch.',
      );
    return { ...scope, parts };
  }
  private async validate(
    manager: EntityManager,
    branch: string,
    change: KindergartenChange,
  ) {
    const { collection, key, value } = change;
    if (
      !collections.includes(collection) ||
      !key ||
      key.length > 512 ||
      !Number.isInteger(change.expectedVersion) ||
      change.expectedVersion < 0
    )
      throw new BadRequestException('Invalid record change.');
    if (collection === 'school') {
      if (key !== branch || !object(value))
        throw new BadRequestException('Invalid school information.');
      for (const v of Object.values(value))
        if (typeof v !== 'string' || v.length > 2000)
          throw new BadRequestException('Invalid school field.');
      return;
    }
    const scope = await this.scope(manager, branch, key);
    const expectedParts = {
      holidays: 4,
      growth: 6,
      assessments: 7,
      activities: 6,
      daily: 7,
      weekly: 6,
      reviews: 5,
      rosterOrders: 3,
    }[collection];
    if (scope.parts.length !== expectedParts)
      throw new BadRequestException('Invalid record key.');
    if (collection === 'rosterOrders') {
      if (!object(value) || !Array.isArray(value.studentIds) || value.studentIds.length > 5000 ||
          value.studentIds.some((id: any) => typeof id !== 'string' || !uuid.test(id)) ||
          new Set(value.studentIds).size !== value.studentIds.length)
        throw new BadRequestException('Invalid student row order.');
      const [previous] = await manager.query(
        'SELECT payload FROM kindergarten_records WHERE branch_id=$1 AND collection=$2 AND record_key=$3',
        [branch, collection, key],
      );
      const existing: string[] = previous?.payload?.studentIds || [];
      if (existing.some((id, index) => value.studentIds[index] !== id))
        throw new BadRequestException('Existing student row numbers cannot change.');
      const enrolled = await manager.query(
        'SELECT DISTINCT student_id FROM enrollments WHERE branch_id=$1 AND class_id=$2 AND academic_year_id=$3',
        [branch, scope.class_id, scope.academic_year_id],
      );
      const allowed = new Set(enrolled.map((row: any) => row.student_id));
      if (value.studentIds.slice(existing.length).some((id: string) => !allowed.has(id)))
        throw new BadRequestException('Student is not enrolled in this class/year.');
      return;
    }
    if (
      ['growth', 'assessments'].includes(collection) &&
      (!['1', '2'].includes(scope.parts.at(-1) || '') ||
        !['1', '2'].includes(scope.parts.at(-2) || ''))
    )
      throw new BadRequestException('Invalid term/round.');
    if (
      ['activities', 'daily', 'weekly', 'reviews'].includes(collection) &&
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(scope.parts[3])
    )
      throw new BadRequestException('Invalid report month.');
    const student = ['growth', 'assessments'].includes(collection)
      ? scope.parts[3]
      : ['weekly', 'reviews'].includes(collection)
        ? scope.parts[4]
        : collection === 'daily'
          ? scope.parts.at(-1)
          : null;
    if (student) {
      if (!uuid.test(student))
        throw new BadRequestException('Invalid student.');
      const [enrollment] = await manager.query(
        'SELECT id FROM enrollments WHERE branch_id=$1 AND class_id=$2 AND academic_year_id=$3 AND student_id=$4',
        [branch, scope.class_id, scope.academic_year_id, student],
      );
      if (!enrollment)
        throw new BadRequestException(
          'Student is not enrolled in this class/year.',
        );
    }
    if (value === null) return;
    if (collection === 'holidays') {
      if (typeof value !== 'boolean')
        throw new BadRequestException('Holiday must be boolean.');
      return;
    }
    if (!object(value) || JSON.stringify(value).length > 100000)
      throw new BadRequestException('Invalid record payload.');
    if (collection === 'growth') {
      for (const f of ['weight', 'height', 'arm'])
        if (
          value[f] !== '' &&
          (typeof value[f] !== 'string' ||
            !Number.isFinite(+value[f]) ||
            +value[f] <= 0)
        )
          throw new BadRequestException(
            'Measurements must be positive numbers.',
          );
      for (const f of ['weightFlag', 'heightFlag', 'armFlag'])
        if (
          value[f] &&
          !['unknown', 'normal', 'below', 'above'].includes(value[f])
        )
          throw new BadRequestException('Invalid measurement flag.');
    }
    if (
      ['daily', 'assessments'].includes(collection) &&
      value.quality !== null &&
      ![1, 2, 3].includes(value.quality)
    )
      throw new BadRequestException('Quality must be 1, 2, 3 or null.');
    if (
      collection === 'daily' &&
      (!['pending', 'completed', 'not_participated'].includes(
        value.participation,
      ) ||
        value.id !== key ||
        value.activityId !== scope.parts.slice(0, -1).join('|') ||
        value.studentId !== student)
    )
      throw new BadRequestException('Invalid artwork record.');
    if (
      value.date &&
      (typeof value.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value.date))
    )
      throw new BadRequestException('Invalid date.');
    if (collection === 'activities' && value.id !== key)
      throw new BadRequestException('Activity ID does not match.');
    if (
      collection === 'reviews' &&
      !['draft', 'reviewed'].includes(value.status)
    )
      throw new BadRequestException('Invalid review status.');
    if (collection === 'assessments' && value.evidenceFiles !== undefined) {
      if (!Array.isArray(value.evidenceFiles) || value.evidenceFiles.length > 20)
        throw new BadRequestException('Use up to 20 evidence files.');
      const ids = new Set<string>();
      for (const file of value.evidenceFiles) {
        if (!object(file) || !uuid.test(file.id || '') || ids.has(file.id) || !uuid.test(file.assetId || '') ||
          typeof file.name !== 'string' || !file.name.trim() || file.name.length > 255 ||
          !['image/jpeg','image/png','image/webp','application/pdf'].includes(file.mime) ||
          !Number.isInteger(file.size) || file.size <= 0 || file.size > 10 * 1024 * 1024 ||
          typeof file.note !== 'string' || file.note.length > 4000 ||
          typeof file.uploadedAt !== 'string' || !Number.isFinite(Date.parse(file.uploadedAt)))
          throw new BadRequestException('Invalid evidence file metadata.');
        ids.add(file.id);
        const [asset] = await manager.query('SELECT mime,octet_length(content) AS size FROM kindergarten_assets WHERE id=$1 AND branch_id=$2', [file.assetId, branch]);
        if (!asset || asset.mime !== file.mime || +asset.size !== file.size)
          throw new BadRequestException('Evidence file does not belong to this branch or metadata does not match.');
      }
    }
    const refs = collection === 'daily' ? value.attachments : [];
    if (collection === 'daily' && !Array.isArray(refs))
      throw new BadRequestException('Attachments must be an array.');
    for (const ref of refs) {
      if (
        !object(ref) ||
        !uuid.test(ref.assetId || '') ||
        !Array.isArray(ref.redactions) ||
        !object(ref.crop) ||
        !['contain', 'crop'].includes(ref.fit) ||
        ![0, 90, 180, 270].includes(ref.rotation)
      )
        throw new BadRequestException('Invalid image settings.');
      for (const rect of [ref.crop, ...ref.redactions])
        if (
          !object(rect) ||
          !['x', 'y', 'w', 'h'].every(
            (f) =>
              typeof rect[f] === 'number' &&
              Number.isFinite(rect[f]) &&
              rect[f] >= 0 &&
              rect[f] <= 1,
          )
        )
          throw new BadRequestException('Invalid image area.');
      const [asset] = await manager.query(
        'SELECT id FROM kindergarten_assets WHERE id=$1 AND branch_id=$2',
        [ref.assetId, branch],
      );
      if (!asset)
        throw new BadRequestException(
          'Artwork has not been uploaded to this branch.',
        );
    }
  }
  async load(user: any, branch: string) {
    await this.authorize(user, branch);
    const records = await this.db.query(
      'SELECT collection,record_key AS key,payload AS value,version FROM kindergarten_records WHERE branch_id=$1',
      [branch],
    );
    const history = await this.db.query(
      'SELECT id,kind,title,privacy,revision,page_count AS pages,created_at AS at FROM kindergarten_reports WHERE branch_id=$1 ORDER BY created_at DESC',
      [branch],
    );
    return { records, history };
  }
  async save(user: any, branch: string, changes: KindergartenChange[]) {
    const actor = await this.authorize(user, branch);
    if (!Array.isArray(changes) || changes.length > 2000)
      throw new BadRequestException('Too many changes.');
    return this.db.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `kindergarten:${branch}`,
      ]);
      const result: any[] = [];
      const seen = new Set<string>();
      for (const change of changes) {
        const id = `${change.collection}:${change.key}`;
        if (seen.has(id)) throw new BadRequestException('Duplicate record.');
        seen.add(id);
        await this.validate(manager, branch, change);
        const [current] = await manager.query(
          'SELECT version,payload FROM kindergarten_records WHERE branch_id=$1 AND collection=$2 AND record_key=$3',
          [branch, change.collection, change.key],
        );
        if ((current?.version || 0) !== change.expectedVersion) {
          // Safe retry after a response was lost, without overwriting another teacher.
          if (current && isDeepStrictEqual(current.payload, change.value)) {
            result.push({
              collection: change.collection,
              key: change.key,
              version: current.version,
            });
            continue;
          }
          throw new ConflictException(
            'This record was changed on another device. Reload before saving.',
          );
        }
        const [saved] = await manager.query(
          `INSERT INTO kindergarten_records(branch_id,collection,record_key,payload,version,updated_by) VALUES($1,$2,$3,$4::jsonb,$5,$6)
      ON CONFLICT(branch_id,collection,record_key) DO UPDATE SET payload=EXCLUDED.payload,version=EXCLUDED.version,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING version`,
          [
            branch,
            change.collection,
            change.key,
            JSON.stringify(change.value),
            (current?.version || 0) + 1,
            actor,
          ],
        );
        result.push({
          collection: change.collection,
          key: change.key,
          version: saved.version,
        });
      }
      return { records: result };
    });
  }
  async upload(user: any, branch: string, file: Express.Multer.File, allowPdf = false) {
    const actor = await this.authorize(user, branch);
    const types = ['image/jpeg', 'image/png', 'image/webp', ...(allowPdf ? ['application/pdf'] : [])];
    if (!file || !file.size || file.size > 10 * 1024 * 1024 || !types.includes(file.mimetype))
      throw new BadRequestException('Use supported image files or evidence PDF up to 10MB.');
    let mime: string;
    if (file.mimetype === 'application/pdf') {
      if (!file.buffer.subarray(0, 8).toString('ascii').startsWith('%PDF-') || !file.buffer.subarray(-2048).includes(Buffer.from('%%EOF')))
        throw new BadRequestException('Invalid PDF file.');
      mime = 'application/pdf';
    } else {
      let format: string | undefined;
      try { format = (await sharp(file.buffer, { limitInputPixels: 40000000 }).metadata()).format; }
      catch { throw new BadRequestException('Invalid image file.'); }
      const detected = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[format || ''];
      if (!detected || detected !== file.mimetype) throw new BadRequestException('Invalid image format.');
      mime = detected;
    }
    const id = randomUUID();
    await this.db.query(
      'INSERT INTO kindergarten_assets(id,branch_id,mime,original_name,content,created_by) VALUES($1,$2,$3,$4,$5,$6)',
      [id, branch, mime, file.originalname, file.buffer, actor],
    );
    return { id };
  }
  async asset(user: any, branch: string, id: string) {
    await this.authorize(user, branch);
    const [asset] = await this.db.query(
      'SELECT mime,content FROM kindergarten_assets WHERE branch_id=$1 AND id=$2',
      [branch, id],
    );
    if (!asset) throw new NotFoundException('Artwork not found.');
    return asset;
  }
  async report(user: any, branch: string, s: any) {
    const actor = await this.authorize(user, branch);
    if (
      !object(s) ||
      !uuid.test(s.id || '') ||
      !object(s.options) ||
      !object(s.state) ||
      !Array.isArray(s.pages) ||
      !s.pages.length ||
      s.pages.length > 1000 ||
      !['main', 'art'].includes(s.options.kind) ||
      !['full', 'private', 'codes'].includes(s.options.privacy) ||
      !Number.isInteger(s.revision) ||
      typeof s.title !== 'string' ||
      JSON.stringify(s).length > 100 * 1024 * 1024
    )
      throw new BadRequestException('Invalid report snapshot.');
    const scope = await this.scope(
      this.db.manager,
      branch,
      `${branch}|${s.state.scopeYear || s.options.academicYearLabel}|${s.options.classId}`,
    );
    if (
      !Array.isArray(s.options.studentIds) ||
      s.options.studentIds.some((id: any) => !uuid.test(id))
    )
      throw new BadRequestException('Invalid report students.');
    for (const id of s.options.studentIds) {
      const [enrolled] = await this.db.query(
        'SELECT id FROM enrollments WHERE branch_id=$1 AND class_id=$2 AND academic_year_id=$3 AND student_id=$4',
        [branch, scope.class_id, scope.academic_year_id, id],
      );
      if (!enrolled)
        throw new BadRequestException(
          'Report student does not belong to this class/year.',
        );
    }
    const [existing] = await this.db.query(
      'SELECT snapshot FROM kindergarten_reports WHERE id=$1 AND branch_id=$2',
      [s.id, branch],
    );
    if (existing) {
      if (!isDeepStrictEqual(existing.snapshot, s))
        throw new ConflictException('Report snapshots are immutable.');
      return { id: s.id };
    }
    await this.db.query(
      `INSERT INTO kindergarten_reports(id,branch_id,class_id,academic_year_id,kind,title,privacy,revision,page_count,snapshot,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
      [
        s.id,
        branch,
        scope.class_id,
        scope.academic_year_id,
        s.options.kind,
        s.title,
        s.options.privacy,
        s.revision,
        s.pages.length,
        JSON.stringify(s),
        actor,
      ],
    );
    return { id: s.id };
  }
  async getReport(user: any, branch: string, id: string) {
    await this.authorize(user, branch);
    const [report] = await this.db.query(
      'SELECT snapshot FROM kindergarten_reports WHERE branch_id=$1 AND id=$2',
      [branch, id],
    );
    if (!report) throw new NotFoundException('Report not found.');
    return report.snapshot;
  }
  async attendance(user: any, branch: string, room: string, year: string) {
    await this.authorize(user, branch);
    // DATE is a school calendar day. Return text so pg cannot serialize local
    // midnight as the previous UTC day (e.g. Oct 6 -> Oct 5 at 17:00Z).
    return this.db.query(
      `SELECT a.student_id,to_char(a.attendance_date,'YYYY-MM-DD') AS attendance_date,a.type,a.reason,a.remark FROM attendances a JOIN enrollments e ON e.student_id=a.student_id JOIN academic_years y ON y.id=e.academic_year_id WHERE e.branch_id=$1 AND e.class_id=$2 AND e.academic_year_id=$3 AND a.attendance_date BETWEEN y.start_date AND y.end_date ORDER BY a.attendance_date`,
      [branch, room, year],
    );
  }
}
