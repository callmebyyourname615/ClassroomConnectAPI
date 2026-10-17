import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Task } from './task.entity';
import { FileModule } from '../file/file.module';
import { File } from '../file/files.entity';
import { Class } from '../classes/class.entity';
import { Enrollment } from '../enrollments/enrollment.entity';
import { Student } from '../students/student.entity';
import { TaskSubmissionSlot } from '../task-submission/task-submission-slot.entity';
import { TaskService } from './task.service';
import { TaskController } from './task.controller';
import { TaskNotificationService } from './task-notification.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Task,
      File,
      Class,
      Enrollment,
      Student,
      TaskSubmissionSlot,
    ]),
    FileModule,
  ],
  providers: [TaskService, TaskNotificationService],
  controllers: [TaskController],
})
export class TaskModule {}
