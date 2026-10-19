import { Module } from '@nestjs/common';
import { MontessoriModule } from '../montessori/montessori.module';
import {
  ParentReportRequestsController,
  ReportDocumentsController,
  StaffReportRequestsController,
} from './report-requests.controller';
import { ReportRequestsService } from './report-requests.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [MontessoriModule, NotificationsModule],
  controllers: [
    ParentReportRequestsController,
    StaffReportRequestsController,
    ReportDocumentsController,
  ],
  providers: [ReportRequestsService],
})
export class ReportRequestsModule {}
