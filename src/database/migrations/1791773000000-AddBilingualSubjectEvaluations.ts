import { MigrationInterface, QueryRunner } from 'typeorm';
import { alignBilingualSubjectEvaluations } from '../bilingual-subject-evaluations';

export class AddBilingualSubjectEvaluations1791773000000
  implements MigrationInterface
{
  async up(queryRunner: QueryRunner): Promise<void> {
    await alignBilingualSubjectEvaluations(queryRunner);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE subject_evaluations DROP COLUMN IF EXISTS topic_translations, DROP COLUMN IF EXISTS description_translations',
    );
  }
}
