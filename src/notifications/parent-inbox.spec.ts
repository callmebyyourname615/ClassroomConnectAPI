import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

describe('Parent inbox ownership', () => {
  it('uses the authenticated parent and rejects an admin session', () => {
    const service: any = { findParentInbox: jest.fn() };
    const controller = new NotificationsController(service);
    controller.inbox({ user: { sub: 'parent-a', user_type: 'parent' } });
    expect(service.findParentInbox).toHaveBeenCalledWith('parent-a');
    expect(() =>
      controller.inbox({ user: { sub: 'admin', user_type: 'admin' } }),
    ).toThrow('Parent account required');
  });
  it('cannot mark another parent notification as read', async () => {
    const repo: any = { findOne: jest.fn(async () => null), save: jest.fn() };
    const service = new NotificationsService(
      repo,
      {} as any,
      {} as any,
      {} as any,
    );
    await expect(
      service.setParentRead('notification-b', 'parent-a', true),
    ).rejects.toThrow('Notification not found');
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { id: 'notification-b', parent_id: 'parent-a', is_deleted: false },
    });
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe('Legacy notification route isolation', () => {
  it('does not expose unscoped legacy lists to a parent', () => {
    const service: any = { findAll: jest.fn() };
    const controller = new NotificationsController(service);
    expect(() =>
      controller.findAll({ user: { sub: 'parent-a', user_type: 'parent' } }),
    ).toThrow('Use the parent inbox endpoint');
    expect(service.findAll).not.toHaveBeenCalled();
    controller.findAll({ user: { sub: 'admin', user_type: 'admin' } });
    expect(service.findAll).toHaveBeenCalledTimes(1);
  });
});

describe('Parent inbox sender', () => {
  it('returns current bilingual names for old notifications without exposing relation details', async () => {
    const source: any = {
      id: 'old',
      student_id: 'child',
      metadata: {
        type: 'task',
        studentName: 'Old snapshot',
        taskTitle: 'Task',
      },
      branch: {
        name: 'ສາຂາ(New School)',
        name_translations: { la: 'ສາຂາ', en: 'New School' },
        phone: 'private',
      },
      student: {
        first_name_lao: 'ມະນີ',
        last_name_lao: 'ສຸລິວົງ',
        first_name_eng: 'Manee',
        last_name_eng: 'Soulivong',
        emergency_contacts: ['private'],
      },
    };
    const repo: any = { find: jest.fn(async () => [source]) };
    const service = new NotificationsService(
      repo,
      {} as any,
      {} as any,
      {} as any,
    );
    const [entry] = await service.findParentInbox('parent-a');
    expect(entry.sender_translations).toEqual({ la: 'ສາຂາ', en: 'New School' });
    expect(entry.metadata).toEqual({
      type: 'task',
      studentName: 'Old snapshot',
      taskTitle: 'Task',
      studentNameTranslations: { la: 'ມະນີ ສຸລິວົງ', en: 'Manee Soulivong' },
    });
    expect(entry).not.toHaveProperty('student');
    expect(entry).not.toHaveProperty('branch');
    expect(source.metadata).not.toHaveProperty('studentNameTranslations');
    expect(repo.find.mock.calls[0][0].where.parent_id).toBe('parent-a');
  });
  it('uses the stored branch name and does not invent a sender or expose branch details', async () => {
    const repo: any = {
      find: jest.fn(async () => [
        { id: 'one', branch: { name: 'Actual School', phone: 'private' } },
        { id: 'two', branch: null },
      ]),
    };
    const service = new NotificationsService(
      repo,
      {} as any,
      {} as any,
      {} as any,
    );
    const rows = await service.findParentInbox('parent-a');
    expect(rows).toEqual([
      { id: 'one', sender: 'Actual School' },
      { id: 'two', sender: null },
    ]);
    expect(repo.find.mock.calls[0][0].where).toEqual({
      parent_id: 'parent-a',
      is_deleted: false,
    });
  });
});
