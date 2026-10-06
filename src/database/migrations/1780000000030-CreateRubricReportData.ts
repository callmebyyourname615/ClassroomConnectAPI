import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRubricReportData1780000000030 implements MigrationInterface {
  name = 'CreateRubricReportData1780000000030';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "rubric_report_data" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "kind" varchar(64) NOT NULL,
        "scope_key" varchar(255) NOT NULL,
        "class_id" varchar NOT NULL DEFAULT '',
        "student_id" varchar NOT NULL DEFAULT '',
        "report_month" integer,
        "report_year" varchar NOT NULL DEFAULT '',
        "payload" jsonb NOT NULL,
        "expires_at" timestamptz,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_rubric_report_data" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_rubric_report_data_scope" UNIQUE ("kind", "scope_key")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_rubric_report_data_lookup" ON "rubric_report_data" ("kind", "class_id", "report_year", "report_month")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_rubric_report_data_lookup"`);
    await queryRunner.query(`DROP TABLE "rubric_report_data"`);
  }
}
