/* Authenticated HTTP + real PostgreSQL, using a disposable schema only. */
require('dotenv').config({ quiet: true });
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { Test } = require('@nestjs/testing');
const { APP_GUARD } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const request = require('supertest');
const { JwtAuthGuard } = require('../dist/auth/jwt-auth.guard');
const {
  ParentMontessoriService,
} = require('../dist/montessori/parent-montessori.service');
const {
  ParentMontessoriController,
} = require('../dist/montessori/parent-montessori.controller');

(async () => {
  const options = {
    type: 'postgres',
    host: process.env.DB_HOST,
    port: +process.env.DB_PORT,
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  };
  const root = new DataSource(options);
  await root.initialize();
  const schema = 'parent_montessori_test_' + randomUUID().replaceAll('-', '');
  await root.query(`CREATE SCHEMA ${schema}`);
  const db = new DataSource({
    ...options,
    extra: { options: `-c search_path=${schema}` },
  });
  let app;
  try {
    await db.initialize();
    await db.query(`CREATE TABLE parents(id uuid,"isActive" boolean DEFAULT true,"isDeleted" boolean DEFAULT false);
      CREATE TABLE student_parents(student_id uuid,parent_id uuid);
      CREATE TABLE students(id uuid,is_active boolean DEFAULT true,is_deleted boolean DEFAULT false);
      CREATE TABLE classes(id uuid,is_deleted boolean DEFAULT false);
      CREATE TABLE academic_years(id uuid,branch_id uuid,start_date date,end_date date,is_deleted boolean DEFAULT false);
      CREATE TABLE attendances(id uuid DEFAULT gen_random_uuid(),student_id uuid,attendance_date date,type text,reason text,remark text,updated_at timestamptz DEFAULT now());
      CREATE TABLE enrollments(student_id uuid,branch_id uuid,class_id uuid,academic_year_id uuid,is_active boolean DEFAULT true);
      CREATE TABLE montessori_reports(id uuid,branch_id uuid,student_id uuid,class_id uuid,academic_year_id uuid,
        level text,term text,version int,status text,payload jsonb,updated_at timestamptz DEFAULT now());`);
    const [
      parent,
      stranger,
      child,
      otherChild,
      branch,
      room,
      year,
      id,
      otherId,
    ] = Array.from({ length: 9 }, () => randomUUID());
    await db.query('INSERT INTO parents(id) VALUES($1),($2)', [
      parent,
      stranger,
    ]);
    await db.query('INSERT INTO students(id) VALUES($1),($2)', [
      child,
      otherChild,
    ]);
    await db.query('INSERT INTO student_parents VALUES($1,$2)', [
      child,
      parent,
    ]);
    await db.query('INSERT INTO classes(id) VALUES($1)', [room]);
    await db.query(
      'INSERT INTO enrollments(student_id,branch_id,class_id,academic_year_id) VALUES($1,$2,$3,$4),($5,$2,$3,$4)',
      [child, branch, room, year, otherChild],
    );
    await db.query(
      "INSERT INTO academic_years(id,branch_id,start_date,end_date) VALUES($1,$2,'2026-08-01','2027-07-31')",
      [year, branch],
    );
    await db.query(
      "INSERT INTO attendances(student_id,attendance_date,type,reason) VALUES($1,'2026-10-01','PRESENT',null),($1,'2026-10-02','ABSENT',null),($1,'2026-10-03','ABSENT','Reason'),($2,'2026-10-01','PRESENT',null)",
      [child, otherChild],
    );
    const payload = {
      reportingStart: '2026-10-01',
      reportingEnd: '2026-10-15',
      student: 'Test Child',
      academicYear: '2026-2027',
      className: 'Test room',
      subjects: [
        { subject: 'Natural World', skills: ['Same', 'Same'] },
        { subject: 'Lao', narrative: true, skills: [] },
      ],
      ratings: { '0:0': 'Mastered' },
      comments: { 1: 'Narrative preserved' },
      attendance: { period: { present: null, absent: null, vacation: 0 } },
      privateNote: 'PRIVATE INTERNAL',
    };
    for (const [report, student] of [
      [id, child],
      [otherId, otherChild],
    ]) {
      await db.query(
        "INSERT INTO montessori_reports(id,branch_id,student_id,class_id,academic_year_id,level,term,version,status,payload) VALUES($1,$2,$3,$4,$5,'Twos','Term 1',1,'Draft',$6)",
        [report, branch, student, room, year, payload],
      );
    }
    const jwt = new JwtService({
      secret: 'isolated-parent-montessori-test',
      signOptions: { expiresIn: '1h' },
    });
    const module = await Test.createTestingModule({
      controllers: [ParentMontessoriController],
      providers: [
        ParentMontessoriService,
        { provide: DataSource, useValue: db },
        { provide: JwtService, useValue: jwt },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    const server = app.getHttpServer(),
      path = `/student-reports/${child}/montessori`;
    const query = { branchId: branch, classId: room, academicYearId: year };
    const token = jwt.sign({ sub: parent, user_type: 'parent' });
    const get = (suffix = '', q = query, auth = token) =>
      request(server)
        .get(path + suffix)
        .query(q)
        .set('Authorization', `Bearer ${auth}`);
    await request(server).get(path).query(query).expect(401);
    const list = (await get().expect(200)).body;
    assert.equal(list.reports.length, 1);
    assert.equal(list.reports[0].id, id);
    assert.equal(list.reports[0].assessment.assessed, 1);
    assert.equal(list.reports[0].assessment.total, 2);
    const detail = await get('/' + id).expect(200);
    assert.equal(detail.headers['cache-control'], 'private, no-store');
    assert.equal(detail.body.subjects[0].skills.length, 2);
    assert.equal(detail.body.comments['1'], 'Narrative preserved');
    assert.equal(detail.body.attendance.period.present, 1);
    assert.equal(detail.body.attendance.period.absent, 1);
    assert.equal(detail.body.attendance.period.sick, 1);
    assert.equal(detail.body.attendance.period.vacation, 0);
    assert.equal(detail.body.attendance.period.sentHome, null);
    assert(!JSON.stringify(detail.body).includes('PRIVATE INTERNAL'));
    await get('/' + otherId).expect(404);
    await get('', { ...query, academicYearId: randomUUID() }).expect(403);
    await get(
      '',
      query,
      jwt.sign({ sub: stranger, user_type: 'parent' }),
    ).expect(403);
    await get('', query, jwt.sign({ sub: parent, user_type: 'admin' })).expect(
      403,
    );
    await get('', { ...query, limit: '-1' }).expect(400);
    await db.query('DELETE FROM student_parents WHERE parent_id=$1', [parent]);
    await get('/' + id).expect(403);
    console.log(
      'PASS: PostgreSQL and JWT parent list/detail, Draft snapshot fidelity, duplicates/narrative/null/zero, cross-child/year/staff denial and revoked relationship.',
    );
  } finally {
    await app?.close();
    if (db.isInitialized) await db.destroy();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.destroy();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
