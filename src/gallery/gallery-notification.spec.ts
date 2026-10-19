import { notifyGallery } from './gallery-notification';
import { GalleryService } from './gallery.service';
import { Parent } from '../parents/parent.entity';
import { Student } from '../students/student.entity';
import { Admin } from '../admins/admin.entity';
import { GalleryStudentTag } from './gallery-student-tag.entity';
import { Notification } from '../notifications/notification.entity';
import { pushMessage } from '../notifications/web-push.service';

function fixture() {
  const parent: any = {
    id: 'parent',
    branchId: 'branch',
    isActive: true,
    isDeleted: false,
    approvalStatus: 'approved',
  };
  const student: any = {
    id: 'student',
    branchId: 'branch',
    is_active: true,
    first_name_eng: 'Child',
    parents: [parent],
  };
  const post: any = {
    id: 'post',
    title: 'School day',
    description: 'Photos',
    category: 'Activity',
    visibility: 'public',
    status: 'published',
    author_id: 'author',
    author_type: 'admin',
  };
  const inbox = {
    find: jest.fn(async () => [] as any[]),
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => x),
    update: jest.fn(),
  };
  const parents = { find: jest.fn(async () => [parent]) };
  const students = {
    find: jest.fn(async () => [student]),
    count: jest.fn(async () => 1),
  };
  const tags = {
    find: jest.fn(async () => [{ student_id: 'student' }]),
    delete: jest.fn(),
    create: jest.fn((x) => x),
    save: jest.fn(),
  };
  const files = {
    find: jest.fn(async () => [{ id: 'file', file_path: 'photo.jpg' }]),
    count: jest.fn(async () => 1),
  };
  const photos = {
    delete: jest.fn(),
    create: jest.fn((x) => x),
    save: jest.fn(),
  };
  const admins = {
    findOne: jest.fn(async () => ({ branch: { id: 'branch' } })),
  };
  const manager: any = {
    getRepository: (type) =>
      type === Notification
        ? inbox
        : type === Parent
          ? parents
          : type === Student
            ? students
            : type === GalleryStudentTag
              ? tags
              : type === Admin
                ? admins
                : photos,
    save: jest.fn(async (_, data) => ({ id: 'post', ...data })),
    findOne: jest.fn(async () => ({ ...post })),
  };
  const transaction = jest.fn(async (cb) => cb(manager));
  const posts: any = { create: (x) => x, manager: { transaction } };
  // Photo replacement also uses File, so resolve that repository explicitly.
  const repository = manager.getRepository;
  manager.getRepository = (type) =>
    type.name === 'File' ? files : repository(type);
  const cache: any = { del: jest.fn(), delPattern: jest.fn() };
  const service = new GalleryService(
    posts,
    photos as any,
    tags as any,
    {} as any,
    {} as any,
    files as any,
    students as any,
    parents as any,
    admins as any,
    cache,
  );
  jest.spyOn(service, 'findOne').mockImplementation(async () => post);
  return {
    post,
    parent,
    student,
    inbox,
    parents,
    students,
    tags,
    manager,
    service,
    transaction,
  };
}

test('public publication notifies branch parents once without a child filter', async () => {
  const f = fixture();
  await notifyGallery(f.manager, f.post);
  expect(f.parents.find).toHaveBeenCalledWith({
    where: {
      branchId: 'branch',
      isActive: true,
      isDeleted: false,
      approvalStatus: 'approved',
    },
  });
  expect(f.inbox.save.mock.calls[0][0]).toMatchObject([
    {
      parent_id: 'parent',
      module_type: 'GALLERY',
      metadata: { visibility: 'public', galleryId: 'post' },
    },
  ]);
  expect(f.inbox.save.mock.calls[0][0][0].student_id).toBeUndefined();
  f.inbox.find.mockResolvedValue([
    { id: 'notice', parent_id: 'parent', student_id: null },
  ]);
  f.inbox.save.mockClear();
  await notifyGallery(f.manager, f.post);
  expect(f.inbox.save).not.toHaveBeenCalled();
});
test('private publication uses only tagged students and their linked parents', async () => {
  const f = fixture();
  f.post.visibility = 'private';
  f.student.parents.push({ ...f.parent, id: 'second-parent' });
  await notifyGallery(f.manager, f.post);
  const rows = f.inbox.save.mock.calls[0][0];
  expect(rows.map((x) => x.parent_id)).toEqual(['parent', 'second-parent']);
  expect(rows.every((x) => x.student_id === 'student')).toBe(true);
  expect(f.students.find.mock.calls[0][0].where.id._value).toEqual(['student']);
  expect(f.parents.find).not.toHaveBeenCalled();
});
test.each([
  { isActive: false },
  { isDeleted: true },
  { approvalStatus: 'pending' },
  { branchId: 'other' },
])('private publication excludes ineligible parent %j', async (patch) => {
  const f = fixture();
  f.post.visibility = 'private';
  Object.assign(f.parent, patch);
  await notifyGallery(f.manager, f.post);
  expect(f.inbox.save).not.toHaveBeenCalled();
});
test('changing private assignments revokes notices for removed students', async () => {
  const f = fixture();
  f.post.visibility = 'private';
  f.inbox.find.mockResolvedValue([
    { id: 'removed', parent_id: 'other-parent', student_id: 'other-child' },
  ]);
  await notifyGallery(f.manager, f.post);
  expect(f.inbox.update).toHaveBeenCalledWith(
    { id: expect.anything() },
    { is_deleted: true },
  );
  expect(f.inbox.save.mock.calls[0][0][0].parent_id).toBe('parent');
});
test('drafts do not notify and withdraw existing publication notices', async () => {
  const f = fixture();
  f.post.status = 'draft';
  f.inbox.find.mockResolvedValue([{ id: 'notice', parent_id: 'parent' }]);
  await notifyGallery(f.manager, f.post);
  expect(f.parents.find).not.toHaveBeenCalled();
  expect(f.inbox.save).not.toHaveBeenCalled();
  expect(f.inbox.update).toHaveBeenCalled();
});
test('private publish rejects absent, inactive or different branch assignments', async () => {
  const f = fixture();
  f.post.visibility = 'private';
  f.students.find.mockResolvedValue([]);
  await expect(notifyGallery(f.manager, f.post)).rejects.toThrow(
    'students must be active',
  );
  expect(f.inbox.save).not.toHaveBeenCalled();
});
test('gallery create writes photos, tags and notices in one transaction', async () => {
  const f = fixture();
  await f.service.create({ ...f.post, photo_file_ids: ['file'] });
  expect(f.transaction).toHaveBeenCalledTimes(1);
  expect(f.inbox.save).toHaveBeenCalled();
});
test('failed inbox write fails publication', async () => {
  const f = fixture();
  f.inbox.save.mockRejectedValue(new Error('Inbox failed'));
  await expect(
    f.service.update('post', { status: 'published', photo_file_ids: ['file'] }),
  ).rejects.toThrow('Inbox failed');
});
test('gallery push translates publication with post details', () => {
  expect(
    pushMessage(
      {
        metadata: {
          type: 'gallery',
          galleryTitle: 'School day',
          studentName: 'Child',
        },
      },
      'en',
    ),
  ).toMatchObject({ title: 'New gallery post', body: 'Child\nSchool day' });
});
