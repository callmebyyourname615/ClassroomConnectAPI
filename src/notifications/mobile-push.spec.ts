import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MobilePushController } from './mobile-push.controller';
import {
  MobilePushService,
  mobileMessage,
  validateMobileDevice,
} from './mobile-push.service';
const send = jest.fn();
jest.mock('firebase-admin/app', () => ({
  applicationDefault: jest.fn(),
  getApps: () => [{ name: 'alpha-mobile-push' }],
  initializeApp: jest.fn(),
}));
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: () => ({ send }),
}));
const device = {
  deviceId: '12345678-1234-4123-8123-123456789abc',
  token: 'a'.repeat(100),
  platform: 'android',
  language: 'lo',
};
const row = {
  id: 'notification-1',
  device_row_id: 'device-row',
  token: device.token,
  language: 'en',
  student_id: 'student-1',
  metadata: {
    type: 'evaluation_score',
    studentName: 'Student',
    subjectName: 'Math',
    assessmentTitle: 'Addition',
    score: 0,
    maxScore: 4,
    exerciseTitles: ['SECRET EXERCISE'],
  },
};
describe('Mobile Push', () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env.MOBILE_PUSH_ENABLED = 'true';
    process.env.FIREBASE_PROJECT_ID = 'test-project';
    send.mockReset();
  });
  afterAll(() => {
    process.env = original;
  });
  it('validates platform, device ID, token and locale', () => {
    expect(validateMobileDevice(device)).toEqual(device);
    for (const change of [
      { platform: 'web' },
      { deviceId: 'bad' },
      { token: 'bad' },
      { language: 'th' },
      { token: 'x '.repeat(50) },
    ])
      expect(() => validateMobileDevice({ ...device, ...change })).toThrow(
        BadRequestException,
      );
  });
  it('builds a native alert with student/subject/assessment/zero score, no exercise detail', () => {
    const message = mobileMessage(row);
    expect(message.notification?.body).toContain('Score: 0 / 4');
    expect(JSON.stringify(message)).not.toContain('SECRET');
    expect(message.android?.notification?.channelId).toBe(
      'alpha_school_updates_v1',
    );
    expect(message.apns?.headers?.['apns-push-type']).toBe('alert');
    expect(message.data?.studentId).toBe('student-1');
    expect(mobileMessage({ ...row, language: 'lo' }).notification?.title).toBe(
      'ຜົນການປະເມີນໃໝ່',
    );
  });
  it('creates localized attendance alerts', () => {
    const message = mobileMessage({
      ...row,
      language: 'lo',
      metadata: {
        type: 'attendance',
        event: 'check_out',
        studentName: 'Child',
        status: 'LATE',
        attendanceDate: '2026-10-10',
        checkOut: '16:00',
      },
    });
    expect(message.notification?.title).toBe('ອອກຈາກໂຮງຮຽນແລ້ວ');
    expect(message.notification?.body).toContain('16:00');
    expect(message.notification?.body).toContain('ມາຊ້າ');
  });
  it('requires parent identity and never takes recipient identity from request body', async () => {
    const push = {
      register: jest.fn(),
      unregister: jest.fn(),
      configuration: jest.fn(),
    };
    const c = new MobilePushController(push as any);
    expect(() =>
      c.register({ user: { sub: 'admin', user_type: 'admin' } }, device),
    ).toThrow(ForbiddenException);
    c.register(
      { user: { sub: 'parent', user_type: 'parent' } },
      { ...device, parentId: 'someone-else' },
    );
    expect(push.register).toHaveBeenCalledWith('parent', expect.any(Object));
  });
  it('rejects token reuse by another parent and scopes logout revocation', async () => {
    const db = {
      query: jest
        .fn()
        .mockRejectedValueOnce({ code: '23505' })
        .mockResolvedValueOnce([]),
    };
    const service = new MobilePushService(db as any);
    await expect(service.register('parent', device)).rejects.toThrow(
      ForbiddenException,
    );
    await service.unregister('parent', device.deviceId);
    expect(db.query.mock.calls[1][0]).toContain(
      'WHERE parent_id=$1 AND device_id=$2',
    );
    expect(db.query.mock.calls[1][1]).toEqual(['parent', device.deviceId]);
  });
  function runner() {
    return {
      connect: jest.fn(),
      release: jest.fn(),
      query: jest.fn(async (sql: string) =>
        sql.includes('pg_try')
          ? [{ locked: true }]
          : sql.includes('SELECT s.id')
            ? [row]
            : [],
      ),
    };
  }
  it('sends committed unread parent notifications once and records delivery', async () => {
    const r = runner();
    send.mockResolvedValue('fcm-message');
    await new MobilePushService({
      createQueryRunner: () => r,
    } as any).dispatch();
    expect(send).toHaveBeenCalledTimes(1);
    expect(r.query).toHaveBeenCalledWith(
      expect.stringContaining('n.parent_id=s.parent_id'),
    );
    expect(r.query).toHaveBeenCalledWith(
      expect.stringContaining('n.created_at>=s.created_at'),
    );
    expect(r.query).toHaveBeenCalledWith(
      expect.stringContaining('delivered_at=now()'),
      ['device-row', 'notification-1'],
    );
    expect(r.release).toHaveBeenCalled();
  });
  it('removes unregistered tokens and retries transient delivery failures', async () => {
    const r = runner();
    send.mockRejectedValueOnce({
      code: 'messaging/registration-token-not-registered',
    });
    await new MobilePushService({
      createQueryRunner: () => r,
    } as any).dispatch();
    expect(r.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM parent_mobile_devices'),
      ['device-row', device.token],
    );
    const r2 = runner();
    send.mockRejectedValueOnce({ code: 'messaging/server-unavailable' });
    await new MobilePushService({
      createQueryRunner: () => r2,
    } as any).dispatch();
    expect(r2.query).toHaveBeenCalledWith(
      expect.stringContaining("interval '30 seconds'"),
      ['device-row', 'notification-1'],
    );
  });
  it('keeps mobile Push disabled without configuration', async () => {
    delete process.env.FIREBASE_PROJECT_ID;
    const db = { createQueryRunner: jest.fn() };
    const service = new MobilePushService(db as any);
    await service.dispatch();
    expect(db.createQueryRunner).not.toHaveBeenCalled();
    await expect(service.register('parent', device)).rejects.toThrow(
      'not configured',
    );
  });
});
