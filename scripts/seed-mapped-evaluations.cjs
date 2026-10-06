/* Local demo data: dry-run by default; --apply backs up and commits atomically. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
const frontend = path.resolve(__dirname, '../../Admin_Panel_Alpha_sundaynewmerge');
const { mappedEvaluationCriteria, evaluationDefinitionMaximum } = require(path.join(frontend, 'domain/rubric/evaluationDefinitionScoring.ts'));
const { createGradeOneLaoPageTwoWorkbook } = require(path.join(frontend, 'utils/rubricGradeOneLaoPageTwo.ts'));
const mappingFile = path.join(frontend, 'server/data/evaluation-report-template-mappings.json');
const mappings = JSON.parse(fs.readFileSync(mappingFile, 'utf8')).mappings.filter(m => m.isActive !== false);
const marker = 'CC-LOCAL-MAPPED-EVALUATION-V1';
const outputDirectory = '/Users/macbookpro/Downloads/EvaluationFormTemplate/implemented-preview';
const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME };
if (!['127.0.0.1', 'localhost'].includes(config.host) || config.database !== 'classroomconnect') throw new Error('This seed is restricted to the local classroomconnect database.');
const apply = process.argv.includes('--apply');
const grade = value => Number(String(value).match(/(?:ປ|ອບ)\.?\s*(\d+)/)?.[1] || 0);
const scoreFor = (student, lesson, chapter, index, maximum) => {
    const random = crypto.createHash('sha256').update(`${marker}:${student}:${lesson}:${chapter}:${index}`).digest().readUInt32BE(0);
    const minimum = Math.max(1, Math.ceil(maximum * 0.55));
    return minimum + random % (maximum - minimum + 1);
};
async function main() {
    fs.mkdirSync(outputDirectory, { recursive: true });
    const client = new Client(config); await client.connect();
    try {
        const classes = (await client.query('SELECT c.*, y.name year_name FROM classes c JOIN year_levels y ON y.id=c.year_level_id WHERE c.is_active AND NOT c.is_deleted ORDER BY c.name')).rows;
        const lessons = (await client.query('SELECT l.*, st.name subject_name, y.name year_name FROM lessons l JOIN subject_types st ON st.id=l.subject_type_id JOIN year_levels y ON y.id=l.year_level_id WHERE NOT st.is_deleted')).rows;
        const roster = (await client.query(`SELECT DISTINCT e.class_id,e.student_id,e.branch_id,e.academic_year_id FROM enrollments e JOIN students s ON s.id=e.student_id JOIN academic_years a ON a.id=e.academic_year_id WHERE e.is_active AND s.is_active AND NOT s.is_deleted AND a.is_active AND NOT a.is_deleted`)).rows;
        const fallbackAdmin = (await client.query("SELECT id FROM admins WHERE NOT is_deleted ORDER BY CASE WHEN first_name='admin' THEN 0 ELSE 1 END,id LIMIT 1")).rows[0]?.id;
        if (!fallbackAdmin) throw new Error('No existing admin can own score records.');
        const scopes = []; const skipped = []; const missingRoster = [];
        for (const schoolClass of classes) {
            const students = roster.filter(r => r.class_id === schoolClass.id);
            if (!students.length) { missingRoster.push(schoolClass.name); continue; }
            if (new Set(students.map(s => s.academic_year_id)).size !== 1) throw new Error(`Multiple active academic years in ${schoolClass.name}`);
            for (const lesson of lessons.filter(l => l.year_level_id === schoolClass.year_level_id)) {
                const mapping = mappings.find(m => Number(m.gradeLevel) === grade(lesson.year_name) && m.subjectName === lesson.subject_name);
                if (!mapping) { skipped.push({ className: schoolClass.name, subjectName: lesson.subject_name, reason: 'No active saved form mapping' }); continue; }
                const definitions = Array.from({ length: 4 }, (_, index) => ({ topic: `ບົດທີ ${index + 1}`, chapter: index + 1, contents: mappedEvaluationCriteria(mapping.formKey, lesson.subject_name, index + 1) }));
                scopes.push({ schoolClass, lesson, mapping, students, definitions, adminId: schoolClass.homeroom_teacher_id || fallbackAdmin });
            }
        }
        if (missingRoster.length) throw new Error(`Missing students: ${missingRoster.join(', ')}`);
        if (new Set(scopes.map(s => s.schoolClass.id)).size !== classes.length) throw new Error('Not every active room has a mapped assessment.');
        const summary = {
            marker, mode: apply ? 'applied' : 'dry-run', chapterFrom: 1, chapterTo: 4,
            classCount: classes.length, studentCount: new Set(scopes.flatMap(s => s.students.map(s => s.student_id))).size,
            subjectCount: scopes.length, definitionCount: scopes.length * 4,
            criterionCount: scopes.reduce((n, s) => n + s.definitions.reduce((n,d) => n + d.contents.length, 0), 0),
            scoreCount: scopes.reduce((n, s) => n + s.definitions.reduce((n,d) => n + d.contents.length * s.students.length, 0), 0),
            skipped, classrooms: classes.map(c => ({ id: c.id, name: c.name, studentCount: roster.filter(s => s.class_id === c.id).length, subjectCount: scopes.filter(s => s.schoolClass.id === c.id).length })),
            assessments: scopes.map(s => ({ classId:s.schoolClass.id, className:s.schoolClass.name, lessonId:s.lesson.id, subjectName:s.lesson.subject_name, mappingId:s.mapping.id, formKey:s.mapping.formKey, chapters:s.definitions.map(d=>({topic:d.topic,criteria:d.contents.map((c,i)=>({contentIndex:i,title:c.t_title,prompt:c.e_title[0],maximum:c.maxScore}))})) })),
        };
        fs.writeFileSync(path.join(outputDirectory, 'evaluation-score-seed-plan.json'), JSON.stringify(summary, null, 2));
        console.log(JSON.stringify({ ...summary, assessments: undefined }, null, 2));
        if (!apply) return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backup = `/Users/macbookpro/Downloads/classroomconnect/backups/classroomconnect_before_mapped_evaluations_${timestamp}.dump`;
        execFileSync('/opt/homebrew/bin/pg_dump', ['-h',config.host,'-p',String(config.port),'-U',config.user,'-d',config.database,'-Fc','-f',backup], { env:{...process.env,PGPASSWORD:config.password} });
        fs.copyFileSync(mappingFile, path.join(outputDirectory, `form-mappings-before-score-seed-${timestamp}.json`));
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('classroomconnect-mapped-evaluation-seed'))");
        const created = { subjects:0, definitions:0, scores:0 }; const definitionIds = [];
        for (const scope of scopes) {
            const { schoolClass, lesson, students, mapping } = scope;
            const subjectResult = await client.query('SELECT id FROM subjects WHERE class_id=$1 AND subject_type_id=$2 AND NOT is_deleted', [schoolClass.id,lesson.subject_type_id]);
            if (subjectResult.rows.length > 1) throw new Error('Ambiguous class subject');
            let subjectId = subjectResult.rows[0]?.id;
            if (!subjectId) { subjectId=crypto.randomUUID(); await client.query('INSERT INTO subjects (id,class_id,subject_type_id,is_active,is_deleted) VALUES ($1,$2,$3,true,false)',[subjectId,schoolClass.id,lesson.subject_type_id]); created.subjects++; }
            await client.query('INSERT INTO subject_lessons (subject_id,lesson_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[subjectId,lesson.id]);
            for (const branchId of new Set(students.map(s=>s.branch_id))) await client.query('INSERT INTO branch_subjects (subject_id,branch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[subjectId,branchId]);
            for (const definition of scope.definitions) {
                const existing = await client.query('SELECT * FROM subject_evaluations WHERE lesson_id=$1 AND topic=$2', [lesson.id,definition.topic]);
                if (existing.rows.length > 1) throw new Error('Duplicate assessment chapter');
                let saved = existing.rows[0];
                if (saved && (saved.contents.length !== definition.contents.length || saved.contents.some((c,i)=>evaluationDefinitionMaximum(saved,i)!==definition.contents[i].maxScore))) throw new Error(`Existing assessment differs from mapping: ${lesson.subject_name} ${definition.topic}`);
                if (!saved) {
                    const id = crypto.randomUUID();
                    const formLabel = { grade1_page1: 'Form 1', grade1_page2: 'Form 2', form3: 'Form 3', form4: 'Form 4' }[mapping.formKey] || mapping.formKey;
                    const description = `ຊຸດປະເມີນຕົວຢ່າງ · ${formLabel} · ${definition.contents.length} ຂໍ້ຕໍ່ບົດ`;
                    saved=(await client.query('INSERT INTO subject_evaluations (id,lesson_id,topic,description,contents) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *',[id,lesson.id,definition.topic,description,JSON.stringify(definition.contents)])).rows[0]; created.definitions++;
                }
                definitionIds.push(saved.id);
                for (const student of students) for (const [index,content] of definition.contents.entries()) {
                    const score=scoreFor(student.student_id,lesson.id,definition.chapter,index,content.maxScore);
                    const r=await client.query(`INSERT INTO evaluations (subject_id,admin_id,class_id,student_id,subject_evaluation_id,content_index,score) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (student_id,subject_evaluation_id,content_index) DO NOTHING`,[subjectId,scope.adminId,schoolClass.id,student.student_id,saved.id,index,score]);created.scores+=r.rowCount;
                }
            }
        }
        // Form 2's old extra header row covered C7:F7, where score payloads put
        // student 1. Install the aligned editable template if the group is absent.
        const workspace=(await client.query("SELECT * FROM rubric_workspaces WHERE workspace_key='default' FOR UPDATE")).rows[0];
        if (!workspace) throw new Error('No default rubric workspace');
        const formTwoId='object-1785578754748-14';
        if (!workspace.objects.some(o=>o.id===formTwoId && o.sheetWorkbook)) {
            const object={id:formTwoId,type:'frame',x:80,y:2200,width:1100,height:600,fill:'#ffffff',stroke:'#64748b',label:'Form 2',isGroup:true,fontSize:18,fontWeight:700,sheetWorkbook:createGradeOneLaoPageTwoWorkbook(),sheetUpdatedAt:new Date().toISOString()};
            await client.query('UPDATE rubric_workspaces SET objects=$1::jsonb,updated_at=NOW() WHERE id=$2',[JSON.stringify([...workspace.objects,object]),workspace.id]);
        }
        // Match the current reporting month and expose the four seeded chapters.
        const calendarMonth=Number(new Intl.DateTimeFormat('en-US',{month:'numeric',timeZone:'Asia/Vientiane'}).format(new Date()));
        const reportMonth=calendarMonth>=9?calendarMonth-8:calendarMonth+4;
        for (const schoolClass of classes) await client.query(`INSERT INTO rubric_report_month_settings (class_id,student_id,subject_id,month,lesson_from,lesson_to,comment) VALUES ($1,'','report:seeded-evaluation-range',$2,1,4,'Local demo assessments') ON CONFLICT (class_id,student_id,subject_id,month) DO NOTHING`,[schoolClass.id,reportMonth]);
        const invalid=(await client.query(`SELECT e.id FROM evaluations e JOIN subject_evaluations d ON d.id=e.subject_evaluation_id WHERE d.id=ANY($1::uuid[]) AND (e.content_index<0 OR e.content_index>=jsonb_array_length(d.contents) OR e.score IS NULL OR e.score<0 OR e.score>(d.contents->e.content_index->>'maxScore')::numeric OR NOT EXISTS(SELECT 1 FROM enrollments r WHERE r.student_id=e.student_id AND r.class_id=e.class_id AND r.is_active))`,[definitionIds])).rows;
        if (invalid.length) throw new Error(`${invalid.length} invalid score records`);
        const savedScoreCount=Number((await client.query('SELECT count(*) FROM evaluations WHERE subject_evaluation_id=ANY($1::uuid[])',[definitionIds])).rows[0].count);
        if (savedScoreCount!==summary.scoreCount) throw new Error(`Incomplete scores: ${savedScoreCount}/${summary.scoreCount}`);
        await client.query('COMMIT');
        if (process.env.REDIS_URL) { const Redis=require('ioredis'),redis=new Redis(process.env.REDIS_URL); let cursor='0';do { const page=await redis.scan(cursor,'MATCH',`${process.env.CACHE_PREFIX||'alphaschool'}:subjects*`,'COUNT',100);cursor=page[0];if(page[1].length)await redis.del(...page[1]); } while(cursor!=='0');await redis.quit(); }
        const result={...summary,backup,created,savedScoreCount,reportMonth,completedAt:new Date().toISOString()};
        fs.writeFileSync(path.join(outputDirectory,'evaluation-score-seed-manifest.json'),JSON.stringify(result,null,2));
        console.log(JSON.stringify({created,savedScoreCount,reportMonth,backup},null,2));
    } catch(error) { await client.query('ROLLBACK').catch(()=>{});throw error; }
    finally { await client.end(); }
}
main().catch(error=>{ console.error(error.message);process.exitCode=1; });
