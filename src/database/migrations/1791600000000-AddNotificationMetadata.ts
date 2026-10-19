import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNotificationMetadata1791600000000
  implements MigrationInterface
{
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "metadata" jsonb NULL',
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "notifications" DROP COLUMN IF EXISTS "metadata"',
    );
  }
}
