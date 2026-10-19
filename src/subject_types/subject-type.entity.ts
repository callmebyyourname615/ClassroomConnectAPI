import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { Lesson } from '../lesson/lesson.entity';

@Entity('subject_types') // ← Better table name (plural)
export class SubjectType {
  @PrimaryGeneratedColumn('uuid') // ← Changed to uuid for consistency with other entities
  id: string;

  @Column({ length: 150, nullable: false, unique: true })
  name: string;

  @Column({ type: 'jsonb', nullable: true })
  name_translations: { la: string; en: string | null } | null;

  @Column({ default: true })
  is_active: boolean;

  @Column({ default: false })
  is_deleted: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  // Inverse relation
  @OneToMany(() => Lesson, (lesson) => lesson.subjectType)
  lessons: Lesson[];
}
