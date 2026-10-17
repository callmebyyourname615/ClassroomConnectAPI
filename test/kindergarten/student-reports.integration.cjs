/* Real PostgreSQL and authenticated HTTP; fixtures live only in a disposable schema. */
require('dotenv').config({ quiet: true });
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { Test } = require('@nestjs/testing');
const { APP_GUARD } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const request = require('supertest');
const sharp = require('sharp');
const {
  StudentReportsController,
} = require('../../dist/kindergarten/student-reports.controller');
const {
  StudentReportsService,
  studentReportTemplate,
} = require('../../dist/kindergarten/student-reports.service');
const { JwtAuthGuard } = require('../../dist/auth/jwt-auth.guard');
const {
  kindergartenSchema,
} = require('../../dist/kindergarten/kindergarten.schema');

(async () => {
  const connection = {
    type: 'postgres',
    host: process.env.DB_HOST,
    port: +process.env.DB_PORT,
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  };
  const root = new DataSource(connection);
  await root.initialize();
  const schema = `student_reports_test_${Date.now()}`;
  await root.query(`CREATE SCHEMA "${schema}"`);
  const db = new DataSource({
    ...connection,
    extra: { options: `-c search_path=${schema}` },
  });
  let app;
  try {
    await db.initialize();
    await db.query(`CREATE TABLE branches(id uuid PRIMARY KEY);
      CREATE TABLE admins(id uuid PRIMARY KEY,branch_id uuid,is_active boolean,is_deleted boolean);
      CREATE TABLE students(id uuid PRIMARY KEY,is_active boolean,is_deleted boolean);
      CREATE TABLE parents(id uuid PRIMARY KEY,"isActive" boolean,"isDeleted" boolean);
      CREATE TABLE student_parents(student_id uuid,parent_id uuid);
      CREATE TABLE levels(id uuid PRIMARY KEY,name text);
      CREATE TABLE year_levels(id uuid PRIMARY KEY,level_id uuid,name text,name_translations jsonb);
      CREATE TABLE classes(id uuid PRIMARY KEY,year_level_id uuid,is_deleted boolean);
      CREATE TABLE academic_years(id uuid PRIMARY KEY,year_name text,start_date date,end_date date);
      CREATE TABLE enrollments(id uuid PRIMARY KEY,student_id uuid,branch_id uuid,class_id uuid,academic_year_id uuid,is_active boolean);`);
    await db.query(kindergartenSchema);
    const branch = randomUUID(),
      otherBranch = randomUUID(),
      parent = randomUUID(),
      stranger = randomUUID(),
      student = randomUUID(),
      sibling = randomUUID(),
      room = randomUUID(),
      year = randomUUID(),
      otherYear = randomUUID(),
      grade = randomUUID(),
      level = randomUUID();
    await db.query('INSERT INTO branches VALUES($1),($2)', [
      branch,
      otherBranch,
    ]);
    await db.query(
      'INSERT INTO parents VALUES($1,true,false),($2,true,false)',
      [parent, stranger],
    );
    await db.query(
      'INSERT INTO students VALUES($1,true,false),($2,true,false)',
      [student, sibling],
    );
    await db.query('INSERT INTO student_parents VALUES($1,$2)', [
      student,
      parent,
    ]);
    await db.query("INSERT INTO levels VALUES($1,'Kindergarten')", [level]);
    await db.query(
      "INSERT INTO year_levels VALUES($1,$2,'ອບ.2/1(Kindergarten 2/1)',null)",
      [grade, level],
    );
    await db.query('INSERT INTO classes VALUES($1,$2,false)', [room, grade]);
    await db.query(
      "INSERT INTO academic_years VALUES($1,'2026–2027','2026-09-01','2027-06-30'),($2,'2025-2026','2025-09-01','2026-06-30')",
      [year, otherYear],
    );
    for (const child of [student, sibling])
      await db.query('INSERT INTO enrollments VALUES($1,$2,$3,$4,$5,true)', [
        randomUUID(),
        child,
        branch,
        room,
        year,
      ]);
    const scope = `${branch}|2026-2027|${room}::${year}`;
    async function record(collection, key, value) {
      await db.query(
        `INSERT INTO kindergarten_records(branch_id,collection,record_key,payload,updated_by) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(branch_id,collection,record_key) DO UPDATE SET payload=EXCLUDED.payload`,
        [branch, collection, key, value, parent],
      );
    }
    const growth = {
      date: '2026-10-01',
      weight: '19.5',
      height: '110',
      arm: '',
      note: 'Own measurement',
    };
    await record('growth', `${scope}|${student}|1|1`, growth);
    await record('growth', `${scope}|${sibling}|1|1`, {
      ...growth,
      note: 'PRIVATE SIBLING',
    });
    await record(
      'growth',
      `${branch}|2025-2026|${room}::${otherYear}|${student}|1|1`,
      { ...growth, note: 'OLD YEAR' },
    );
    const asset = randomUUID(),
      unrelatedAsset = randomUUID(),
      attachmentId = randomUUID();
    const source = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    for (const id of [asset, unrelatedAsset])
      await db.query(
        'INSERT INTO kindergarten_assets(id,branch_id,mime,original_name,content,created_by) VALUES($1,$2,$3,$4,$5,$6)',
        [id, branch, 'image/png', 'test.png', source, parent],
      );
    const activityId = `${scope}|2026-10|1|1`,
      dailyId = `${activityId}|${student}`;
    await record('activities', activityId, {
      id: activityId,
      title: 'Own artwork',
      week: 1,
      day: 1,
    });
    await record('daily', dailyId, {
      id: dailyId,
      activityId,
      studentId: student,
      participation: 'completed',
      quality: 1,
      attachments: [
        {
          id: attachmentId,
          assetId: asset,
          rotation: 90,
          fit: 'crop',
          crop: { x: 0, y: 0, w: 0.8, h: 1 },
          redactions: [{ x: 0, y: 0, w: 1, h: 1 }],
        },
      ],
    });
    await record('daily', `${activityId}|${sibling}`, {
      note: 'PRIVATE SIBLING',
      attachments: [{ id: randomUUID(), assetId: unrelatedAsset }],
    });
    await record('weekly', `${scope}|2026-10|${student}|1`, {
      bestId: dailyId,
      teacherComment: 'Own note',
    });
    await record('reviews', `${scope}|2026-10|${sibling}`, {
      status: 'reviewed',
    });
    const jwt = new JwtService({
      secret: 'student-report-integration-test-secret',
      signOptions: { expiresIn: '1h' },
    });
    const module = await Test.createTestingModule({
      controllers: [StudentReportsController],
      providers: [
        StudentReportsService,
        { provide: DataSource, useValue: db },
        { provide: JwtService, useValue: jwt },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    const token = jwt.sign({ sub: parent, user_type: 'parent' });
    const server = app.getHttpServer(),
      base = `/student-reports/${student}`;
    const query = {
      branchId: branch,
      classId: room,
      academicYearId: year,
      month: '2026-10',
    };
    const api = (path = '', values = query, auth = token) =>
      request(server)
        .get(base + path)
        .query(values)
        .set('Authorization', `Bearer ${auth}`);
    await request(server).get(base).query(query).expect(401);
    await api(
      '',
      query,
      jwt.sign({ sub: stranger, user_type: 'parent' }),
    ).expect(403);
    await api('', { ...query, branchId: otherBranch }).expect(403);
    await api('', { ...query, academicYearId: otherYear }).expect(403);
    await api('', { ...query, month: '2027-09' }).expect(400);
    await api('', { ...query, classId: 'invalid' }).expect(400);
    let report = (await api().expect(200)).body;
    assert.equal(report.template, 'kindergarten-2');
    assert.equal(report.academicYear, '2026-2027');
    assert.deepEqual(
      report.records.map((r) => r.collection).sort(),
      ['activities', 'daily', 'growth', 'weekly'],
      'Saved artwork must be visible even before a monthly review exists',
    );
    assert(!JSON.stringify(report).includes('PRIVATE SIBLING'));
    assert(!JSON.stringify(report).includes('OLD YEAR'));
    await api(`/images/${asset}`, { ...query, attachmentId }).expect(200);
    await api(`/images/${asset}`, {
      ...query, month: '2026-11', attachmentId,
    }).expect(404);
    await record('reviews', `${scope}|2026-10|${student}`, {
      status: 'draft',
    });
    report = (await api().expect(200)).body;
    assert.equal(report.records.length, 5);
    assert.equal(report.records.find(r => r.collection === 'reviews').value.status, 'draft');
    await api(`/images/${asset}`, { ...query, attachmentId }).expect(200);
    await record('reviews', `${scope}|2026-10|${student}`, {
      status: 'reviewed',
      at: '2026-10-12T00:00:00Z',
    });
    report = (await api().expect(200)).body;
    assert.equal(report.records.length, 5);
    assert(!JSON.stringify(report).includes('PRIVATE SIBLING'));
    assert(!JSON.stringify(report).includes('OLD YEAR'));
    const image = (
      await api(`/images/${asset}`, { ...query, attachmentId }).expect(200)
    ).body;
    const rendered = Buffer.from(image.data, 'base64');
    const meta = await sharp(rendered).metadata();
    assert.equal(meta.width, 100);
    assert.equal(meta.height, 80);
    const pixels = await sharp(rendered).removeAlpha().raw().toBuffer();
    assert(
      pixels.every((v) => v === 0),
      'Parent image must retain the teacher privacy masks',
    );
    await api(`/images/${unrelatedAsset}`, { ...query, attachmentId }).expect(
      404,
    );
    await record('school', branch, {
      reportTemplates: JSON.stringify({ [grade]: 'kindergarten-3' }),
    });
    assert.equal((await api().expect(200)).body.template, 'kindergarten-3');
    await record('school', branch, {
      reportTemplates: JSON.stringify({ [grade]: '' }),
    });
    assert.equal((await api().expect(200)).body.template, 'unmapped');
    await record('school', branch, {});
    await db.query("UPDATE year_levels SET name='ປ.2(Grade 2)' WHERE id=$1", [
      grade,
    ]);
    report = (await api().expect(200)).body;
    assert.equal(report.template, 'primary');
    assert.deepEqual(report.records, []);
    for (const n of [1, 2, 3])
      assert.equal(
        studentReportTemplate(
          { grade_name: `ອບ.${n}`, level_name: 'Kindergarten' },
          {},
        ),
        `kindergarten-${n}`,
      );
    assert.equal(
      studentReportTemplate({ grade_name: 'Room K2/1' }, {}),
      'unmapped',
    );
    await db.query('DELETE FROM student_parents');
    await api().expect(403);
    await api(`/images/${asset}`, { ...query, attachmentId }).expect(403);
    console.log(
      'PASS: parent links, enrollment/year/branch isolation, KG1–3/primary routing, manual mappings, saved art before/during/after review, child projection and masked images',
    );
  } finally {
    if (app) await app.close();
    if (db.isInitialized) await db.destroy();
    await root.query(`DROP SCHEMA "${schema}" CASCADE`);
    await root.destroy();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
