import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DataSource, In } from 'typeorm';
import { Task } from './task.entity';
import { notifyTask } from './task-notification';

@Injectable()
export class TaskNotificationService {
  private running = false;
  private readonly logger = new Logger(TaskNotificationService.name);
  constructor(private readonly db: DataSource) {}

  @Interval(60000)
  async dispatch(now = new Date(), taskId?: string) {
    if (this.running) return;
    this.running = true;
    try {
      const tasks = await this.db
        .getRepository(Task)
        .find({
          where: taskId
            ? { id: taskId }
            : {
                status: In(['assigned', 'in_progress', 'submitted', 'overdue']),
              },
          select: ['id'],
        });
      for (const candidate of tasks) {
        try {
          await this.db.transaction(async (manager) => {
            const locked = await manager.findOne(Task, {
              where: { id: candidate.id },
              lock: { mode: 'pessimistic_write' },
            });
            if (!locked) return;
            const task = await manager.findOne(Task, {
              where: { id: candidate.id },
              relations: ['student'],
            });
            if (task) await notifyTask(manager, task, now);
          });
        } catch (error) {
          this.logger.error(
            `Task ${candidate.id} reminder failed: ${error.message}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}
