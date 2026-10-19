import { MigrationInterface, QueryRunner } from 'typeorm';
import { reportRequestMultiPeriodSchema } from '../../report-requests/report-requests.schema';

export class AddOfficialReportRequestMultiPeriod1791781200000
  implements MigrationInterface
{
  name = 'AddOfficialReportRequestMultiPeriod1791781200000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(reportRequestMultiPeriodSchema);
  }

  async down(): Promise<void> {
    throw new Error(
      'Multi-period report request documents cannot be rolled back after requests are created.',
    );
  }
}
