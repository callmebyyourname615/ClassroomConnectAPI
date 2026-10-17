import { Module } from '@nestjs/common';
import { KindergartenController } from './kindergarten.controller';
import { KindergartenService } from './kindergarten.service';
import { StudentReportsController } from './student-reports.controller';
import { StudentReportsService } from './student-reports.service';
@Module({
  controllers: [KindergartenController, StudentReportsController],
  providers: [KindergartenService, StudentReportsService],
})
export class KindergartenModule {}
