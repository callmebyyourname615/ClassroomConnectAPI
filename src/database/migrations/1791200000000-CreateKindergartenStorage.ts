import { MigrationInterface, QueryRunner } from 'typeorm';
import { kindergartenSchema } from '../../kindergarten/kindergarten.schema';
export class CreateKindergartenStorage1791200000000 implements MigrationInterface {
  name = 'CreateKindergartenStorage1791200000000';
  async up(runner: QueryRunner) {
    await runner.query(kindergartenSchema);
  }
  async down(runner: QueryRunner) {
    await runner.query(
      'DROP TABLE kindergarten_reports; DROP TABLE kindergarten_assets; DROP TABLE kindergarten_records;',
    );
  }
}
