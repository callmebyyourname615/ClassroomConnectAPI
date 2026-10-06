/* Local, reproducible demo exams. Review first; --apply backs up before writing. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
const { periods, buildMathQuestions } = require('./lib/math-demo-exam.cjs');
const frontend = path.resolve(__dirname, '../../Admin_Panel_Alpha_sundaynewmerge');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
const { configurableReportSubjectSlots, findReportSubjectSlot } = require(path.join(frontend, 'domain/rubric/reportSubjects.ts'));
const output = '/Users/macbookpro/Downloads/EvaluationFormTemplate/implemented-preview';
const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME };
if (!['localhost','127.0.0.1'].includes(config.host) || config.database !== 'classroomconnect') throw new Error('Restricted to local classroomconnect.');
const apply = process.argv.includes('--apply');
async function main() {
    const client = new Client(config); await client.connect();
    try {
        const years = (await client.query('SELECT * FROM academic_years WHERE is_active AND NOT is_deleted')).rows;
        if (years.length !== 1) throw new Error('Expected one active academic year.');
        const year = years[0], startYear = Number(year.year_name.match(/\d{4}/)?.[0]);
        if (!startYear) throw new Error('Academic year has no start year.');
        const classes = (await client.query('SELECT * FROM classes WHERE is_active AND NOT is_deleted ORDER BY name')).rows;
        const roster = (await client.query('SELECT e.* FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.is_active AND s.is_active AND NOT s.is_deleted AND e.academic_year_id=$1',[year.id])).rows;
        const type = (await client.query("SELECT * FROM subject_types WHERE name='ຄະນິດສາດ' AND NOT is_deleted")).rows;
        if (type.length !== 1) throw new Error('Expected one existing mathematics subject type.');
        const admin = (await client.query("SELECT id FROM admins WHERE NOT is_deleted ORDER BY CASE WHEN first_name='admin' THEN 0 ELSE 1 END,id LIMIT 1")).rows[0]?.id;
        if (!admin) throw new Error('No grading admin exists.');
        const exams = [];
        for (const schoolClass of classes) {
            const students = roster.filter(e => e.class_id === schoolClass.id);
            if (students.length !== 5 || new Set(students.map(s=>s.student_id)).size !== 5) throw new Error(`Expected five distinct active enrollments in ${schoolClass.name}`);
            for (const period of periods) {
                const filename = `cc-math-${startYear}-${schoolClass.id}-${period.key}`;
                const title = `ຄະນິດສາດ · ${period.label} · ${schoolClass.name} · ${year.year_name}`;
                exams.push({ classId: schoolClass.id, className: schoolClass.name, branchId: students[0].branch_id, period, title,
                    examDate: `${period.month >= 9 ? startYear : startYear + 1}-${String(period.month).padStart(2,'0')}-20T02:00:00.000Z`,
                    durationMinutes: period.term ? 45 : 30, maxScore: 10, passScore: 5,
                    questions: buildMathQuestions(schoolClass.name,period),
                    examFile: `uploads/examinations/${filename}-questions.pdf`, answerFile: `uploads/examinations/${filename}-answers.pdf`,
                    results: students.map(student => ({ studentId: student.student_id, enrollmentId: student.id,
                        score: 4 + crypto.createHash('sha256').update(`cc-math-demo:${student.student_id}:${schoolClass.id}:${period.key}`).digest().readUInt32BE(0) % 7 })),
                });
            }
        }
        const plan = { academicYearId:year.id, academicYearLabel:year.year_name, classCount:classes.length, studentCount:new Set(roster.map(e=>e.student_id)).size, examCount:exams.length, resultCount:exams.reduce((n,e)=>n+e.results.length,0), minimumScore:4,maximumScore:10, exams };
        fs.mkdirSync(output,{recursive:true}); const planFile = path.join(output,'math-examination-seed-plan.json'); fs.writeFileSync(planFile,JSON.stringify(plan,null,2));
        console.log(JSON.stringify({...plan,exams:undefined},null,2)); if (!apply) return;
        const timestamp = new Date().toISOString().replace(/[:.]/g,'-');
        const backup = `/Users/macbookpro/Downloads/classroomconnect/backups/classroomconnect_before_math_examinations_${timestamp}.dump`;
        execFileSync('/opt/homebrew/bin/pg_dump',['-h',config.host,'-p',String(config.port),'-U',config.user,'-d',config.database,'-Fc','-f',backup],{env:{...process.env,PGPASSWORD:config.password}});
        execFileSync('python3',[path.join(__dirname,'render-math-exam-pdfs.py'),planFile],{env:{...process.env,PYTHONPATH:'/tmp/classroomconnect-playwright'},stdio:'inherit'});
        await client.query('BEGIN'); await client.query("SELECT pg_advisory_xact_lock(hashtext('classroomconnect-math-exam-seed'))");
        const created = { subjects:0,exams:0,results:0,monthlyConfigurations:0,termMappings:0,termSettings:0 };
        const classSubjects = new Map();
        for (const schoolClass of classes) {
            const existing = (await client.query('SELECT id FROM subjects WHERE class_id=$1 AND subject_type_id=$2 AND NOT is_deleted',[schoolClass.id,type[0].id])).rows;
            if (existing.length > 1) throw new Error('Ambiguous math subject.');
            const id = existing[0]?.id || crypto.randomUUID();
            if (!existing.length) { await client.query('INSERT INTO subjects(id,class_id,subject_type_id,is_active,is_deleted) VALUES($1,$2,$3,true,false)',[id,schoolClass.id,type[0].id]); created.subjects++; }
            classSubjects.set(schoolClass.id,id);
            for (const branch of new Set(roster.filter(r=>r.class_id===schoolClass.id).map(r=>r.branch_id))) await client.query('INSERT INTO branch_subjects(subject_id,branch_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,branch]);
        }
        async function store(kind,scopeKey,classId,month,payload) {
            await client.query(`INSERT INTO rubric_report_data(id,kind,scope_key,class_id,report_month,report_year,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(kind,scope_key) DO UPDATE SET payload=EXCLUDED.payload,report_month=EXCLUDED.report_month,updated_at=NOW()`,[crypto.randomUUID(),kind,scopeKey,classId,month,year.year_name,JSON.stringify(payload)]);
        }
        const allSubjects = (await client.query('SELECT s.*,t.name subject_name FROM subjects s JOIN subject_types t ON t.id=s.subject_type_id WHERE NOT s.is_deleted')).rows;
        for (const exam of exams) {
            const subjectId = classSubjects.get(exam.classId), schoolClass = classes.find(c=>c.id===exam.classId), now = new Date().toISOString();
            const existing = (await client.query('SELECT * FROM examinations WHERE class_id=$1 AND academic_year_id=$2 AND title=$3 AND NOT is_deleted',[exam.classId,year.id,exam.title])).rows;
            if (existing.length > 1) throw new Error('Duplicate demo examination.');
            let id = existing[0]?.id;
            if (existing.length && (Number(existing[0].max_score)!==10 || existing[0].subject_id!==subjectId)) throw new Error('Existing examination differs from seed plan.');
            if (!id) {
                id = crypto.randomUUID();
                await client.query(`INSERT INTO examinations(id,branch_id,academic_year_id,class_id,subject_id,title,description,exam_date,duration_minutes,max_score,pass_score,created_by_id,exam_file,answer_file) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,10,5,$10,$11,$12)`,[id,exam.branchId,year.id,exam.classId,subjectId,exam.title,'ຂໍ້ສອບຕົວຢ່າງ 10 ຂໍ້ · ຂໍ້ລະ 1 ຄະແນນ · ເບິ່ງໂຈດ ແລະ ແນວຄຳຕອບໃນໄຟລ໌ PDF',exam.examDate,exam.durationMinutes,admin,exam.examFile,exam.answerFile]);created.exams++;
            }
            exam.id=id; exam.subjectId=subjectId;
            for (const result of exam.results) {
                const saved=(await client.query('SELECT * FROM examination_results WHERE examination_id=$1 AND student_id=$2 AND NOT is_deleted',[id,result.studentId])).rows;
                if (saved.length > 1) throw new Error('Duplicate student exam result.');
                if (!saved.length) { await client.query(`INSERT INTO examination_results(id,examination_id,student_id,enrollment_id,graded_by,score,is_passed,remark) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[crypto.randomUUID(),id,result.studentId,result.enrollmentId,schoolClass.homeroom_teacher_id||admin,result.score,result.score>=5,'ຄະແນນຕົວຢ່າງສຸ່ມ 4–10']);created.results++; }
                else result.score=Number(saved[0].score);
            }
            const base={academicYearId:year.id,academicYearLabel:year.year_name,classId:exam.classId,subjectId,subjectName:type[0].name,subjectSlotKey:'math',examinationId:id,updatedAt:now,updatedBy:admin};
            if (exam.period.term) {
                const term=exam.period.term;
                const existingSettings=(await client.query('SELECT payload FROM rubric_report_data WHERE kind=$1 AND scope_key=$2',['yellow-book-term-subject-setting-v1',`${year.id}:${exam.classId}:${term}:math`])).rows[0]?.payload;
                if (existingSettings?.examinationId && existingSettings.examinationId!==id) throw new Error('Existing math term selection differs; refusing to replace it.');
                await store('yellow-book-term-examination-v1',id,exam.classId,null,{...base,term});created.termMappings++;
                await store('yellow-book-term-subject-setting-v1',`${year.id}:${exam.classId}:${term}:math`,exam.classId,null,{...base,term,scoreMethod:'examination',manualScores:{}});created.termSettings++;
            } else {
                const month=exam.period.reportMonth, scope=`${year.id}:${exam.classId}:${month}`;
                const existingConfig=(await client.query('SELECT payload FROM rubric_report_data WHERE kind=$1 AND scope_key=$2 FOR UPDATE',['monthly-report-configuration-v2',scope])).rows[0]?.payload;
                if (existingConfig?.status==='published') throw new Error('Published monthly configuration will not be edited.');
                const configuration=existingConfig || {id:crypto.randomUUID(),academicYearId:year.id,academicYearLabel:year.year_name,branchId:exam.branchId,classId:exam.classId,reportMonth:month,reportYear:year.year_name,status:'draft',version:1,createdAt:now,createdBy:admin,subjects:configurableReportSubjectSlots.map(slot=>{const linked=allSubjects.find(s=>s.class_id===exam.classId && findReportSubjectSlot(s.subject_name)?.key===slot.key);return {slotKey:slot.key,subjectId:linked?.id||'',subjectName:linked?.subject_name||slot.label,enabled:Boolean(linked),lessonSelectionMode:'range',lessonIds:[],lessonFrom:null,lessonTo:null,scoreMethod:'evaluation',examinationId:null,reportMaximum:slot.reportMaximum,roundingMode:'two_decimals'};})};
                const math=configuration.subjects.find(s=>s.slotKey==='math');
                if (!math) throw new Error('Monthly configuration missing math slot.');
                if (math.examinationId && math.examinationId!==id) throw new Error('Existing monthly math selection differs; refusing to replace it.');
                Object.assign(math,{subjectId,subjectName:type[0].name,enabled:true,scoreMethod:'examination',examinationId:id});
                configuration.branchId ||= exam.branchId; configuration.updatedAt=now;configuration.updatedBy=admin;
                await store('monthly-report-configuration-v2',scope,exam.classId,month,configuration);created.monthlyConfigurations++;
            }
        }
        const ids=exams.map(e=>e.id);
        const audit=(await client.query(`SELECT count(*) results,count(*) FILTER(WHERE r.score<4 OR r.score>10 OR r.score IS NULL OR r.enrollment_id<>e.id OR e.class_id<>x.class_id OR e.student_id<>r.student_id OR e.academic_year_id<>x.academic_year_id OR r.is_passed<>(r.score>=x.pass_score)) invalid FROM examination_results r JOIN examinations x ON x.id=r.examination_id JOIN enrollments e ON e.id=r.enrollment_id WHERE x.id=ANY($1::uuid[]) AND NOT r.is_deleted`,[ids])).rows[0];
        if (Number(audit.results)!==plan.resultCount || Number(audit.invalid)) throw new Error(`Invalid/incomplete exam scores: ${JSON.stringify(audit)}`);
        await client.query('COMMIT');
        if (process.env.REDIS_URL) {const Redis=require('ioredis'),redis=new Redis(process.env.REDIS_URL);let cursor='0';do{const [next,keys]=await redis.scan(cursor,'MATCH',`${process.env.CACHE_PREFIX||'alphaschool'}:subjects*`,'COUNT',100);cursor=next;if(keys.length)await redis.del(...keys);}while(cursor!=='0');await redis.quit();}
        fs.writeFileSync(path.join(output,'math-examination-seed-manifest.json'),JSON.stringify({...plan,backup,created,completedAt:new Date().toISOString()},null,2));
        console.log(JSON.stringify({created,audit,backup},null,2));
    } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;} finally {await client.end();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
