require('dotenv').config({ quiet: true });
const { DataSource } = require('typeorm');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { MontessoriService } = require('../src/montessori/montessori.service');
const { montessoriSchema } = require('../src/montessori/montessori.schema');
const schema = 'montessori_test_' + randomUUID().replaceAll('-', '');
const options = {
  type: 'postgres',
  host: process.env.DB_HOST,
  port: +process.env.DB_PORT,
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  extra: { max: 4, options: `-c search_path=${schema},public` },
};
const db = new DataSource(options);
(async () => {
  await db.initialize();
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`CREATE TABLE branches(id uuid PRIMARY KEY,name text);
  CREATE TABLE admins(id uuid PRIMARY KEY,branch_id uuid,first_name text,last_name text,"first_name_La" text,"last_name_La" text,is_deleted boolean DEFAULT false,is_active boolean DEFAULT true);
  CREATE TABLE roles(id uuid PRIMARY KEY,name text,"isDeleted" boolean DEFAULT false);
  CREATE TABLE admin_roles(admin_id uuid,role_id uuid);
  CREATE TABLE students(id uuid PRIMARY KEY,first_name_eng text,last_name_eng text,first_name_lao text,last_name_lao text,dob date,is_deleted boolean DEFAULT false);
  CREATE TABLE classes(id uuid PRIMARY KEY,name text,is_deleted boolean DEFAULT false);
  CREATE TABLE academic_years(id uuid PRIMARY KEY,branch_id uuid,year_name text,start_date date,end_date date,is_active boolean DEFAULT true,is_deleted boolean DEFAULT false);
  CREATE TABLE enrollments(id uuid PRIMARY KEY,student_id uuid,class_id uuid,academic_year_id uuid,branch_id uuid,is_active boolean DEFAULT true);
  CREATE TABLE attendances(id uuid PRIMARY KEY,student_id uuid,attendance_date date,type text,reason text,remark text,updated_at timestamptz DEFAULT now());`);
    const a = randomUUID(),
      b = randomUUID(),
      owner = randomUUID(),
      other = randomUUID(),
      reviewer = randomUUID(),
      outsider = randomUUID(),
      teacherRole = randomUUID(),
      adminRole = randomUUID(),
      student = randomUUID(),
      foreignStudent = randomUUID(),
      room = randomUUID(),
      year = randomUUID();
    await db.query('INSERT INTO branches VALUES($1,$2),($3,$4)', [
      a,
      'Test A',
      b,
      'Test B',
    ]);
    for (const [id, branch] of [
      [owner, a],
      [other, a],
      [reviewer, a],
      [outsider, b],
    ])
      await db.query(
        'INSERT INTO admins(id,branch_id,first_name,last_name) VALUES($1,$2,$3,$4)',
        [id, branch, 'Test', 'Staff'],
      );
    await db.query('INSERT INTO roles(id,name) VALUES($1,$2),($3,$4)', [
      teacherRole,
      'Teacher',
      adminRole,
      'Super Admin',
    ]);
    for (const id of [owner, other, outsider])
      await db.query('INSERT INTO admin_roles VALUES($1,$2)', [
        id,
        teacherRole,
      ]);
    await db.query('INSERT INTO admin_roles VALUES($1,$2)', [
      reviewer,
      adminRole,
    ]);
    await db.query(
      'INSERT INTO students(id,first_name_eng,last_name_eng,dob) VALUES($1,$2,$3,$4),($5,$6,$7,$4)',
      [
        student,
        'Test',
        'Student',
        '2020-03-14',
        foreignStudent,
        'Foreign',
        'Student',
      ],
    );
    await db.query('INSERT INTO classes(id,name) VALUES($1,$2)', [
      room,
      'Test Class',
    ]);
    await db.query(
      'INSERT INTO academic_years(id,branch_id,year_name,start_date,end_date) VALUES($1,$2,$3,$4,$5)',
      [year, a, '2026–2027', '2026-08-01', '2027-07-31'],
    );
    await db.query(
      'INSERT INTO enrollments(id,student_id,class_id,academic_year_id,branch_id) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), student, room, year, a],
    );
    for (const [who, day, type, reason] of [
      [student, '2026-09-01', 'PRESENT', null],
      [student, '2026-09-02', 'ABSENT', null],
      [student, '2026-09-03', 'ABSENT', 'Family leave'],
      [student, '2026-09-04', 'LATE', null],
      [student, '2026-07-31', 'ABSENT', null],
      [foreignStudent, '2026-09-02', 'ABSENT', null],
    ]) await db.query('INSERT INTO attendances(id,student_id,attendance_date,type,reason) VALUES($1,$2,$3,$4,$5)', [randomUUID(), who, day, type, reason]);
    await db.query(montessoriSchema);
    const service = new MontessoriService(db),
      user = { sub: owner },
      admin = { sub: reviewer },
      id = randomUUID();
    const doc = {
      studentId: student,
      classId: room,
      academicYearId: year,
      level: 'Twos',
      term: 'Term 2',
      reportingStart: '2027-02-01',
      reportingEnd: '2027-06-30',
      templateVersion: 'test-v1',
      subjects: [
        { subject: 'Behaviour & Work Habits', skills: ['Self-awareness'] },
        { subject: 'Sensorial', skills: ['Natural World', 'Natural World'] },
      ],
      ratings: { '1:0': 'Mastered', '1:1': 'Practicing' },
      behaviorRatings: { '0:0': 2 },
      comments: { 1: 'ທົດສອບ persisted comment' },
      coverage: { 1: 'In progress' },
      summaryComment: 'Test summary',
      attendance: { period: { present: 5 } },
    };
    const rejects = async (fn, status) =>
      assert.rejects(fn, (error) => error.getStatus?.() === status);
    let saved = await service.save(user, a, id, {
      id,
      expectedVersion: 0,
      report: doc,
    });
    assert.equal(saved.version, 1);
    assert.equal(saved.student, 'Test Student');
    assert.equal(saved.progress, 100);
    assert.equal(saved.attendance.period.present, null); // Future reporting period, not the submitted 5.
    assert.equal(saved.attendance.schoolYear.sick, 1);
    const attendanceQuery = { studentId: student, classId: room, academicYearId: year, level: 'Toddlers', start: '2026-09-01', end: '2026-09-30' };
    const totals = await service.attendance(user, a, attendanceQuery);
    assert.deepEqual(totals.attendance.period, { present: 2, absent: 1, sick: 1, sentHome: null, vacation: null, tardy: 1, distanceLearning: null });
    await rejects(() => service.attendance(user, a, { ...attendanceQuery, studentId: foreignStudent }), 403);
    await rejects(() => service.attendance({ sub: outsider }, a, attendanceQuery), 403);
    await rejects(() => service.attendance(user, a, { ...attendanceQuery, start: 'invalid' }), 400);

    assert.equal(
      (await service.save(user, a, id, { id, expectedVersion: 0, report: doc }))
        .version,
      1,
    );
    const changed = { ...doc, comments: { 1: 'Changed' } };
    await rejects(
      () =>
        service.save(user, a, id, { id, expectedVersion: 0, report: changed }),
      409,
    );
    await rejects(
      () =>
        service.save({ sub: other }, a, id, {
          id,
          expectedVersion: 1,
          report: changed,
        }),
      403,
    );
    await rejects(() => service.get({ sub: outsider }, a, id), 403);
    await rejects(() => service.get({ sub: outsider }, b, id), 404);
    await rejects(
      () => service.get({ sub: owner, user_type: 'parent' }, a, id),
      403,
    );
    await rejects(
      () =>
        service.save(user, a, randomUUID(), {
          id: randomUUID(),
          expectedVersion: 0,
          report: doc,
        }),
      400,
    );
    const badId = randomUUID();
    await rejects(
      () =>
        service.save(user, a, badId, {
          id: badId,
          expectedVersion: 0,
          report: { ...doc, studentId: foreignStudent },
        }),
      400,
    );
    saved = await service.save(user, a, id, {
      id,
      expectedVersion: 1,
      report: changed,
    });
    assert.equal(saved.version, 2);
    assert.equal(saved.status, undefined);
    assert.equal(typeof service.transition, 'undefined');
    // Legacy workflow statuses must never lock a teacher out of their own report.
    for (const status of ['Submitted', 'Changes requested', 'Approved', 'Finalized']) {
      await db.query('UPDATE montessori_reports SET status=$2 WHERE id=$1', [id, status]);
      saved = await service.save(user, a, id, {
        id,
        expectedVersion: saved.version,
        report: { ...changed, summaryComment: 'Teacher edited after ' + status },
      });
      assert.equal(saved.summaryComment, 'Teacher edited after ' + status);
      assert.equal(saved.status, undefined);
    }
    saved = await service.save(admin, a, id, {
      id,
      expectedVersion: saved.version,
      report: { ...changed, summaryComment: 'Administrator edit' },
    });
    assert.equal((await service.history(user, a, id)).length, 7);
    assert.equal((await service.get(user, a, id)).comments['1'], 'Changed');
    for (const level of ['Toddlers', 'Pre-School', 'Lower Elementary']) {
      const next = randomUUID();
      assert.equal(
        (
          await service.save(user, a, next, {
            id: next,
            expectedVersion: 0,
            report: { ...doc, level },
          })
        ).level,
        level,
      );
    }
    assert.equal(
      (await service.list(user, a)).total,
      4,
    );
    assert.equal(
      (await service.list(user, a, { limit: '2', offset: '0' })).reports.length,
      2,
    );
    assert.equal((await service.context(user, a)).students.length, 1);
    // Every successful write has a matching immutable revision, including races.
    const raceId = randomUUID();
    const results = await Promise.allSettled([
      service.save(user, a, raceId, {
        id: raceId,
        expectedVersion: 0,
        report: doc,
      }),
      service.save(user, a, raceId, {
        id: raceId,
        expectedVersion: 0,
        report: changed,
      }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    // Deletion shares save authorization/version locks and removes history atomically.
    await rejects(() => service.remove(user, a, id, ''), 400);
    await rejects(() => service.remove(user, a, id, '0'), 400);
    await rejects(() => service.remove(user, a, id, String(saved.version - 1)), 409);
    await rejects(() => service.remove({ sub: other }, a, id, String(saved.version)), 403);
    await rejects(() => service.remove({ sub: outsider }, a, id, String(saved.version)), 403);
    await rejects(() => service.remove({ sub: outsider }, b, id, String(saved.version)), 404);
    await rejects(() => service.remove({ ...user, user_type: 'parent' }, a, id, String(saved.version)), 403);
    assert.equal((await service.history(user, a, id)).length, 7);
    assert.deepEqual(await service.remove(admin, a, id, String(saved.version)), { id });
    await rejects(() => service.get(user, a, id), 404);
    await rejects(() => service.remove(admin, a, id, String(saved.version)), 404);
    assert.equal((await db.query('SELECT count(*)::int AS total FROM montessori_report_revisions WHERE report_id=$1', [id]))[0].total, 0);
    await rejects(() => service.save(user, a, id, { id, expectedVersion: saved.version, report: changed }), 409);
    assert.equal((await service.list(user, a)).total, 4);
    const raced = await service.get(user, a, raceId);
    await service.remove(user, a, raceId, String(raced.version));
    assert.equal((await service.list(user, a)).total, 3);
    console.log(
      'PASS: scoped attendance, persistence, four levels, authorization, concurrency, safe retries, direct saves, revisions, pagination; author/admin deletion, version conflicts, branch/parent restrictions, history cleanup, no stale-save resurrection and unrelated reports preserved',
    );
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.destroy();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
