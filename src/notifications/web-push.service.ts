import {
  appointmentEventTitles,
  AppointmentEvent,
} from '../appointment/appointment-notification';
import {
  taskNotificationTitles,
  TaskNotificationEvent,
} from '../task/task-notification';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import * as webPush from 'web-push';

export function validatePushSubscription(body: any) {
  let endpoint: URL;
  try {
    endpoint = new URL(body?.endpoint);
  } catch {
    throw new BadRequestException('Invalid push endpoint');
  }
  const host = endpoint.hostname;
  const allowed =
    host === 'fcm.googleapis.com' ||
    host === 'updates.push.services.mozilla.com' ||
    host === 'web.push.apple.com' ||
    host === 'wns2-par02p.notify.windows.com' ||
    host.endsWith('.notify.windows.com');
  if (
    !allowed ||
    endpoint.protocol !== 'https:' ||
    endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  )
    throw new BadRequestException('Unsupported push service');
  const validKey = (value: unknown, length: number) =>
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value, 'base64url').length === length;
  if (!validKey(body?.keys?.p256dh, 65) || !validKey(body?.keys?.auth, 16))
    throw new BadRequestException('Invalid subscription keys');
  if (!['en', 'lo'].includes(body?.language))
    throw new BadRequestException('Unsupported language');
  return {
    endpoint: endpoint.href,
    p256dh: body.keys.p256dh,
    auth: body.keys.auth,
    language: body.language,
  };
}

export function pushMessage(notification: any, language: string) {
  const data = notification.metadata || {};
  const lo = language === 'lo';
  let title = notification.title || '';
  let body = notification.message || '';
  if (data.type === 'task') {
    const titles =
      taskNotificationTitles[data.event as TaskNotificationEvent] ||
      taskNotificationTitles.assigned;
    title = lo ? titles.lo : titles.en;
    body = [
      data.studentName,
      data.taskTitle,
      data.subjectName,
      data.round ? `${lo ? 'ຮອບ' : 'Round'} ${data.round}` : '',
      `${data.dueDate || ''} ${data.dueTime || ''}`.trim(),
    ]
      .filter(Boolean)
      .join('\n');
  } else if (data.type === 'gallery') {
    title = lo ? 'ຮູບພາບໃໝ່' : 'New gallery post';
    body = [
      data.studentName,
      data.galleryTitle,
      data.description,
      data.category,
      data.location,
    ]
      .filter(Boolean)
      .join('\n');
  } else if (data.type === 'appointment') {
    const event = data.event as AppointmentEvent;
    const titles =
      appointmentEventTitles[event] || appointmentEventTitles.updated;
    title = lo ? titles.lo : titles.en;
    body = [
      data.appointmentTitle,
      data.appointmentDate,
      `${String(data.fromTime || '').slice(0, 5)}–${String(data.toTime || '').slice(0, 5)}`,
      data.place,
      data.participantName,
      data.responseNote,
    ]
      .filter(Boolean)
      .join('\n');
  } else if (data.type === 'evaluation_score') {
    title = lo ? 'ຜົນການປະເມີນໃໝ່' : 'New assessment result';
    body = [
      data.studentName,
      data.subjectName,
      data.assessmentTitle,
      `${lo ? 'ຄະແນນ' : 'Score'}: ${data.score ?? ''}${data.maxScore == null ? '' : ` / ${data.maxScore}`}`,
    ]
      .filter(Boolean)
      .join('\n');
  } else if (data.type === 'examination_score') {
    title = lo ? 'ຜົນຄະແນນສອບເສັງ' : 'Examination result';
    body = [
      data.studentName,
      data.subjectName,
      data.examinationTitle,
      `${lo ? 'ຄະແນນ' : 'Score'}: ${data.score ?? ''} / ${data.maxScore ?? ''}`,
      `${lo ? 'ວັນທີສອບເສັງ' : 'Exam date'}: ${data.examDate ?? ''}`,
    ]
      .filter(Boolean)
      .join('\n');
  } else if (data.type === 'monthly_report') {
    title = lo ? 'ອັບເດດລາຍງານປະຈຳເດືອນ' : 'Monthly report updated';
    body = [
      data.studentName,
      `${data.calendarMonth ?? data.reportMonth} · ${data.reportYear || ''}`,
    ]
      .filter(Boolean)
      .join(' · ');
  } else if (data.type === 'homework') {
    title = lo ? 'ວຽກບ້ານໃໝ່' : 'New homework';
    body = [data.studentName, data.subjectName, data.homeworkTitle]
      .filter(Boolean)
      .join(' · ');
  } else if (data.type === 'daily_evaluation') {
    title = lo ? 'ຜົນການປະເມີນປະຈຳວັນ' : 'Daily assessment result';
    body = [
      data.studentName,
      data.assessmentDate,
      `${lo ? 'ຄະແນນລວມ' : 'Total score'}: ${data.score ?? ''}${data.maxScore == null ? '' : ` / ${data.maxScore}`}`,
    ]
      .filter(Boolean)
      .join(' · ');
  } else if (data.type === 'attendance') {
    title =
      data.event === 'check_in'
        ? lo
          ? 'ເຂົ້າໂຮງຮຽນແລ້ວ'
          : 'Checked in at school'
        : data.event === 'check_out'
          ? lo
            ? 'ອອກຈາກໂຮງຮຽນແລ້ວ'
            : 'Checked out of school'
          : lo
            ? 'ອັບເດດການເຂົ້າຮຽນ'
            : 'Attendance updated';
    const statuses: Record<string, string> = lo
      ? { PRESENT: 'ມາຮຽນ', LATE: 'ມາຊ້າ', ABSENT: 'ຂາດຮຽນ' }
      : { PRESENT: 'Present', LATE: 'Late', ABSENT: 'Absent' };
    body = [
      data.studentName,
      statuses[data.status],
      data.attendanceDate,
      data.event === 'check_out' ? data.checkOut : data.checkIn,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  return {
    title,
    body: String(body).slice(0, 900),
    notificationId: notification.id,
    studentId: notification.student_id,
  };
}

@Injectable()
export class WebPushService {
  private readonly logger = new Logger(WebPushService.name);
  private running = false;
  constructor(private readonly db: DataSource) {}

  configuration() {
    const publicKey = process.env.WEB_PUSH_PUBLIC_KEY;
    const enabled = !!(
      publicKey &&
      process.env.WEB_PUSH_PRIVATE_KEY &&
      process.env.WEB_PUSH_CONTACT
    );
    return { enabled, publicKey: enabled ? publicKey : null };
  }

  async subscribe(parentId: string, body: any) {
    if (!this.configuration().enabled)
      throw new ServiceUnavailableException('Web push is not configured');
    const subscription = validatePushSubscription(body);
    const rows = await this.db.query(
      `INSERT INTO parent_push_subscriptions(parent_id, endpoint, p256dh, auth, language)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT(endpoint) DO UPDATE
      SET p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, language=EXCLUDED.language
      WHERE parent_push_subscriptions.parent_id=EXCLUDED.parent_id RETURNING id`,
      [
        parentId,
        subscription.endpoint,
        subscription.p256dh,
        subscription.auth,
        subscription.language,
      ],
    );
    if (!rows.length)
      throw new ForbiddenException('Subscription belongs to another account');
    return { enabled: true };
  }

  async unsubscribe(parentId: string, endpoint: string) {
    if (typeof endpoint !== 'string' || endpoint.length > 4096)
      throw new BadRequestException('Invalid endpoint');
    await this.db.query(
      'DELETE FROM parent_push_subscriptions WHERE parent_id=$1 AND endpoint=$2',
      [parentId, endpoint],
    );
    return { enabled: false };
  }

  @Interval(5000)
  async dispatch() {
    if (this.running || !this.configuration().enabled) return;
    this.running = true;
    const runner = this.db.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      locked = (
        await runner.query(
          "SELECT pg_try_advisory_lock(hashtext('parent-web-push-dispatch')) AS locked",
        )
      )[0]?.locked;
      if (!locked) return;
      const rows =
        await runner.query(`SELECT s.id AS subscription_id,s.endpoint,s.p256dh,s.auth,s.language,
        n.id,n.title,n.message,n.metadata,n.student_id
        FROM parent_push_subscriptions s JOIN notifications n ON n.parent_id=s.parent_id
        LEFT JOIN parent_push_deliveries d ON d.subscription_id=s.id AND d.notification_id=n.id
        WHERE n.created_at >= s.created_at AND n.is_deleted=false AND n.seen=0
          AND (d.notification_id IS NULL OR (d.delivered_at IS NULL AND d.attempts < 5 AND d.retry_at <= now()))
        ORDER BY n.created_at LIMIT 20`);
      for (const row of rows) {
        try {
          await webPush.sendNotification(
            {
              endpoint: row.endpoint,
              keys: { p256dh: row.p256dh, auth: row.auth },
            },
            JSON.stringify(pushMessage(row, row.language)),
            {
              TTL: 86400,
              timeout: 5000,
              vapidDetails: {
                subject: process.env.WEB_PUSH_CONTACT!,
                publicKey: process.env.WEB_PUSH_PUBLIC_KEY!,
                privateKey: process.env.WEB_PUSH_PRIVATE_KEY!,
              },
            },
          );
          await runner.query(
            `INSERT INTO parent_push_deliveries(subscription_id,notification_id,attempts,delivered_at)
            VALUES($1,$2,1,now()) ON CONFLICT(subscription_id,notification_id) DO UPDATE SET delivered_at=now(),attempts=parent_push_deliveries.attempts+1`,
            [row.subscription_id, row.id],
          );
        } catch (error) {
          const status = Number((error as any)?.statusCode);
          if (status === 404 || status === 410) {
            await runner.query(
              'DELETE FROM parent_push_subscriptions WHERE id=$1',
              [row.subscription_id],
            );
          } else {
            await runner.query(
              `INSERT INTO parent_push_deliveries(subscription_id,notification_id,attempts,retry_at)
              VALUES($1,$2,1,now()+interval '30 seconds') ON CONFLICT(subscription_id,notification_id)
              DO UPDATE SET attempts=parent_push_deliveries.attempts+1,retry_at=now()+interval '2 minutes'`,
              [row.subscription_id, row.id],
            );
          }
        }
      }
    } catch {
      this.logger.warn('Web push delivery deferred; retrying later');
    } finally {
      try {
        if (locked)
          await runner.query(
            "SELECT pg_advisory_unlock(hashtext('parent-web-push-dispatch'))",
          );
      } finally {
        await runner.release();
        this.running = false;
      }
    }
  }
}
