/* Real PostgreSQL + authenticated HTTP; all fixtures live in a disposable schema. */
require('dotenv').config({ quiet: true });
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { Test } = require('@nestjs/testing');
const { APP_GUARD } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const { ConfigService } = require('@nestjs/config');
const request = require('supertest');
const { JwtAuthGuard } = require('../dist/auth/jwt-auth.guard');
const { MontessoriService } = require('../dist/montessori/montessori.service');
const { ReportRequestsService } = require('../dist/report-requests/report-requests.service');
const controllers = require('../dist/report-requests/report-requests.controller');
const { reportRequestsSchema, reportRequestDocumentsSchema, reportRequestMultiPeriodSchema } = require('../dist/report-requests/report-requests.schema');

(async () => {
  const options = { type: 'postgres', host: process.env.DB_HOST, port: +process.env.DB_PORT,
    username: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME };
  const root = new DataSource(options);
  await root.initialize();
  const schema = 'official_request_test_' + randomUUID().replaceAll('-', '');
  await root.query(`CREATE SCHEMA ${schema}`);
  const db = new DataSource({ ...options, extra: { max: 8, options: `-c search_path=${schema}` } });
  let app;
  try {
    await db.initialize();
    await db.query(`CREATE TABLE branches(id uuid PRIMARY KEY);
      CREATE TABLE parents(id uuid PRIMARY KEY,"isActive" boolean DEFAULT true,"isDeleted" boolean DEFAULT false,"firstName_lao" text,"lastName_lao" text,"firstName_eng" text,"lastName_eng" text);
      CREATE TABLE student_parents(parent_id uuid,student_id uuid);
      CREATE TABLE students(id uuid PRIMARY KEY,first_name_lao text,last_name_lao text,first_name_eng text,last_name_eng text,student_id text,is_active boolean DEFAULT true,is_deleted boolean DEFAULT false);
      CREATE TABLE levels(id uuid PRIMARY KEY,name text);
      CREATE TABLE year_levels(id uuid PRIMARY KEY,name text,name_translations jsonb,level_id uuid);
      CREATE TABLE classes(id uuid PRIMARY KEY,name text,year_level_id uuid,homeroom_teacher_id uuid,is_deleted boolean DEFAULT false);
      CREATE TABLE academic_years(id uuid PRIMARY KEY,branch_id uuid,year_name text,is_deleted boolean DEFAULT false);
      CREATE TABLE enrollments(student_id uuid,branch_id uuid,class_id uuid,academic_year_id uuid,is_active boolean DEFAULT true);
      CREATE TABLE admins(id uuid PRIMARY KEY,branch_id uuid,first_name text,last_name text,is_active boolean DEFAULT true,is_deleted boolean DEFAULT false);
      CREATE TABLE roles(id uuid PRIMARY KEY,name text,"isDeleted" boolean DEFAULT false);
      CREATE TABLE admin_roles(admin_id uuid,role_id uuid);
      CREATE TABLE montessori_reports(id uuid PRIMARY KEY,branch_id uuid,student_id uuid,class_id uuid,academic_year_id uuid,level text,term text,payload jsonb,version int,updated_at timestamptz DEFAULT now());
      CREATE TABLE kindergarten_records(branch_id uuid,collection text,record_key text,payload jsonb);
      CREATE TABLE rubric_report_data(id uuid PRIMARY KEY,kind text,class_id varchar,payload jsonb,expires_at timestamptz,updated_at timestamptz DEFAULT now());`);
    await db.query(reportRequestsSchema);
    await db.query(reportRequestDocumentsSchema);
    await db.query(reportRequestMultiPeriodSchema);
    const [branch, foreignBranch, parent, stranger, child, otherChild, room, kgRoom, year, otherYear, level, grade, kgLevel, kgGrade, admin, teacher, foreignAdmin, adminRole, teacherRole, monId, primaryId, reviewId] = Array.from({ length: 22 }, randomUUID);
    await db.query('INSERT INTO branches VALUES($1),($2)', [branch, foreignBranch]);
    await db.query('INSERT INTO parents(id) VALUES($1),($2)', [parent, stranger]);
    await db.query('UPDATE parents SET "firstName_eng"=$2,"lastName_eng"=$3 WHERE id=$1', [parent, 'Test', 'Parent']);
    await db.query('INSERT INTO students(id,first_name_lao) VALUES($1,\'Test child\'),($2,\'Other child\')', [child, otherChild]);
    await db.query('UPDATE students SET first_name_eng=$2,student_id=$3 WHERE id=$1', [child, 'Test child EN', 'TEST-001']);
    await db.query('INSERT INTO student_parents VALUES($1,$2)', [parent, child]);
    await db.query("INSERT INTO levels VALUES($1,'Primary'),($2,'Kindergarten')", [level, kgLevel]);
    await db.query("INSERT INTO year_levels VALUES($1,'Grade 1','{}',$2),($3,'KG 2','{}',$4)", [grade, level, kgGrade, kgLevel]);
    await db.query("INSERT INTO classes(id,name,year_level_id) VALUES($1,'P1/1',$2),($3,'K2/1',$4)", [room, grade, kgRoom, kgGrade]);
    await db.query("INSERT INTO academic_years(id,branch_id,year_name) VALUES($1,$2,'2026–2027'),($3,$2,'2025–2026')", [year, branch, otherYear]);
    await db.query('INSERT INTO enrollments VALUES($1,$2,$3,$4),($1,$2,$5,$4),($6,$2,$3,$4)', [child, branch, room, year, kgRoom, otherChild]);
    await db.query("INSERT INTO admins(id,branch_id,first_name) VALUES($1,$2,'Administrator'),($3,$2,'Teacher'),($4,$5,'Other branch')", [admin, branch, teacher, foreignAdmin, foreignBranch]);
    await db.query("INSERT INTO roles(id,name) VALUES($1,'Admin'),($2,'Teacher')", [adminRole, teacherRole]);
    await db.query('INSERT INTO admin_roles VALUES($1,$2),($3,$4),($5,$2)', [admin, adminRole, teacher, teacherRole, foreignAdmin]);
    const mon = { templateVersion: 'aims-report-mon-v2', subjects: [{ subject: 'Language', skills: ['Reading'] }],
      ratings: { '0:0': 'Practicing' }, reportingStart: '2026-10-01', reportingEnd: '2026-10-17', student: 'Test child' };
    await db.query("INSERT INTO montessori_reports VALUES($1,$2,$3,$4,$5,'Twos','Term 1',$6,2,now())", [monId, branch, child, room, year, mon]);
    const jwt = new JwtService({ secret: 'official-request-test-only', signOptions: { expiresIn: '1h' } });
    const module = await Test.createTestingModule({
      controllers: Object.values(controllers),
      providers: [ReportRequestsService, MontessoriService, { provide: DataSource, useValue: db },
        { provide: JwtService, useValue: jwt }, { provide: ConfigService, useValue: { get: () => 'official-request-test-only' } },
        { provide: APP_GUARD, useClass: JwtAuthGuard }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v2');
    await app.init();
    const http = request(app.getHttpServer());
    const token = jwt.sign({ sub: parent, user_type: 'parent' });
    const strangerToken = jwt.sign({ sub: stranger, user_type: 'parent' });
    const adminToken = jwt.sign({ sub: admin, user_type: 'admin' });
    const teacherToken = jwt.sign({ sub: teacher, user_type: 'admin' });
    const foreignToken = jwt.sign({ sub: foreignAdmin, user_type: 'admin' });
    const q = { branchId: branch, classId: room, academicYearId: year };
    const url = `/api/v2/student-reports/${child}`;
    const staffUrl = `/api/v2/official-report-requests/${branch}`;
    const get = (path, query = q, auth = token) => http.get(path).auth(auth, { type: 'bearer' }).query(query);
    const optionsPath = `${url}/request-options`, requestsPath = `${url}/requests`;
    await http.get(requestsPath).query(q).expect(401);
    await get(requestsPath, q, strangerToken).expect(403);
    await get(requestsPath, q, adminToken).expect(403);
    await get(requestsPath, { ...q, branchId: foreignBranch }).expect(403);
    await get(requestsPath, { ...q, academicYearId: otherYear }).expect(403);
    await get(requestsPath, { ...q, classId: 'bad' }).expect(400);
    await get(requestsPath, { ...q, limit: 101 }).expect(400);
    const empty = (await get(requestsPath).expect(200)).body;
    assert.deepEqual(empty.requests, []); assert.equal(empty.total, 0); assert.equal(empty.academicYear, '2026-2027');
    const catalog = (await get(optionsPath).expect(200)).body;
    const option = catalog.terms[0].options[0];
    assert.equal(option.template.family, 'montessori'); assert.equal(option.sourceVersion, 2);
    assert.equal(option.label, '2026-10-01 – 2026-10-17'); assert.equal(option.canRequest, true);
    await db.query('UPDATE montessori_reports SET payload=$2 WHERE id=$1', [monId, { ...mon, ratings: {} }]);
    assert.equal((await get(optionsPath).expect(200)).body.terms[0].options[0].canRequest, false);
    await db.query('UPDATE montessori_reports SET payload=$2 WHERE id=$1', [monId, { ...mon, templateVersion: '' }]);
    assert.equal((await get(optionsPath).expect(200)).body.terms[0].options[0].mappingReady, false);
    await db.query('UPDATE montessori_reports SET payload=$2 WHERE id=$1', [monId, mon]);
    const body = { ...q, selectionId: option.id, documentLanguage: 'en', sourceReportId: option.sourceReportId, sourceVersion: option.sourceVersion, template: option.template };
    const send = (data, key = randomUUID()) => http.post(requestsPath).auth(token, { type: 'bearer' }).set('Idempotency-Key', key).send(data);
    await send({ ...body, documentLanguage: 'th' }).expect(400);
    await send(body, 'short').expect(400);
    await send({ ...body, template: { ...body.template, level: 'Tampered' } }).expect(409);
    await send({ ...body, sourceReportId: randomUUID() }).expect(409);
    await send({ ...body, sourceVersion: 1 }).expect(409);
    const key = randomUUID();
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => send(body, key).expect(201)));
    const created = concurrent[0].body;
    assert(concurrent.every(r => r.body.id === created.id));
    assert.equal(created.status, 'submitted'); assert.equal(created.documentLanguage, 'en');
    assert.equal(created.studentId, child); assert.equal(created.sourceVersion, 2); assert.deepEqual(created.template, option.template);
    assert.equal((await db.query('SELECT count(*)::int n FROM official_report_requests'))[0].n, 1);
    await send({ ...body, documentLanguage: 'lo' }, key).expect(409);
    const lao = (await send({ ...body, documentLanguage: 'lo' }).expect(201)).body;
    assert.equal(lao.documentLanguage, 'lo');
    const history = (await get(requestsPath, { ...q, limit: 1 }).expect(200)).body;
    assert.equal(history.total, 2); assert.equal(history.requests.length, 1);
    assert.equal((await get(requestsPath, { ...q, limit: 1, offset: 1 }).expect(200)).body.requests.length, 1);
    await get(`${requestsPath}/${created.id}`, q, strangerToken).expect(403);
    await get(`${requestsPath}/${randomUUID()}`).expect(404);
    await get(staffUrl, {}, token).expect(403);
    assert.equal((await get(staffUrl, {}, teacherToken).expect(200)).body.total, 0);
    await get(`${staffUrl}/${created.id}`, {}, teacherToken).expect(403);
    await db.query('UPDATE classes SET homeroom_teacher_id=$2 WHERE id=$1', [room, teacher]);
    assert.equal((await get(staffUrl, {}, teacherToken).expect(200)).body.total, 2);
    await get(`${staffUrl}/${created.id}`, {}, teacherToken).expect(200);
    await db.query('UPDATE classes SET homeroom_teacher_id=NULL WHERE id=$1', [room]);
    await get(staffUrl, {}, foreignToken).expect(403);
    assert.equal((await get(staffUrl, {}, adminToken).expect(200)).body.total, 2);
    const staffDetail = (await get(`${staffUrl}/${created.id}`, {}, adminToken).expect(200)).body;
    assert.deepEqual(staffDetail.sourceSnapshot, mon); assert.equal(staffDetail.parentId, parent);
    assert.equal(staffDetail.parent.nameEn, 'Test Parent'); assert.equal(staffDetail.student.nameEn, 'Test child EN'); assert.equal(staffDetail.student.code, 'TEST-001');
    await db.query('UPDATE montessori_reports SET version=3,payload=$2 WHERE id=$1', [monId, { ...mon, ratings: { '0:0': 'Mastered' } }]);
    await send(body).expect(409);
    assert.equal((await send(body, key).expect(201)).body.id, created.id);
    assert.equal((await get(`${staffUrl}/${created.id}`, {}, adminToken).expect(200)).body.sourceSnapshot.ratings['0:0'], 'Practicing');
    await db.query('DELETE FROM montessori_reports WHERE id=$1', [monId]);
    assert.equal((await send(body, key).expect(201)).body.id, created.id);
    const patch = (id, data, auth = adminToken) => http.patch(`${staffUrl}/${id}`).auth(auth, { type: 'bearer' }).send(data);
    await patch(created.id, { status: 'ready', expectedVersion: 1 }).expect(400);
    await patch(created.id, { status: 'preparing', expectedVersion: 99 }).expect(409);
    await patch(created.id, { status: 'preparing', expectedVersion: 1 }, teacherToken).expect(403);
    const preparing = (await patch(created.id, { status: 'preparing', expectedVersion: 1 }).expect(200)).body;
    assert.equal(preparing.version, 2);
    await patch(lao.id, { status: 'declined', expectedVersion: 1 }).expect(400);
    await patch(lao.id, { status: 'declined', expectedVersion: 1, declineReason: 'Contact the school', declineReasonLo: 'ກະລຸນາຕິດຕໍ່ໂຮງຮຽນ' }).expect(200);
    await patch(lao.id, { status: 'preparing', expectedVersion: 2 }).expect(409);
    await http.post(`${staffUrl}/${created.id}/document`).auth(adminToken, { type: 'bearer' }).field('expectedVersion', '2').attach('file', Buffer.from('not PDF'), 'bad.pdf').expect(400);
    const pdf = Buffer.from('%PDF-1.4\nOfficial report test fixture\n%%EOF');
    const ready = (await http.post(`${staffUrl}/${created.id}/documents/${created.documents[0].id}/document`).auth(adminToken, { type: 'bearer' }).field('expectedVersion', '2').attach('file', pdf, 'report.pdf').expect(201)).body;
    assert.equal(ready.status, 'ready'); assert.equal(ready.history.length, 3);
    assert.deepEqual((await get(`${staffUrl}/${created.id}/documents/${created.documents[0].id}/document`, {}, adminToken).expect(200)).body, pdf);
    await get(`${staffUrl}/${created.id}/documents/${created.documents[0].id}/document`, {}, teacherToken).expect(403);
    await get(`${staffUrl}/${created.id}/documents/${created.documents[0].id}/document`, {}, foreignToken).expect(403);
    await get(`${staffUrl}/${created.id}/documents/${created.documents[0].id}/document`, {}, token).expect(403);
    const detail = (await get(`${requestsPath}/${created.id}`).expect(200)).body;
    assert.equal(detail.sourceSnapshot, undefined); assert.equal(detail.parentId, undefined);
    const download = new URL(detail.documents[0].documentUrl);
    const document = await http.get(download.pathname + download.search).expect(200).expect('Content-Type', 'application/pdf');
    assert.deepEqual(document.body, pdf);
    const downloadToken = download.searchParams.get('token');
    await get(requestsPath, q, downloadToken).expect(401);
    await http.get(download.pathname).expect(401);
    await http.get(`/api/v2/official-report-documents/${lao.id}`).query({ token: downloadToken }).expect(401);
    const expired = jwt.sign({ sub: parent, requestId: created.id, purpose: 'official-report-download', version: 3 }, { secret: 'official-request-test-only:official-report-documents', expiresIn: -1 });
    await http.get(download.pathname).query({ token: expired }).expect(401);
    await db.query('UPDATE parents SET "isActive"=false WHERE id=$1', [parent]);
    await http.get(download.pathname + download.search).expect(403);
    await db.query('UPDATE parents SET "isActive"=true WHERE id=$1', [parent]);

    // Primary: published wins over newer reviewed draft; zero is a real score; another child's scores do not enable a request.
    const primary = { configurationId: randomUUID(), version: 1, status: 'published', classId: room, academicYearId: year, reportYear: '2026-2027', reportMonth: 1,
      subjectDefinitions: [{ slotKey: 'math', enabled: true, scoreMethod: 'manual', reportMaximum: 10 }],
      students: [{ studentId: child, scores: { math: { value: 0, method: 'manual', reportMaximum: 10 } } }, { studentId: otherChild, scores: { math: { value: 10 } } }],
      studentComments: [{ studentId: child, comment: 'Child comment' }, { studentId: otherChild, comment: 'Private other child' }] };
    await db.query('INSERT INTO rubric_report_data(id,kind,class_id,payload) VALUES($1,$2,$3,$4),($5,$6,$3,$7)', [primaryId, 'monthly-report-snapshot-v2', room, primary, reviewId, 'monthly-report-review-snapshot-v2', { ...primary, version: 9, status: 'reviewed' }]);
    let opts = (await get(optionsPath).expect(200)).body;
    let primaryOption = opts.terms[0].options[0];
    assert.equal(primaryOption.sourceReportId, primaryId); assert.equal(primaryOption.sourceVersion, 1); assert.equal(primaryOption.label, 'September 2026'); assert.equal(primaryOption.canRequest, true);
    const pRequest = (await send({ ...q, selectionId: primaryOption.id, documentLanguage: 'lo', sourceReportId: primaryOption.sourceReportId, sourceVersion: 1, template: primaryOption.template }).expect(201)).body;
    const frozen = (await get(`${staffUrl}/${pRequest.id}`, {}, adminToken).expect(200)).body.sourceSnapshot;
    assert.equal(frozen.students.length, 1); assert.equal(frozen.students[0].studentId, child); assert.equal(frozen.studentComments.length, 1);
    assert.equal(pRequest.documentType, 'primary-monthly');
    assert.equal(primaryOption.documents.length, 3);
    assert.equal(primaryOption.documents.find(d => d.id === 'primary-evaluation').canRequest, false);
    // A homeroom teacher can release directly from submitted; competing confirmations issue once.
    await http.post(`${staffUrl}/${pRequest.id}/documents/${pRequest.documents[0].id}/document`).auth(teacherToken, { type: 'bearer' }).field('expectedVersion', '1').attach('file', pdf, 'report.pdf').expect(403);
    await db.query('UPDATE classes SET homeroom_teacher_id=$2 WHERE id=$1', [room, teacher]);
    const releases = await Promise.all([teacherToken, adminToken].map(auth =>
      http.post(`${staffUrl}/${pRequest.id}/documents/${pRequest.documents[0].id}/document`).auth(auth, { type: 'bearer' }).field('expectedVersion', '1').attach('file', pdf, 'report.pdf')));
    assert.deepEqual(releases.map(response => response.status).sort(), [201, 409]);
    const issued = (await get(`${staffUrl}/${pRequest.id}`, {}, teacherToken).expect(200)).body;
    assert.equal(issued.status, 'ready'); assert.equal(issued.version, 2); assert.equal(issued.history.length, 2);
    assert.deepEqual((await get(`${staffUrl}/${pRequest.id}/documents/${pRequest.documents[0].id}/document`, {}, teacherToken).expect(200)).body, pdf);
    await db.query('UPDATE classes SET homeroom_teacher_id=NULL WHERE id=$1', [room]);
    await get(`${staffUrl}/${pRequest.id}/documents/${pRequest.documents[0].id}/document`, {}, teacherToken).expect(403);
    const evaluated = { ...primary, version: 2,
      subjectDefinitions: [...primary.subjectDefinitions, { slotKey: 'lao', subjectName: 'Lao Language', subjectId: randomUUID(), enabled: true, scoreMethod: 'evaluation', reportMaximum: 10 }, { slotKey: 'english', subjectName: 'English', subjectId: randomUUID(), enabled: true, scoreMethod: 'evaluation', reportMaximum: 10 }],
      students: primary.students.map(s => s.studentId !== child ? s : { ...s, scores: { ...s.scores, lao: { value: 7, method: 'evaluation', reportMaximum: 10, breakdown: [{ title: 'Reading', score: 2, maximum: 3 }] }, english: { value: 8, method: 'evaluation', reportMaximum: 10, breakdown: [{ title: 'Speaking', score: 3, maximum: 4 }] } } }) };
    await db.query('UPDATE rubric_report_data SET payload=$2 WHERE id=$1', [primaryId, evaluated]);
    const requestedOption = (await get(optionsPath).expect(200)).body.terms[0].options[0];
    const typedBody = { ...q, selectionId: requestedOption.id, documentLanguage: 'en', sourceReportId: requestedOption.sourceReportId, sourceVersion: 2, template: requestedOption.template };
    await send({ ...typedBody, documentType: 'whole-class' }).expect(409);
    await send({ ...typedBody, documentType: 'primary-evaluation', subjectSlot: 'other-child-subject' }).expect(409);
    const evaluation = (await send({ ...typedBody, documentType: 'primary-evaluation', subjectSlot: 'lao' }).expect(201)).body;
    assert.equal(evaluation.subjectName, 'Lao Language'); assert.equal(evaluation.documentLabel, 'Evaluation form');
    const evaluationSource = (await get(`${staffUrl}/${evaluation.id}`, {}, adminToken).expect(200)).body.sourceSnapshot;
    assert.equal(evaluationSource.students.length, 1); assert.deepEqual(Object.keys(evaluationSource.students[0].scores), ['lao']);
    assert.equal(evaluationSource.subjectDefinitions.length, 1);
    const yellow = (await send({ ...typedBody, documentType: 'primary-yellow-book' }).expect(201)).body;
    assert.equal(yellow.documentLabel, 'Yellow Book');
    const documents = [{ documentType: 'primary-monthly' }, { documentType: 'primary-evaluation', subjectSlot: 'lao' },
      { documentType: 'primary-evaluation', subjectSlot: 'english' }, { documentType: 'primary-yellow-book' }];
    const bundleBody = { ...typedBody, documents };
    await send({ ...bundleBody, documents: [] }).expect(400);
    await send({ ...bundleBody, documentType: 'primary-monthly' }).expect(400);
    await send({ ...bundleBody, documents: [documents[0], documents[0]] }).expect(400);
    await send({ ...bundleBody, documents: [{ documentType: 'primary-evaluation', subjectSlot: 'someone-else' }] }).expect(409);
    await send({ ...bundleBody, documents: [{ documentType: 'primary-monthly', subjectSlot: 'lao' }] }).expect(409);
    const beforeBundle = (await get(requestsPath).expect(200)).body.total;
    const bundleKey = randomUUID();
    const bundles = await Promise.all(Array.from({ length: 4 }, () => send(bundleBody, bundleKey).expect(201)));
    const bundle = bundles[0].body;
    assert.equal(new Set(bundles.map(r => r.body.id)).size, 1);
    assert.equal(bundle.documents.length, 4);
    assert.equal((await get(requestsPath).expect(200)).body.total, beforeBundle + 1);
    assert.equal((await send({ ...bundleBody, documents: [...documents].reverse() }, bundleKey).expect(201)).body.id, bundle.id);
    await send({ ...bundleBody, documents: documents.slice(1) }, bundleKey).expect(409);
    const bundleSnapshot = (await get(`${staffUrl}/${bundle.id}`, {}, adminToken).expect(200)).body.sourceSnapshot;
    assert.equal(bundleSnapshot.students.length, 1); assert.equal(bundleSnapshot.students[0].studentId, child);
    assert.deepEqual(Object.keys(bundleSnapshot.students[0].scores).sort(), ['english', 'lao', 'math']);
    const evaluationsOnly = (await send({ ...typedBody, documents: documents.filter(d => d.documentType === 'primary-evaluation') }).expect(201)).body;
    const evaluationsSnapshot = (await get(`${staffUrl}/${evaluationsOnly.id}`, {}, adminToken).expect(200)).body.sourceSnapshot;
    assert.deepEqual(Object.keys(evaluationsSnapshot.students[0].scores).sort(), ['english', 'lao']);
    assert.equal(evaluationsSnapshot.subjectDefinitions.length, 2);
    const octoberId = randomUUID();
    const october = {
      ...evaluated,
      reportMonth: 2,
      students: evaluated.students.map(s => s.studentId === child ? {
        ...s,
        scores: { ...s.scores, math: { value: 2, method: 'manual', reportMaximum: 10 } },
      } : s),
    };
    await db.query('INSERT INTO rubric_report_data(id,kind,class_id,payload) VALUES($1,$2,$3,$4)', [octoberId, 'monthly-report-snapshot-v2', room, october]);
    opts = (await get(optionsPath).expect(200)).body;
    const septemberOption = opts.terms[0].options.find(option => option.label === 'September 2026');
    const octoberOption = opts.terms[0].options.find(option => option.label === 'October 2026');
    const beforeMultiPeriod = (await get(requestsPath).expect(200)).body.total;
    const multiPeriod = (await send({
      ...q,
      documentLanguage: 'en',
      selections: [septemberOption, octoberOption].map(option => ({
        selectionId: option.id,
        sourceReportId: option.sourceReportId,
        sourceVersion: option.sourceVersion,
        template: option.template,
      })),
      documents: [{ documentType: 'primary-monthly' }],
    }).expect(201)).body;
    assert.equal((await get(requestsPath).expect(200)).body.total, beforeMultiPeriod + 1);
    assert.deepEqual(multiPeriod.reportingPeriods.map(period => period.period), ['September 2026', 'October 2026']);
    assert.equal(multiPeriod.documents.length, 2);
    assert.deepEqual(new Set(multiPeriod.documents.map(document => document.selectionId)).size, 2);
    const multiPeriodDetail = (await get(`${staffUrl}/${multiPeriod.id}`, {}, adminToken).expect(200)).body;
    assert.equal(multiPeriodDetail.sourceSnapshot.selections.length, 2);
    assert.deepEqual(multiPeriodDetail.sourceSnapshot.selections.map(item => item.snapshot.reportMonth), [1, 2]);
    await db.query('DELETE FROM rubric_report_data WHERE id = ANY($1::uuid[])', [[primaryId, octoberId]]);
    opts = (await get(optionsPath).expect(200)).body;
    assert.equal(opts.terms[0].options[0].sourceReportId, reviewId);
    await db.query('UPDATE rubric_report_data SET payload=$2 WHERE id=$1', [reviewId, { ...primary, status: 'reviewed', students: [primary.students[1]] }]);
    assert.equal((await get(optionsPath).expect(200)).body.terms.length, 0);

    // Kindergarten: use stored term/round, content changes invalidate the selection, and template is mapped automatically.
    const kgQ = { ...q, classId: kgRoom };
    const recordKey = `${branch}|2026-2027|${kgRoom}::${year}|${child}|criterion-1|2|1`;
    await db.query("INSERT INTO kindergarten_records VALUES($1,'assessments',$2,$3)", [branch, recordKey, { quality: 2, date: '2027-03-01', note: '' }]);
    const kgCatalog = (await get(optionsPath, kgQ).expect(200)).body;
    const kgOption = kgCatalog.terms[0].options[0];
    assert.equal(kgCatalog.terms[0].id, 'term-2'); assert.equal(kgOption.label, 'Assessment 1'); assert.equal(kgOption.template.templateId, 'kindergarten-2');
    const kgBody = { ...kgQ, selectionId: kgOption.id, documentLanguage: 'en', sourceReportId: kgOption.sourceReportId, sourceVersion: 1, template: kgOption.template };
    await send(kgBody).expect(201);
    await db.query("UPDATE kindergarten_records SET payload=jsonb_set(payload,'{quality}','3') WHERE record_key=$1", [recordKey]);
    await send(kgBody).expect(409);
    await db.query("INSERT INTO kindergarten_records VALUES($1::uuid,'school',$1::uuid::text,$2)", [branch, { reportTemplates: JSON.stringify({ [kgGrade]: '' }) }]);
    assert.equal((await get(optionsPath, kgQ).expect(200)).body.terms.length, 0);
    // Deleting a request also revokes its already-issued private PDF.
    const deleteTarget = (await get(`${staffUrl}/${pRequest.id}`, {}, adminToken).expect(200)).body;
    const parentBeforeDelete = (await get(`${requestsPath}/${pRequest.id}`).expect(200)).body;
    const deletedDownload = new URL(parentBeforeDelete.documents[0].documentUrl);
    const remove = (auth, version = deleteTarget.version) => http.delete(`${staffUrl}/${pRequest.id}`).auth(auth, { type: 'bearer' }).send({ expectedVersion: version });
    await remove(token).expect(403);
    await remove(foreignToken).expect(403);
    await remove(teacherToken).expect(403);
    await remove(adminToken, 0).expect(400);
    await remove(adminToken, deleteTarget.version - 1).expect(409);
    await get(`${staffUrl}/${pRequest.id}`, {}, adminToken).expect(200);
    assert.deepEqual((await remove(adminToken).expect(200)).body, { id: pRequest.id, deleted: true });
    await get(`${staffUrl}/${pRequest.id}`, {}, adminToken).expect(404);
    await get(`${requestsPath}/${pRequest.id}`).expect(404);
    await http.get(deletedDownload.pathname + deletedDownload.search).expect(404);
    assert.equal((await get(requestsPath).expect(200)).body.requests.some(r => r.id === pRequest.id), false);
    // Parents may delete only their own request, even when another parent shares the same child.
    const parentDeletePath = `${requestsPath}/${bundle.id}`;
    const parentDelete = (auth = token, scope = q, version = 1) => http.delete(parentDeletePath).auth(auth, { type: 'bearer' }).query(scope).send({ expectedVersion: version });
    await http.delete(parentDeletePath).query(q).send({ expectedVersion: 1 }).expect(401);
    await parentDelete(adminToken).expect(403);
    await parentDelete(strangerToken).expect(403);
    await db.query('INSERT INTO student_parents VALUES($1,$2)', [stranger, child]);
    await parentDelete(strangerToken).expect(404);
    await db.query('DELETE FROM student_parents WHERE parent_id=$1', [stranger]);
    await parentDelete(token, { ...q, classId: kgRoom }).expect(404);
    await parentDelete(token, { ...q, branchId: foreignBranch }).expect(403);
    await parentDelete(token, q, 0).expect(400);
    await parentDelete(token, q, 99).expect(409);
    const beforeParentDelete = (await get(requestsPath).expect(200)).body.total;
    // A staff release while the parent is confirming deletion invalidates the old version.
    await http.post(`${staffUrl}/${bundle.id}/documents/${bundle.documents[0].id}/document`).auth(adminToken, { type: 'bearer' }).field('expectedVersion', '1').attach('file', pdf, 'report.pdf').expect(201);
    const parentBundle = (await get(parentDeletePath).expect(200)).body;
    const parentBundleDownload = new URL(parentBundle.documents[0].documentUrl);
    await parentDelete().expect(409);
    assert.deepEqual((await parentDelete(token, q, 2).expect(200)).body, { id: bundle.id, deleted: true });
    assert.equal((await get(requestsPath).expect(200)).body.total, beforeParentDelete - 1);
    await get(parentDeletePath).expect(404);
    await get(`${staffUrl}/${bundle.id}`, {}, adminToken).expect(404);
    await http.get(parentBundleDownload.pathname + parentBundleDownload.search).expect(404);
    await parentDelete(token, q, 2).expect(404);
    await db.query('DELETE FROM student_parents WHERE parent_id=$1', [parent]);
    await get(requestsPath).expect(403);
    await http.get(download.pathname + download.search).expect(403);
    console.log('PASS: authenticated parent scope, actual periods/all three templates, source tampering/staleness, 8 concurrent idempotent retries, pagination, immutable child-only snapshots, staff permissions/status conflicts, private PDF delivery/expiry/revocation.');
  } finally {
    if (app) await app.close();
    if (db.isInitialized) await db.destroy();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.destroy();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
