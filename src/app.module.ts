import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { HealthModule } from './health/health.module';
import { HealthController } from './health/health.controller';
import { BranchModule } from './branches/branch.module';
import { LoggerModule } from './common/logger.module';
import { AcademicYearModule } from './academic_years/academic-year.module';
import { LevelsModule } from './levels/levels.module';
import { YearLevelsModule } from './year_levels/year-levels.module';
import { ClassesModule } from './classes/classes.module';
import { SubjectModule } from './subjects/subjects.module';
import { AdminsModule } from './admins/admins.module';
import { RolesModule } from './roles/roles.module';
import { AuthModule } from './auth/auth.module';
import { LaocationModule } from './location/laocation.module';
import { PermissionsModule } from './permission/permissions.module';
import { PermissionModuleModule } from './permission_modules/permission-module.module';
import { ParentModule } from './parents/parent.module';
import { TeachingModule } from './teachings/teachings.module';
import { TaskModule } from './task/task.module';
import { EventModule } from './event/event.module';
import { EventActivityModule } from './eventactivity/eventActivity.module';
import { FileModule } from './file/file.module';
import { ParticipationScoreModule } from './participantion_score/participation-score.module';
import { ParticipationListModule } from './participantion_list/participation_list.module';
import { SavingsModule } from './savings/saving.module';
import { StudentModule } from './students/student.module';
import { StudentLinkRequestModule } from './student-link-requests/student-link-request.module';
import { ServeStaticModule } from '@nestjs/serve-static';
import { AnnouncementsModule } from './announcements/announcements.module';
import { EvaluationModule } from './evaluations/evaluation.module';
import { AppointmentModule } from './appointment/appointment.module';
import { AppointmentPersonModule } from './appointment-person/appointment-person.module';
import { CommentsModule } from './comments/comments.module';
import { ExaminationModule } from './examination/examination.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SubjectTypeModule } from './subject_types/subject-type.module';
import { CurriculumModule } from './curriculums/curriculum.module';
import { SubjectEvaluationModule } from './subject_evaluations/subject-evaluation.module';
import { ScheduleModule } from '@nestjs/schedule';
import { TeachLearningModule } from './teach_learning/teach-learning.module';
import { TeacherHomeworkModule } from './teacher-homework/teacher-homework.module';
import { HomeworkResultModule } from './homework-result/homework-result.module';
import { LessonModule } from './lesson/lesson.module';
import { EnrollmentModule } from './enrollments/enrollment.module';
import { ExaminationResultModule } from './examination_results/examination-result.module';
import { TimetableModule } from './timetables/timetable.module';
import { PayReceiveModule } from './pay_receivce/pay-receive.module';
import { LeaveReasonModule } from './leave_reason/leave-reason.module';
import { AttendanceModule } from './attendance/attendance.module';
import { AttendanceRuleModule } from './attendance/attendance-rule.module';
import { SaveWithdrawReasonModule } from './save_resson/save-withdraw-reason.module';
import { BankDepositBatchModule } from './bankdepositbatch/bank-deposit-batch.module';
import { MenuReadsModule } from './menu-reads/menu-reads.module';
import { FeeTemplateModule } from './fees/module/fee-template.module';
import { FeeAssignmentModule } from './fees/module/fee-assignment.module';
import { StudentFeeModule } from './fees/module/student-fee.module';
import { PaymentRecordModule } from './fees/module/payment-record.module';
import { SiblingGroupModule } from './sibling/sibling.module';
import { TaskSubmissionModule } from './task-submission/task-submission.module';
import { TaskNoteModule } from './task-note/task-note.module';
import { ChatReadModule } from './chat-read/chat-read.module';
import { TaskActivityModule } from './task-activity/task-activity.module';
import { ParasiteInjectionModule } from './parasite-injection/parasite.injection.module';
import { StudentNutritionModule } from './nutrition/nutrition.module';
import { FoodRestrictionModule } from './food_restriction/food-restriction.module';
import { GalleryModule } from './gallery/gallery.module';
import { RubricSettingsModule } from './rubric_settings/rubric-settings.module';
import { RubricReportMonthSettingModule } from './rubric_report_month_settings/rubric-report-month-setting.module';
import { RubricEvaluationFinalScoreModule } from './rubric_evaluation_final_scores/rubric-evaluation-final-score.module';
import { RubricReportDataModule } from './rubric_report_data/rubric-report-data.module';
import { CacheModule } from './common/cache.module';
import { KindergartenModule } from './kindergarten/kindergarten.module';
import { SchemaAlignmentModule } from './database/schema-alignment.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    ScheduleModule.forRoot(),

    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST'),
        port: Number(config.get<string>('DB_PORT') ?? '5432'),
        username: config.get<string>('DB_USER'),
        password: config.get<string>('DB_PASS'),
        database: config.get<string>('DB_NAME'),
        autoLoadEntities: true,
        // Keep schema synchronization opt-in only. In shared/staging/production
        // databases it can block startup on DDL locks and should be replaced by
        // migrations.
        synchronize: config.get<string>('TYPEORM_SYNCHRONIZE') === 'true',
        connectTimeoutMS: 5000,
        extra: {
          max: Number(config.get<string>('DB_POOL_MAX') ?? '10'),
          connectionTimeoutMillis: 5000,
          query_timeout: 30000,
        },
      }),
    }),

    LoggerModule,
    SchemaAlignmentModule,
    KindergartenModule,
    CacheModule,
    HealthModule,
    AuthModule,
    BranchModule,
    AcademicYearModule,
    LevelsModule,
    YearLevelsModule,
    ClassesModule,
    SubjectModule,
    RolesModule,
    AdminsModule,
    LaocationModule,
    PermissionsModule,
    PermissionModuleModule,
    ParentModule,
    TeachingModule,
    TaskModule,
    EventModule,
    EventActivityModule,
    FileModule,
    ParticipationListModule,
    ParticipationScoreModule,
    SavingsModule,
    AttendanceModule,
    StudentModule,
    StudentLinkRequestModule,
    AnnouncementsModule,
    EvaluationModule,
    AppointmentModule,
    AppointmentPersonModule,
    CommentsModule,
    ExaminationModule,
    NotificationsModule,
    SubjectTypeModule,
    CurriculumModule,
    SubjectEvaluationModule,
    TeachLearningModule,
    TeacherHomeworkModule,
    HomeworkResultModule,
    LessonModule,
    EnrollmentModule,
    ExaminationResultModule,
    TimetableModule,
    PayReceiveModule,
    LeaveReasonModule,
    AttendanceRuleModule,
    SaveWithdrawReasonModule,
    BankDepositBatchModule,
    MenuReadsModule,

    FeeTemplateModule,
    FeeAssignmentModule,
    StudentFeeModule,
    PaymentRecordModule,
    SiblingGroupModule,
    ParasiteInjectionModule,
    StudentNutritionModule,
    FoodRestrictionModule,
    GalleryModule,
    RubricSettingsModule,
    RubricReportMonthSettingModule,
    RubricEvaluationFinalScoreModule,
    RubricReportDataModule,
    TaskSubmissionModule,
    TaskNoteModule,
    ChatReadModule,
    TaskActivityModule,
  ],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],

  controllers: [AppController, HealthController],
})
export class AppModule {}
