import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, Message } from 'firebase-admin/messaging';
import { pushMessage } from './web-push.service';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateMobileDevice(body: any) {
  if (
    !uuid.test(body?.deviceId ?? '') ||
    !['android', 'ios'].includes(body?.platform) ||
    !['en', 'lo'].includes(body?.language) ||
    typeof body?.token !== 'string' ||
    body.token.length < 20 ||
    body.token.length > 4096 ||
    /\s/.test(body.token)
  ) {
    throw new BadRequestException('Invalid mobile device');
  }
  return {
    deviceId: body.deviceId,
    token: body.token,
    platform: body.platform,
    language: body.language,
  };
}
export function mobileMessage(row: any): Message {
  const text = pushMessage(row, row.language);
  return {
    token: row.token,
    notification: { title: text.title, body: text.body },
    data: {
      notificationId: String(row.id),
      studentId: String(row.student_id || ''),
      type: String(row.metadata?.type || ''),
    },
    android: {
      priority: 'high',
      ttl: 86400000,
      notification: {
        channelId: 'alpha_school_updates_v1',
        icon: 'ic_stat_notification',
        sound: 'default',
        tag: String(row.id),
      },
    },
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-push-type': 'alert',
        'apns-collapse-id': String(row.id),
      },
      payload: { aps: { sound: 'default' } },
    },
  };
}
@Injectable()
export class MobilePushService {
  private running = false;
  private readonly logger = new Logger(MobilePushService.name);
  constructor(private readonly db: DataSource) {}
  configuration() {
    return {
      enabled:
        process.env.MOBILE_PUSH_ENABLED === 'true' &&
        !!process.env.FIREBASE_PROJECT_ID,
    };
  }
  private messaging() {
    const app =
      getApps().find((a) => a.name === 'alpha-mobile-push') ??
      initializeApp(
        {
          credential: applicationDefault(),
          projectId: process.env.FIREBASE_PROJECT_ID,
        },
        'alpha-mobile-push',
      );
    return getMessaging(app);
  }
  async register(parentId: string, body: any) {
    if (!this.configuration().enabled)
      throw new ServiceUnavailableException('Mobile push is not configured');
    const d = validateMobileDevice(body);
    try {
      await this.db.query(
        `INSERT INTO parent_mobile_devices(parent_id,device_id,token,platform,language)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(parent_id,device_id) DO UPDATE
        SET token=EXCLUDED.token,platform=EXCLUDED.platform,language=EXCLUDED.language,updated_at=now()`,
        [parentId, d.deviceId, d.token, d.platform, d.language],
      );
    } catch (e) {
      if ((e as any)?.code === '23505')
        throw new ForbiddenException('Device token belongs to another account');
      throw e;
    }
    return { enabled: true };
  }
  async unregister(parentId: string, deviceId: string) {
    if (!uuid.test(deviceId ?? ''))
      throw new BadRequestException('Invalid device ID');
    await this.db.query(
      'DELETE FROM parent_mobile_devices WHERE parent_id=$1 AND device_id=$2',
      [parentId, deviceId],
    );
    return { enabled: false };
  }
  @Interval(5000)
  async dispatch() {
    if (this.running || !this.configuration().enabled) return;
    this.running = true;
    const r = this.db.createQueryRunner();
    let locked = false;
    try {
      await r.connect();
      locked = (
        await r.query(
          "SELECT pg_try_advisory_lock(hashtext('parent-mobile-push')) AS locked",
        )
      )[0]?.locked;
      if (!locked) return;
      const rows =
        await r.query(`SELECT s.id AS device_row_id,s.token,s.language,n.id,n.title,n.message,n.metadata,n.student_id
        FROM parent_mobile_devices s JOIN notifications n ON n.parent_id=s.parent_id
        LEFT JOIN parent_mobile_deliveries d ON d.device_id=s.id AND d.notification_id=n.id
        WHERE n.created_at>=s.created_at AND n.is_deleted=false AND n.seen=0
        AND (d.notification_id IS NULL OR (d.delivered_at IS NULL AND d.attempts<5 AND d.retry_at<=now()))
        ORDER BY n.created_at LIMIT 20`);
      const gone = new Set<string>();
      for (const row of rows) {
        if (gone.has(row.device_row_id)) continue;
        try {
          await this.messaging().send(mobileMessage(row));
          await r.query(
            `INSERT INTO parent_mobile_deliveries(device_id,notification_id,attempts,delivered_at)
            VALUES($1,$2,1,now()) ON CONFLICT(device_id,notification_id) DO UPDATE SET delivered_at=now(),attempts=parent_mobile_deliveries.attempts+1`,
            [row.device_row_id, row.id],
          );
        } catch (e) {
          if (
            [
              'messaging/registration-token-not-registered',
              'messaging/invalid-registration-token',
            ].includes((e as any)?.code)
          ) {
            gone.add(row.device_row_id);
            await r.query(
              'DELETE FROM parent_mobile_devices WHERE id=$1 AND token=$2',
              [row.device_row_id, row.token],
            );
          } else {
            await r.query(
              `INSERT INTO parent_mobile_deliveries(device_id,notification_id,attempts,retry_at)
              VALUES($1,$2,1,now()+interval '30 seconds') ON CONFLICT(device_id,notification_id)
              DO UPDATE SET attempts=parent_mobile_deliveries.attempts+1,retry_at=now()+interval '2 minutes'`,
              [row.device_row_id, row.id],
            );
          }
        }
      }
    } catch {
      this.logger.warn(
        'Mobile push delivery deferred; check Firebase credentials and delivery queue',
      );
    } finally {
      try {
        if (locked)
          await r.query(
            "SELECT pg_advisory_unlock(hashtext('parent-mobile-push'))",
          );
      } finally {
        try {
          await r.release();
        } finally {
          this.running = false;
        }
      }
    }
  }
}
