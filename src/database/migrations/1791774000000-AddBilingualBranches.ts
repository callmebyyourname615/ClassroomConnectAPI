import { MigrationInterface, QueryRunner } from 'typeorm';
import { alignBilingualNameTable } from '../bilingual-subject-types';

export class AddBilingualBranches1791774000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await alignBilingualNameTable(queryRunner, 'branches');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE branches DROP COLUMN IF EXISTS name_translations',
    );
  }
}
