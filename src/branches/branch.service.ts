import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';

import { Branch } from './branch.entity';
import { Subject } from '../subjects/subject.entity';

import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';

import * as fs from 'fs';
import { AcademicYear } from '../academic_years/academic-year.entity';
import { CacheService } from '../common/cache.service';
import { parseBilingualName } from '../common/bilingual-name';

@Injectable()
export class BranchService {
  constructor(
    @InjectRepository(Branch)
    private readonly branchRepo: Repository<Branch>,

    @InjectRepository(Subject)
    private readonly subjectRepo: Repository<Subject>,

    private readonly cache: CacheService,
  ) {}

  private readonly branchSubjectRelations = [
    'subjects',
    'subjects.lessons',
    'subjects.lessons.subjectType',
  ] as const;

  private getLessonTimestamp(
    lesson:
      | {
          updatedAt?: Date;
          createdAt?: Date;
        }
      | null
      | undefined,
  ): number {
    const parsed = new Date(
      lesson?.updatedAt || lesson?.createdAt || 0,
    ).getTime();

    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private hasVisibleSubjectType(subject: Subject | null | undefined): boolean {
    const lessons = Array.isArray(subject?.lessons) ? [...subject.lessons] : [];

    lessons.sort(
      (left, right) =>
        this.getLessonTimestamp(right) - this.getLessonTimestamp(left),
    );

    return lessons.some((lesson) => {
      const subjectType = lesson?.subjectType as
        | { name?: string; is_deleted?: boolean }
        | undefined;
      const name = String(subjectType?.name || '').trim();

      return (
        !!name &&
        name !== 'Untitled Subject' &&
        subjectType?.is_deleted !== true
      );
    });
  }

  private filterBranchSubjects(branch: Branch): Branch {
    branch.subjects = Array.isArray(branch.subjects)
      ? branch.subjects.filter(
          (subject) =>
            subject?.is_deleted !== true && this.hasVisibleSubjectType(subject),
        )
      : [];

    return branch;
  }

  async create(
    dto: CreateBranchDto,
    file?: Express.Multer.File,
  ): Promise<Branch> {
    const translations = dto.name ? this.translations(dto.name) : null;
    // 1️⃣ parse subjects
    let subjectIds: string[] = [];
    if (dto.subjects) {
      const raw =
        typeof dto.subjects === 'string'
          ? JSON.parse(dto.subjects)
          : dto.subjects;
      if (Array.isArray(raw)) {
        subjectIds = raw.map((s: any) => (typeof s === 'string' ? s : s.id));
      }
    }

    // 2️⃣ check if branch_id exists in active rows
    const activeById = await this.branchRepo.findOne({
      where: { branch_id: dto.branch_id, is_deleted: false },
    });
    if (activeById) {
      throw new Error(`Branch ID "${dto.branch_id}" already exists`);
    }

    // 3️⃣ check if branch_no exists in active rows
    const activeByNo = await this.branchRepo.findOne({
      where: { branch_no: dto.branch_no, is_deleted: false },
    });
    if (activeByNo) {
      throw new Error(`Branch number "${dto.branch_no}" already exists`);
    }

    // 4️⃣ check if branch_id or branch_no exists in deleted row
    let branch = await this.branchRepo.findOne({
      where: [
        { branch_id: dto.branch_id, is_deleted: true },
        { branch_no: dto.branch_no, is_deleted: true },
      ],
      relations: ['subjects'],
    });

    if (branch) {
      // reuse deleted branch
      branch.is_deleted = false;
      branch.branch_id = dto.branch_id;
      branch.branch_no = dto.branch_no;
      branch.name = dto.name ?? '';
      branch.branch_map = dto.branch_map ?? null;
      branch.branch_fb = dto.branch_fb ?? null;
      branch.branch_website = dto.branch_website ?? null;

      branch.contact = dto.contact ?? '';
      branch.phone = dto.phone ?? '';
      branch.address =
        typeof dto.address === 'string'
          ? JSON.parse(dto.address)
          : (dto.address ?? {});
    } else {
      // create new branch
      branch = this.branchRepo.create({
        branch_id: dto.branch_id,
        branch_no: dto.branch_no,
      });
      branch.name = dto.name ?? '';
      branch.branch_map = dto.branch_map ?? null;
      branch.branch_fb = dto.branch_fb ?? null;
      branch.branch_website = dto.branch_website ?? null;
      branch.contact = dto.contact ?? '';
      branch.phone = dto.phone ?? '';
      branch.address =
        typeof dto.address === 'string'
          ? JSON.parse(dto.address)
          : (dto.address ?? {});
    }

    branch.name_translations = translations;

    // 5️⃣ assign subjects
    if (subjectIds.length > 0) {
      const subjects = await this.subjectRepo.find({
        where: { id: In(subjectIds) },
      });
      branch.subjects = subjects;
    }

    // 6️⃣ handle profile picture
    if (file) {
      if (branch.profile_pic) {
        const oldPath = '.' + branch.profile_pic;
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      branch.profile_pic = `/uploads/branches/${file.filename}`;
    }

    // 7️⃣ save branch
    const saved = await this.branchRepo.save(branch);
    await this.clearBranchCache(saved.id);
    return saved;
  }
  async findAll(): Promise<Branch[]> {
    return this.cache.getOrSet('branches:all', 900, async () => {
      const branches = await this.branchRepo.find({
        where: { is_deleted: false },
        relations: [...this.branchSubjectRelations],
        order: { created_at: 'DESC' },
      });

      return branches.map((branch) => this.filterBranchSubjects(branch));
    });
  }

  async findOne(id: string): Promise<Branch> {
    return this.cache.getOrSet(`branches:${id}`, 900, async () => {
      return this.findOneUncached(id);
    });
  }

  private async findOneUncached(id: string): Promise<Branch> {
    const branch = await this.branchRepo
      .createQueryBuilder('branch')
      .leftJoinAndSelect('branch.subjects', 'subject')
      .leftJoinAndSelect('subject.lessons', 'lesson')
      .leftJoinAndSelect('lesson.subjectType', 'lessonSubjectType')
      .leftJoinAndMapOne(
        'branch.academic_year',
        AcademicYear,
        'academic_year',
        'academic_year.branch_id = branch.id AND academic_year.is_active = true AND academic_year.is_deleted = false',
      )
      .where('branch.id = :id', { id })
      .getOne();

    if (!branch) throw new NotFoundException('Branch not found');
    return this.filterBranchSubjects(branch);
  }

  async update(
    id: string,
    dto: UpdateBranchDto,
    file?: Express.Multer.File,
  ): Promise<Branch> {
    const translations = dto.name ? this.translations(dto.name) : undefined;
    const branch = await this.findOneUncached(id);

    // ✅ Only assign safe fields, not subjects or address directly
    if (dto.branch_id) branch.branch_id = dto.branch_id;
    if (dto.branch_no) branch.branch_no = dto.branch_no;
    if (dto.branch_map) branch.branch_map = dto.branch_map;
    if (dto.branch_fb) branch.branch_fb = dto.branch_fb;
    if (dto.branch_website) branch.branch_website = dto.branch_website;
    if (dto.name) {
      branch.name = dto.name;
      branch.name_translations = translations!;
    }
    if (dto.contact) branch.contact = dto.contact;
    if (dto.phone) branch.phone = dto.phone;

    // ✅ Parse address if it came as string from FormData
    if (dto.address) {
      branch.address =
        typeof dto.address === 'string' ? JSON.parse(dto.address) : dto.address;
    }

    // ✅ Parse subjects — handles both string (FormData) and array
    if (dto.subjects) {
      let subjectIds: string[] = [];

      const raw =
        typeof dto.subjects === 'string'
          ? JSON.parse(dto.subjects)
          : dto.subjects;

      if (Array.isArray(raw)) {
        subjectIds = raw.map((s: string | { id: string }) => {
          if (typeof s === 'string') return s;
          if (typeof s === 'object' && s.id) return s.id;
          throw new Error('Invalid subject format');
        });
      }

      if (subjectIds.length > 0) {
        const subjects = await this.subjectRepo.find({
          where: { id: In(subjectIds) },
        });
        branch.subjects = subjects;
      }
    }

    // ✅ Replace profile image
    if (file) {
      if (branch.profile_pic) {
        const oldPath = '.' + branch.profile_pic;
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      branch.profile_pic = `/uploads/branches/${file.filename}`;
    }

    const saved = await this.branchRepo.save(branch);
    await this.clearBranchCache(id);
    return saved;
  }
  async remove(id: string): Promise<{ message: string }> {
    const result = await this.branchRepo.update(
      { id, is_deleted: false },
      { is_deleted: true },
    );

    if (result.affected === 0) {
      throw new NotFoundException('Branch not found or already deleted');
    }

    await this.clearBranchCache(id);
    return { message: 'Branch deleted successfully' };
  }

  private async clearBranchCache(id?: string): Promise<void> {
    await this.cache.del('branches:all');
    if (id) await this.cache.del(`branches:${id}`);
  }

  private translations(name: string) {
    if (typeof name !== 'string' || name.length > 255) {
      throw new BadRequestException(
        'Name must be a string of at most 255 characters',
      );
    }
    try {
      return parseBilingualName(name);
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }
}
