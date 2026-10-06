import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { Lesson } from '../lesson/lesson.entity';
import { Evaluation } from '../evaluations/evaluation.entity';

@Entity('subject_evaluations')
export class SubjectEvaluation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // =========================
  // FK: Lesson
  // =========================
  @Column('uuid', { name: 'lesson_id' })
  lessonId: string;

  @ManyToOne(() => Lesson, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'lesson_id' })
  lesson: Lesson;

  // =========================
  // FIELDS
  // =========================
  @Column()
  topic: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'jsonb', default: [] })
  contents: {
    maxScore?: number;
    t_title: string;
    t_page: string;
    e_title?: string[];
    e_page?: string[];
  }[];

  // =========================
  // TIMESTAMPS
  // =========================
  @CreateDateColumn()
  create_at: Date;

  @UpdateDateColumn()
  update_at: Date;

  // =========================
  // RELATIONS
  // =========================
  @OneToMany(() => Evaluation, (evaluation) => evaluation.subjectEvaluation)
  evaluations: Evaluation[];
}
