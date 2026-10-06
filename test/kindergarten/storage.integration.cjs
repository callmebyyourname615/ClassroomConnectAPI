/* PostgreSQL + HTTP integration test. All fixtures live in a disposable schema. */
require('dotenv').config({quiet:true});require('reflect-metadata');
const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');const fs=require('node:fs');
const {DataSource}=require('typeorm');const {Test}=require('@nestjs/testing');const {APP_GUARD}=require('@nestjs/core');const {JwtService}=require('@nestjs/jwt');const {ValidationPipe}=require('@nestjs/common');const request=require('supertest');const sharp=require('sharp');
const {KindergartenController}=require('../../dist/kindergarten/kindergarten.controller');const {KindergartenService}=require('../../dist/kindergarten/kindergarten.service');const {JwtAuthGuard}=require('../../dist/auth/jwt-auth.guard');const {kindergartenSchema}=require('../../dist/kindergarten/kindergarten.schema');
(async()=>{
 const schema='kg_test_'+Date.now();const connection={type:'postgres',host:process.env.DB_HOST,port:+process.env.DB_PORT,user:undefined,username:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME};
 const adminDb=new DataSource(connection);await adminDb.initialize();await adminDb.query(`CREATE SCHEMA "${schema}"`);
 const db=new DataSource({...connection,extra:{options:`-c search_path=${schema}`}});await db.initialize();let app;
 try {
  const branch=randomUUID(),otherBranch=randomUUID(),admin=randomUUID(),room=randomUUID(),year=randomUUID(),student=randomUUID();
  await db.query(`CREATE TABLE branches(id uuid PRIMARY KEY);CREATE TABLE admins(id uuid PRIMARY KEY,branch_id uuid,is_active boolean,is_deleted boolean);CREATE TABLE classes(id uuid PRIMARY KEY,is_deleted boolean);CREATE TABLE academic_years(id uuid PRIMARY KEY,year_name text,start_date date,end_date date);CREATE TABLE enrollments(id uuid PRIMARY KEY,branch_id uuid,class_id uuid,academic_year_id uuid,student_id uuid);CREATE TABLE attendances(student_id uuid,attendance_date date,type text,reason text,remark text);`);
  await db.query(kindergartenSchema);
  await db.query('INSERT INTO branches VALUES($1),($2)',[branch,otherBranch]);await db.query('INSERT INTO admins VALUES($1,$2,true,false)',[admin,branch]);await db.query('INSERT INTO classes VALUES($1,false)',[room]);await db.query("INSERT INTO academic_years VALUES($1,'2026-2027','2026-09-01','2027-06-30')",[year]);await db.query('INSERT INTO enrollments VALUES($1,$2,$3,$4,$5)',[randomUUID(),branch,room,year,student]);await db.query("INSERT INTO attendances VALUES($1,'2026-10-05','PRESENT',null,'ON_TIME')",[student]);
  const jwt=new JwtService({secret:'kindergarten-integration-test-secret',signOptions:{expiresIn:'1h'}});
  const module=await Test.createTestingModule({controllers:[KindergartenController],providers:[KindergartenService,{provide:DataSource,useValue:db},{provide:JwtService,useValue:jwt},{provide:APP_GUARD,useClass:JwtAuthGuard}]}).compile();
  app=module.createNestApplication();app.enableCors({origin:'http://localhost:3000',credentials:true});app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true}));await app.listen(process.env.KG_TEST_PORT || 0,'127.0.0.1');
  const token=jwt.sign({sub:admin,branch:{id:branch}});const server=app.getHttpServer();const base=`/kindergarten/${branch}`;const api=(method,path)=>request(server)[method](base+path).set('Authorization',`Bearer ${token}`);
  await request(server).get(base+'/records').expect(401);await request(server).get(`/kindergarten/${otherBranch}/records`).set('Authorization',`Bearer ${token}`).expect(403);
  const scope=`${branch}|2026-2027|${room}::${year}`;const growth={date:'2026-10-05',weight:'19.5',height:'110',arm:'16',note:'ທົດສອບ',weightFlag:'normal'};
  const key=scope+'|'+student+'|1|1';await api('patch','/records').send({changes:[{collection:'growth',key,expectedVersion:0,value:growth}]}).expect(200);
  assert.equal((await api('get','/records').expect(200)).body.records[0].value.weight,'19.5');
  // Two teachers cannot silently overwrite the same record. Different records coexist.
  const edits=await Promise.all(['20','21'].map(weight=>api('patch','/records').send({changes:[{collection:'growth',key,expectedVersion:1,value:{...growth,weight}}]})));
  assert.deepEqual(edits.map(r=>r.status).sort(),[200,409]);
  await api('patch','/records').send({changes:[{collection:'growth',key:key.replace(student,randomUUID()),expectedVersion:0,value:growth}]}).expect(400);
  await api('patch','/records').send({changes:[{collection:'growth',key:key+'|bad',expectedVersion:0,value:{...growth,weight:'-1'}}]}).expect(400);
  await api('patch','/records').send({changes:[{collection:'holidays',key:scope+'|2026-10-06',expectedVersion:0,value:true},{collection:'unknown',key:'bad',expectedVersion:0,value:{}}]}).expect(400);
  assert(!(await api('get','/records')).body.records.some(r=>r.collection==='holidays'));
  const image=await sharp({create:{width:100,height:100,channels:3,background:'#4361ee'}}).png().toBuffer();const asset=(await api('post','/assets').attach('file',image,{filename:'work.png',contentType:'image/png'}).expect(201)).body.id;
  const downloaded=await api('get',`/assets/${asset}`).expect(200);assert(Buffer.compare(downloaded.body,image)===0);
  await api('post','/assets').attach('file',Buffer.from('fake'),{filename:'fake.png',contentType:'image/png'}).expect(400);
  const pdf=Buffer.from('%PDF-1.4\n1 0 obj <</Type /Catalog>> endobj\n%%EOF');
  const pdfAsset=(await api('post','/evidence-files').attach('file',pdf,{filename:'evidence.pdf',contentType:'application/pdf'}).expect(201)).body.id;
  await api('post','/assets').attach('file',pdf,{filename:'work.pdf',contentType:'application/pdf'}).expect(400);
  await api('post','/evidence-files').attach('file',Buffer.from('fake'),{filename:'fake.pdf',contentType:'application/pdf'}).expect(400);
  const file={id:randomUUID(),assetId:pdfAsset,name:'evidence.pdf',mime:'application/pdf',size:pdf.length,uploadedAt:new Date().toISOString(),note:'teacher evidence'};
  const assessmentKey=scope+'|'+student+'|criterion-22-0|1|1';
  const assessment={quality:2,note:'assessment',evidence:[],evidenceFiles:[file],date:'2026-10-05'};
  await api('patch','/records').send({changes:[{collection:'assessments',key:assessmentKey,expectedVersion:0,value:assessment}]}).expect(200);
  assert.deepEqual((await api('get','/records')).body.records.find(r=>r.collection==='assessments').value.evidenceFiles,[file]);
  await api('get',`/assets/${pdfAsset}`).expect('Content-Type',/application\/pdf/).expect(200);
  for(const invalid of [{...file,assetId:randomUUID()},{...file,mime:'image/png'},{...file,size:1}])
    await api('patch','/records').send({changes:[{collection:'assessments',key:assessmentKey,expectedVersion:1,value:{...assessment,evidenceFiles:[invalid]}}]}).expect(400);
  const snapshot={id:randomUUID(),at:new Date().toISOString(),revision:1,title:'ປຶ້ມທົດສອບ',options:{classId:room+'::'+year,academicYearLabel:'2026-2027',kind:'main',privacy:'private',studentIds:[student]},state:{students:[],enrollments:{}},pages:[{}],images:{},warnings:[],templateVersion:'1'};
  await api('post','/reports').send({snapshot}).expect(201);assert.deepEqual((await api('get',`/reports/${snapshot.id}`).expect(200)).body,snapshot);
  await api('post','/reports').send({snapshot:{...snapshot,title:'Changed'}}).expect(409);
  assert.equal((await api('get','/records')).body.history.length,1);
  assert.equal((await api('get',`/attendance/${room}/${year}`)).body.length,1);
  assert.equal((await api('get',`/attendance/${room}/${year}`)).body[0].attendance_date,'2026-10-05');
  const secondStudent=randomUUID();
  await db.query('INSERT INTO enrollments VALUES($1,$2,$3,$4,$5)',[randomUUID(),branch,room,year,secondStudent]);
  const order={studentIds:[student,secondStudent]};
  await api('patch','/records').send({changes:[{collection:'rosterOrders',key:scope,expectedVersion:0,value:order}]}).expect(200);
  assert.deepEqual((await api('get','/records')).body.records.find(r=>r.collection==='rosterOrders').value,order);
  for(const invalid of [null,{studentIds:[secondStudent,student]},{studentIds:[student]},{studentIds:[student,secondStudent,randomUUID()]},{studentIds:[student,student]}])
    await api('patch','/records').send({changes:[{collection:'rosterOrders',key:scope,expectedVersion:1,value:invalid}]}).expect(400);
  const thirdStudent=randomUUID();await db.query('INSERT INTO enrollments VALUES($1,$2,$3,$4,$5)',[randomUUID(),branch,room,year,thirdStudent]);
  await api('patch','/records').send({changes:[{collection:'rosterOrders',key:scope,expectedVersion:1,value:{studentIds:[student,secondStudent,thirdStudent]}}]}).expect(200);
  // HTTP fixture server is used by the browser persistence test, never the real school schema.
  if(process.env.KG_TEST_PORT){
   await db.query('DELETE FROM kindergarten_records');await db.query('DELETE FROM kindergarten_reports');
   fs.writeFileSync('/tmp/kg-api-fixture.json',JSON.stringify({branch,admin,room,year,student,token,origin:await app.getUrl()}));console.log('Isolated kindergarten API ready');
   await new Promise(resolve=>process.once('SIGTERM',resolve));
  } else console.log('PASS: authentication, branch isolation, persistence, CAS conflicts, atomic rollback, uploads, immutable reports and attendance');
 } finally {if(app)await app.close();await db.destroy();await adminDb.query(`DROP SCHEMA "${schema}" CASCADE`);await adminDb.destroy();}
})().catch(e=>{console.error(e);process.exit(1)});
