import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  ManyToMany,
  ManyToOne,
  JoinTable,
  JoinColumn,
} from 'typeorm';

import { Saving } from '../savings/savings.entity';
import { Appointment } from '../appointment/appointment.entity';
import { AppointmentParticipant } from '../appointment/dto/appointment-participant.entity';
import { Subject } from '../subjects/subject.entity';
import { AcademicYear } from '../academic_years/academic-year.entity';
import { Teaching } from '../teachings/teaching.entity';
import { TeacherHomework } from '../teacher-homework/teacher-homework.entity';

@Entity('branches')
export class Branch {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: false, unique: true })
  branch_id: string;

  @Column({ nullable: true, unique: true })
  branch_no: string;

  @Column({ nullable: true })
  name: string;

  @Column({ type: 'jsonb', nullable: true })
  name_translations: { la: string; en: string | null } | null;

  @Column({ type: 'jsonb', nullable: true })
  address: Record<string, any>;

  @Column({ type: 'text', nullable: true })
  branch_map: string | null;

  @Column({ type: 'text', nullable: true })
  branch_fb: string | null;

  @Column({ type: 'text', nullable: true })
  branch_website: string | null;

  @Column({ nullable: true })
  contact: string;

  @Column({ nullable: true })
  phone: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  profile_pic: string | null;

  @Column({ default: true })
  is_active: boolean;

  @Column({ default: false })
  is_deleted: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  // =========================
  // MANY-TO-MANY: Subject
  // =========================
  @ManyToMany(() => Subject, (subject) => subject.branches)
  @JoinTable({
    name: 'branch_subjects',
    joinColumn: {
      name: 'branch_id',
      referencedColumnName: 'id',
    },
    inverseJoinColumn: {
      name: 'subject_id',
      referencedColumnName: 'id',
    },
  })
  subjects: Subject[];

  // =========================
  // RELATIONS
  // =========================
  @OneToMany(() => TeacherHomework, (teacherHomework) => teacherHomework.branch)
  teacherHomeworks: TeacherHomework[];

  @OneToMany(() => Saving, (saving) => saving.branch)
  savings: Saving[];

  @OneToMany(() => Appointment, (a) => a.branch)
  appointments: Appointment[];

  @OneToMany(() => AppointmentParticipant, (ap) => ap.branch)
  appointmentPersons: AppointmentParticipant[];

  @OneToMany(() => AcademicYear, (ay) => ay.branch)
  academic_years: AcademicYear[];

  @OneToMany(() => Teaching, (teaching) => teaching.branch)
  teachings: Teaching[];
}
