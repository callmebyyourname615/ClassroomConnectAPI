import { parseBilingualName } from '../common/bilingual-name';

export async function alignBilingualNameTable(
  db: {
    query: (...args: any[]) => Promise<any>;
  },
  table: 'subject_types' | 'levels' | 'year_levels' | 'classes' | 'branches',
) {
  await db.query(
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS name_translations jsonb NULL`,
  );
  const rows = await db.query(
    `SELECT id, name FROM ${table} WHERE name_translations IS NULL`,
  );
  for (const row of rows) {
    let translations;
    try {
      translations = parseBilingualName(row.name);
    } catch {
      // Preserve older names containing incomplete parentheses verbatim.
      translations = { la: row.name, en: null };
    }
    await db.query(
      `UPDATE ${table} SET name_translations=$1::jsonb WHERE id=$2 AND name_translations IS NULL`,
      [JSON.stringify(translations), row.id],
    );
  }
}

export async function alignBilingualSubjectTypes(db: {
  query: (...args: any[]) => Promise<any>;
}) {
  await alignBilingualNameTable(db, 'subject_types');
}
