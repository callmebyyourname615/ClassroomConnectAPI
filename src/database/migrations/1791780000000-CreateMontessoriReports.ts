import { MigrationInterface, QueryRunner } from 'typeorm';
import { montessoriSchema } from '../../montessori/montessori.schema';
export class CreateMontessoriReports1791780000000
  implements MigrationInterface
{
  name = 'CreateMontessoriReports1791780000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(montessoriSchema);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'DROP TABLE montessori_report_revisions; DROP TABLE montessori_reports;',
    );
  }
}
