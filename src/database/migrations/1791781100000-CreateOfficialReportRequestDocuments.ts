import { MigrationInterface, QueryRunner } from 'typeorm';
import { reportRequestDocumentsSchema } from '../../report-requests/report-requests.schema';

export class CreateOfficialReportRequestDocuments1791781100000
  implements MigrationInterface
{
  name = 'CreateOfficialReportRequestDocuments1791781100000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(reportRequestDocumentsSchema);
  }

  async down(): Promise<void> {
    throw new Error(
      'Request documents cannot be rolled back after files have been released.',
    );
  }
}
