import { MigrationInterface, QueryRunner } from 'typeorm';
import { reportRequestsSchema } from '../../report-requests/report-requests.schema';

export class CreateOfficialReportRequests1791781000000
  implements MigrationInterface
{
  name = 'CreateOfficialReportRequests1791781000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(reportRequestsSchema);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE official_report_requests');
  }
}
