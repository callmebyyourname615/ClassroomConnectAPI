import { MigrationInterface, QueryRunner } from 'typeorm';
import { alignBilingualSubjectTypes } from '../bilingual-subject-types';

export class AddBilingualSubjectTypes1791770000000
  implements MigrationInterface
{
  async up(queryRunner: QueryRunner): Promise<void> {
    await alignBilingualSubjectTypes(queryRunner);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE subject_types DROP COLUMN IF EXISTS name_translations',
    );
  }
}
