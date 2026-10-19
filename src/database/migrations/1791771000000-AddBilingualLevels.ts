import { MigrationInterface, QueryRunner } from 'typeorm';
import { alignBilingualNameTable } from '../bilingual-subject-types';

export class AddBilingualLevels1791771000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await alignBilingualNameTable(queryRunner, 'levels');
    await alignBilingualNameTable(queryRunner, 'year_levels');
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE year_levels DROP COLUMN IF EXISTS name_translations',
    );
    await queryRunner.query(
      'ALTER TABLE levels DROP COLUMN IF EXISTS name_translations',
    );
  }
}
