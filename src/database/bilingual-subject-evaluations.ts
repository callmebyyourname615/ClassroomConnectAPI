import {
  evaluationTextTranslations,
  localizeEvaluationContents,
} from '../subject_evaluations/subject-evaluation-localization';

export async function alignBilingualSubjectEvaluations(db: {
  query: (...args: any[]) => Promise<any>;
}) {
  await db.query(`ALTER TABLE subject_evaluations
    ADD COLUMN IF NOT EXISTS topic_translations jsonb NULL,
    ADD COLUMN IF NOT EXISTS description_translations jsonb NULL`);
  const rows = await db.query(
    'SELECT id, topic, description, contents FROM subject_evaluations WHERE topic_translations IS NULL',
  );
  for (const row of rows) {
    const safe = (value: string) => {
      try {
        return evaluationTextTranslations(value);
      } catch {
        return value ? { la: value, en: null } : null;
      }
    };
    const contents = (row.contents || []).map((content) => {
      try {
        return localizeEvaluationContents([content])[0];
      } catch {
        return {
          ...content,
          t_title_translations: safe(content.t_title),
          e_title_translations: (content.e_title || []).map(safe),
        };
      }
    });
    await db.query(
      `UPDATE subject_evaluations SET topic_translations=$1::jsonb, description_translations=$2::jsonb, contents=$3::jsonb WHERE id=$4 AND topic_translations IS NULL`,
      [
        JSON.stringify(safe(row.topic)),
        JSON.stringify(safe(row.description)),
        JSON.stringify(contents),
        row.id,
      ],
    );
  }
}
