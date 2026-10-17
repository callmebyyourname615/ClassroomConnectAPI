import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { alignBilingualSubjectTypes, alignBilingualNameTable } from './bilingual-subject-types';
import { alignBilingualSubjectEvaluations } from './bilingual-subject-evaluations';

@Injectable()
export class SchemaAlignmentService implements OnModuleInit {
  private readonly logger = new Logger(SchemaAlignmentService.name);
  private alignmentPromise: Promise<void> | null = null;

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await this.alignAllSchemas();
  }

  async alignAllSchemas(): Promise<void> {
    if (this.alignmentPromise) {
      return this.alignmentPromise;
    }

    this.alignmentPromise = (async () => {
      try {
        this.logger.log('Starting automated database schema alignment...');
        await alignBilingualSubjectTypes(this.dataSource);
        await alignBilingualNameTable(this.dataSource, 'levels');
        await alignBilingualNameTable(this.dataSource, 'year_levels');
        await alignBilingualNameTable(this.dataSource, 'classes');
        await alignBilingualNameTable(this.dataSource, 'branches');
        await alignBilingualSubjectEvaluations(this.dataSource);

        // 1. Students table alignment
        await this.dataSource.query(`
          ALTER TABLE "students"
            ADD COLUMN IF NOT EXISTS "approval_status" varchar(16) NOT NULL DEFAULT 'pending',
            ADD COLUMN IF NOT EXISTS "rejected_at" timestamptz NULL,
            ADD COLUMN IF NOT EXISTS "reject_reason" text NULL,
            ADD COLUMN IF NOT EXISTS "health_review_required" boolean NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS "health_review_reasons" jsonb NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS "physical_disability" jsonb NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS "health_history" jsonb NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS "protective_info" jsonb NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS "live_with" jsonb NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS "emergency_contacts" jsonb NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS "bos_info" jsonb NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS "sibling_info" jsonb NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS "his_school_nursery" jsonb NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS "his_school_kindergarten" jsonb NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS "his_school_primary" jsonb NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS "saving_wallet" numeric(18, 2) NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS "is_deleted" boolean NOT NULL DEFAULT false;
        `);

        // 2. Parents table alignment
        await this.dataSource.query(`
          ALTER TABLE "parents"
            ADD COLUMN IF NOT EXISTS "approval_status" varchar(16) NOT NULL DEFAULT 'pending',
            ADD COLUMN IF NOT EXISTS "rejected_at" timestamptz NULL,
            ADD COLUMN IF NOT EXISTS "reject_reason" text NULL,
            ADD COLUMN IF NOT EXISTS "branch_id" uuid NULL,
            ADD COLUMN IF NOT EXISTS "home_number" varchar(20) NULL,
            ADD COLUMN IF NOT EXISTS "home_unit" varchar(20) NULL,
            ADD COLUMN IF NOT EXISTS "home_address" text NULL,
            ADD COLUMN IF NOT EXISTS "home_picture_url" varchar(512) NULL,
            ADD COLUMN IF NOT EXISTS "work_province" varchar(255) NULL,
            ADD COLUMN IF NOT EXISTS "work_district" varchar(255) NULL,
            ADD COLUMN IF NOT EXISTS "work_village" varchar(255) NULL,
            ADD COLUMN IF NOT EXISTS "occupation" varchar(255) NULL,
            ADD COLUMN IF NOT EXISTS "company_name" varchar(255) NULL,
            ADD COLUMN IF NOT EXISTS "profilePictureUrl" varchar(512) NULL,
            ADD COLUMN IF NOT EXISTS "idCardUrl" varchar(512) NULL,
            ADD COLUMN IF NOT EXISTS "isDeleted" boolean NOT NULL DEFAULT false;
        `);

        // 3. Admins table alignment
        await this.dataSource.query(`
          ALTER TABLE "admins"
            ADD COLUMN IF NOT EXISTS "home_no" varchar(100) NULL,
            ADD COLUMN IF NOT EXISTS "unit" varchar(100) NULL,
            ADD COLUMN IF NOT EXISTS "sub_district" varchar(100) NULL,
            ADD COLUMN IF NOT EXISTS "birth_sub_district" varchar(100) NULL,
            ADD COLUMN IF NOT EXISTS "middle_name_La" varchar(100) NULL,
            ADD COLUMN IF NOT EXISTS "nick_name" varchar(100) NULL,
            ADD COLUMN IF NOT EXISTS "home_address" text NULL,
            ADD COLUMN IF NOT EXISTS "home_picture_url" varchar(255) NULL,
            ADD COLUMN IF NOT EXISTS "current_academic_year" varchar(20) NULL;
        `);

        // 4. Classes table alignment
        await this.dataSource.query(`
          ALTER TABLE "classes"
            ADD COLUMN IF NOT EXISTS "homeroom_teacher_id" uuid NULL;
        `);

        // 5. Tasks table alignment
        await this.dataSource.query(`
          ALTER TABLE "tasks"
            ADD COLUMN IF NOT EXISTS "practice_frequency" integer NULL,
            ADD COLUMN IF NOT EXISTS "practice_frequency_unit" varchar(8) NULL;
        `);

        this.logger.log(
          'Automated database schema alignment completed successfully.',
        );
      } catch (error) {
        this.logger.error('Failed to align database schema:', error);
      } finally {
        this.alignmentPromise = null;
      }
    })();

    return this.alignmentPromise;
  }
}
