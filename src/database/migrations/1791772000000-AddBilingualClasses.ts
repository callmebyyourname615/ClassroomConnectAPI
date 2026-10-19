import { MigrationInterface, QueryRunner } from 'typeorm';
import { alignBilingualNameTable } from '../bilingual-subject-types';

export class AddBilingualClasses1791772000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await alignBilingualNameTable(queryRunner, 'classes');
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE classes DROP COLUMN IF EXISTS name_translations',
    );
  }
}
