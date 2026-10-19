import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Student } from '../students/student.entity';
import { Parent } from '../parents/parent.entity';
import { Branch } from '../branches/branch.entity';
import { AcademicYear } from '../academic_years/academic-year.entity';
import { Admin } from '../admins/admin.entity';

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  title: string;

  @Column({ nullable: true })
  description: string;

  @Column({ type: 'text', nullable: true })
  message: string;

  // -------------------------
  // BRANCH FK
  // -------------------------
  @Column({ type: 'uuid', nullable: true })
  branch_id: string;

  @ManyToOne(() => Branch, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'branch_id' })
  branch: Branch;

  // -------------------------
  // Academic Year FK
  // -------------------------
  @Column({ type: 'uuid', nullable: true })
  academic_year_id: string;

  @ManyToOne(() => AcademicYear, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'academic_year_id' })
  academic_year: AcademicYear;

  // -------------------------
  // Student FK (for task notifications)
  // -------------------------
  @Column({ type: 'uuid', nullable: true })
  student_id: string;

  @ManyToOne(() => Student, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'student_id' })
  student: Student;

  // -------------------------
  // Parent FK (for task notifications)
  // -------------------------
  @Column({ type: 'uuid', nullable: true })
  parent_id: string;

  @ManyToOne(() => Parent, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'parent_id' })
  parent: Parent;

  // -------------------------
  // Admin FK (for admin/checker notifications)
  // -------------------------
  @Column({ type: 'uuid', nullable: true })
  admin_id: string;

  @ManyToOne(() => Admin, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'admin_id' })
  admin: Admin;

  // -------------------------
  // Module reference (optional, e.g. task_id)
  // -------------------------
  @Column({ type: 'uuid', nullable: true })
  module_id: string;

  @Column({ length: 50, nullable: true })
  module_type: string; // TASK, EVENT, etc.

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'smallint', default: 1 })
  target_type: number;

  @Column({ type: 'smallint', default: 1 })
  target: number;

  @Column({ type: 'smallint', default: 0 })
  seen: number;

  @Column({ type: 'smallint', default: 0 })
  clicked: number;

  @Column({ default: false })
  is_deleted: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
