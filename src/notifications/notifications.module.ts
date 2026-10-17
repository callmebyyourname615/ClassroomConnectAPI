import { MobilePushController } from './mobile-push.controller';
import { MobilePushService } from './mobile-push.service';
import { WebPushController } from './web-push.controller';
import { WebPushService } from './web-push.service';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { Notification } from './notification.entity';
import { TaskAccessModule } from '../task-access/task-access.module';
@Module({
  imports: [TypeOrmModule.forFeature([Notification]), TaskAccessModule],
  controllers: [
    MobilePushController,
    WebPushController,
    NotificationsController,
  ],
  providers: [NotificationsService, WebPushService, MobilePushService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
