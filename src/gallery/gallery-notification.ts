import { BadRequestException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { Admin } from '../admins/admin.entity';
import { Parent } from '../parents/parent.entity';
import { Student } from '../students/student.entity';
import { Notification } from '../notifications/notification.entity';
import { GalleryPost } from './gallery-post.entity';
import { GalleryStudentTag } from './gallery-student-tag.entity';

/** Reconcile the publication audience inside the post's write transaction. */
export async function notifyGallery(manager: EntityManager, post: GalleryPost) {
  const inbox = manager.getRepository(Notification);
  const previous = await inbox.find({
    where: { module_id: post.id, module_type: 'GALLERY', is_deleted: false },
  });
  if (post.status !== 'published') {
    if (previous.length)
      await inbox.update(
        { id: In(previous.map((row) => row.id)) },
        { is_deleted: true },
      );
    return;
  }
  if (!post.author_id)
    throw new BadRequestException(
      'Gallery author is required before publishing',
    );
  const author =
    post.author_type?.toLowerCase() === 'parent'
      ? await manager
          .getRepository(Parent)
          .findOne({ where: { id: post.author_id }, relations: ['branch'] })
      : await manager
          .getRepository(Admin)
          .findOne({ where: { id: post.author_id }, relations: ['branch'] });
  const branchId = author?.branch?.id || (author as Parent)?.branchId;
  if (!branchId)
    throw new BadRequestException(
      'Gallery author branch is required before publishing',
    );

  const eligible = (parent: Parent) =>
    parent.isActive &&
    !parent.isDeleted &&
    parent.approvalStatus === 'approved' &&
    (!parent.branchId || parent.branchId === branchId);
  const audience = new Map<string, { parent: Parent; student?: Student }>();
  if (post.visibility === 'public') {
    const parents = await manager
      .getRepository(Parent)
      .find({
        where: {
          branchId,
          isActive: true,
          isDeleted: false,
          approvalStatus: 'approved',
        },
      });
    for (const parent of parents)
      if (eligible(parent)) audience.set(`${parent.id}:`, { parent });
  } else {
    const tags = await manager
      .getRepository(GalleryStudentTag)
      .find({ where: { gallery_id: post.id } });
    if (!tags.length)
      throw new BadRequestException(
        'Private gallery requires assigned students',
      );
    const students = await manager
      .getRepository(Student)
      .find({
        where: {
          id: In(tags.map((tag) => tag.student_id)),
          branchId,
          is_active: true,
        },
        relations: ['parents'],
      });
    if (students.length !== new Set(tags.map((tag) => tag.student_id)).size)
      throw new BadRequestException(
        'Private gallery students must be active in the author branch',
      );
    for (const student of students)
      for (const parent of student.parents || []) {
        if (eligible(parent))
          audience.set(`${parent.id}:${student.id}`, { parent, student });
      }
  }
  const key = (row: Notification) => `${row.parent_id}:${row.student_id || ''}`;
  const revoked = previous.filter((row) => !audience.has(key(row)));
  if (revoked.length)
    await inbox.update(
      { id: In(revoked.map((row) => row.id)) },
      { is_deleted: true },
    );
  const sent = new Set(previous.map(key));
  const pending: Notification[] = [];
  for (const [recipient, { parent, student }] of audience) {
    if (sent.has(recipient)) continue;
    const studentName = student
      ? [
          student.first_name_lao || student.first_name_eng,
          student.last_name_lao || student.last_name_eng,
        ]
          .filter(Boolean)
          .join(' ')
      : '';
    pending.push(
      inbox.create({
        parent_id: parent.id,
        student_id: student?.id,
        branch_id: branchId,
        module_id: post.id,
        module_type: 'GALLERY',
        title: 'ຮູບພາບໃໝ່',
        description: [studentName, post.title]
          .filter(Boolean)
          .join(' · ')
          .slice(0, 255),
        message: [
          studentName,
          post.title,
          post.description,
          post.category,
          post.location,
        ]
          .filter(Boolean)
          .join('\n'),
        metadata: {
          type: 'gallery',
          event: 'published',
          galleryId: post.id,
          galleryTitle: post.title,
          description: post.description || '',
          category: post.category || '',
          location: post.location || '',
          visibility: post.visibility,
          ...(student ? { studentId: student.id, studentName } : {}),
        },
        seen: 0,
        clicked: 0,
      }),
    );
  }
  if (pending.length) await inbox.save(pending);
}
