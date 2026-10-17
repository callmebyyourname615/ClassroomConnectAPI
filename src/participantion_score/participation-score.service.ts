import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { Notification } from '../notifications/notification.entity';
import { ParticipationScore } from './participation-score.entity';
import { CreateParticipationScoreDto } from './dto/create-participation-score.dto';
import { UpdateParticipationScoreDto } from './dto/update-participation-score.dto';
import { ParticipationList } from '../participantion_list/participation_list.entity';
import { Student } from '../students/student.entity';

interface ScoreResult {
  studentId: string;
  studentName: string;
  participationId: string;
  participationName: string;
  score: number;
}

@Injectable()
export class ParticipationScoreService {
  constructor(
    @InjectRepository(ParticipationScore)
    private readonly repo: Repository<ParticipationScore>,

    @InjectRepository(Student)
    private readonly studentRepo: Repository<Student>,

    @InjectRepository(ParticipationList)
    private readonly participationRepo: Repository<ParticipationList>,
  ) {}

  /* ================= HELPER ================= */
  private normalizeDate(date: Date | string): string {
    if (date instanceof Date) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    return String(date).slice(0, 10);
  }

  private requireScores(
    dto: CreateParticipationScoreDto | UpdateParticipationScoreDto,
  ) {
    if (!Array.isArray(dto.scores) || dto.scores.length === 0) {
      throw new BadRequestException('No participation scores provided');
    }
    return dto.scores;
  }

  private async saveDaily(
    dto: CreateParticipationScoreDto | UpdateParticipationScoreDto,
    id?: string,
    merge = false,
  ) {
    return this.repo.manager.transaction(async (manager) => {
      const repository = manager.getRepository(ParticipationScore);
      let prior = id ? await repository.findOne({ where: { id } }) : null;
      if (id && !prior)
        throw new NotFoundException('Participation score not found');
      const scope = {
        branchId: dto.branchId ?? prior?.branchId,
        academicYearId: dto.academicYearId ?? prior?.academicYearId,
        levelId: dto.levelId ?? prior?.levelId,
        classId: dto.classId ?? prior?.classId,
        date: dto.date
          ? this.normalizeDate(dto.date)
          : prior?.date ||
            new Intl.DateTimeFormat('en-CA', {
              timeZone: 'Asia/Vientiane',
            }).format(new Date()),
      };
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `daily-evaluation:${scope.branchId}:${scope.academicYearId}:${scope.levelId}:${scope.classId}:${scope.date}`,
      ]);
      prior = await repository.findOne({ where: id ? { id } : scope });
      if (id && !prior)
        throw new NotFoundException('Participation score not found');
      const oldScores = (prior?.scores || []).map((item) => ({ ...item }));
      const sameDay =
        prior?.date === scope.date &&
        (prior?.classId ?? null) === (scope.classId ?? null) &&
        (prior?.academicYearId ?? null) === (scope.academicYearId ?? null) &&
        (prior?.levelId ?? null) === (scope.levelId ?? null) &&
        (prior?.branchId ?? null) === (scope.branchId ?? null);
      let nextScores = merge
        ? oldScores.map((item) => ({ ...item }))
        : oldScores;
      if (dto.scores !== undefined || !prior) {
        const input = this.requireScores(dto);
        const definitions = await manager
          .getRepository(ParticipationList)
          .findBy({
            id: In([...new Set(input.map((item) => item.participationId))]),
          });
        const byId = new Map(definitions.map((item) => [item.id, item]));
        if (!merge) nextScores = [];
        for (const item of input) {
          const definition = byId.get(item.participationId);
          if (!definition)
            throw new BadRequestException('Unknown daily assessment criterion');
          if (!Number.isFinite(item.score) || item.score < 0)
            throw new BadRequestException('Invalid daily assessment score');
          const maximum =
            definition.score == null || definition.score === ''
              ? null
              : Number(definition.score);
          if (
            maximum != null &&
            Number.isFinite(maximum) &&
            item.score > maximum
          )
            throw new BadRequestException(
              'Daily assessment score exceeds maximum',
            );
          const entry = {
            studentId: item.studentId,
            participationId: item.participationId,
            participationName: definition.name,
            score: item.score,
          };
          const index = nextScores.findIndex(
            (old) =>
              old.studentId === item.studentId &&
              old.participationId === item.participationId,
          );
          if (index < 0) nextScores.push(entry);
          else nextScores[index] = entry;
        }
      }
      const changedStudents = new Set(
        nextScores
          .filter(
            (item) =>
              !sameDay ||
              !oldScores.some(
                (old) =>
                  old.studentId === item.studentId &&
                  old.participationId === item.participationId &&
                  Number(old.score) === Number(item.score),
              ),
          )
          .map((item) => item.studentId),
      );
      const saved = await repository.save(
        repository.create({
          ...prior,
          ...scope,
          addedBy: dto.addedBy ?? prior?.addedBy,
          scores: nextScores,
        }),
      );
      if (changedStudents.size)
        await this.notifyDaily(manager, saved, changedStudents);
      return saved;
    });
  }

  private async notifyDaily(
    manager: EntityManager,
    record: ParticipationScore,
    changed: Set<string>,
  ) {
    const definitions = await manager.getRepository(ParticipationList).findBy({
      id: In([...new Set(record.scores.map((item) => item.participationId))]),
    });
    const byId = new Map(definitions.map((item) => [item.id, item]));
    const students = await manager
      .getRepository(Student)
      .find({ where: { id: In([...changed]) }, relations: ['parents'] });
    if (students.length !== changed.size)
      throw new BadRequestException('Unknown student');
    const notifications = manager.getRepository(Notification);
    for (const student of students) {
      const items = record.scores
        .filter((item) => item.studentId === student.id)
        .map((item) => {
          const raw = byId.get(item.participationId)?.score;
          const maximum = raw == null || raw === '' ? null : Number(raw);
          return {
            criterionId: item.participationId,
            criterionName:
              byId.get(item.participationId)?.name || item.participationName,
            score: item.score,
            maxScore:
              maximum != null && Number.isFinite(maximum) ? maximum : null,
          };
        });
      const studentName = [
        student.first_name_lao || student.first_name_eng,
        student.last_name_lao || student.last_name_eng,
      ]
        .filter(Boolean)
        .join(' ');
      const score = items.reduce((sum, item) => sum + Number(item.score), 0);
      const maxScore = items.every((item) => item.maxScore != null)
        ? items.reduce((sum, item) => sum + Number(item.maxScore), 0)
        : null;
      const parents = [
        ...new Set(
          (student.parents || [])
            .filter((parent) => parent.isActive !== false)
            .map((parent) => parent.id),
        ),
      ];
      if (!parents.length) continue;
      await notifications.save(
        parents.map((parentId) =>
          notifications.create({
            parent_id: parentId,
            student_id: student.id,
            branch_id: record.branchId,
            academic_year_id: record.academicYearId,
            module_type: 'DAILY_EVALUATION',
            module_id: record.id,
            seen: 0,
            clicked: 0,
            title: 'ຜົນການປະເມີນປະຈຳວັນ',
            description: `${studentName} · ${record.date}`.slice(0, 255),
            message: [
              studentName,
              record.date,
              ...items.map(
                (item) =>
                  `${item.criterionName}: ${item.score}${item.maxScore == null ? '' : ` / ${item.maxScore}`}`,
              ),
            ].join('\n'),
            metadata: {
              type: 'daily_evaluation',
              studentId: student.id,
              studentName,
              assessmentDate: record.date,
              participationScoreId: record.id,
              score,
              maxScore,
              items,
            },
          }),
        ),
      );
    }
  }

  async create(dto: CreateParticipationScoreDto) {
    return this.saveDaily(dto);
  }

  /* ================= GET ALL ================= */
  async findAll() {
    return this.repo.find({ order: { created_at: 'DESC' } });
  }

  /* ================= GET BY ID ================= */
  async findOne(id: string) {
    const record = await this.repo.findOne({ where: { id } });
    if (!record) throw new NotFoundException('Participation score not found');
    return record;
  }

  /* ================= UPDATE ================= */
  async update(id: string, dto: UpdateParticipationScoreDto) {
    return this.saveDaily(dto, id);
  }

  /* ================= DELETE ================= */
  async remove(id: string) {
    const record = await this.repo.findOne({ where: { id } });
    if (!record) throw new NotFoundException('Participation score not found');
    await this.repo.remove(record);
    return { message: 'Deleted successfully' };
  }

  /* ================= BULK UPSERT ================= */
  async bulkUpsert(dto: CreateParticipationScoreDto) {
    return this.saveDaily(dto, undefined, true);
  }

  /* ================= GET SCORES BY FILTER ================= */
  async getScoresByFilter(filter: {
    branchId: string;
    academicYearId: string;
    levelId: string; // ← added
    classId: string;
    date: Date | string;
  }): Promise<ScoreResult[]> {
    const targetDate = this.normalizeDate(filter.date);

    const scoreRecord = await this.repo.findOne({
      where: {
        branchId: filter.branchId,
        academicYearId: filter.academicYearId,
        levelId: filter.levelId, // ← added
        classId: filter.classId,
        date: targetDate,
      },
    });

    // students in the selected class
    const students = await this.studentRepo.find({
      where: { enrollments: { class: { id: filter.classId } } },
      select: [
        'id',
        'first_name_lao',
        'last_name_lao',
        'first_name_eng',
        'last_name_eng',
      ],
      order: {
        first_name_lao: 'ASC',
        last_name_lao: 'ASC',
        first_name_eng: 'ASC',
        last_name_eng: 'ASC',
      },
    });

    // participation lists that belong to the selected level only ← key fix
    const activities = await this.participationRepo
      .createQueryBuilder('list')
      .innerJoin('list.levels', 'level')
      .where('level.id = :levelId', { levelId: filter.levelId })
      .select(['list.id', 'list.name'])
      .getMany();

    const result: ScoreResult[] = [];

    for (const student of students) {
      for (const activity of activities) {
        const existing = scoreRecord?.scores?.find(
          (s) =>
            s.studentId === student.id && s.participationId === activity.id,
        );

        result.push({
          studentId: student.id,
          studentName:
            `${student.first_name_lao || ''} ${student.last_name_lao || ''} (${student.first_name_eng || ''} ${student.last_name_eng || ''})`.trim(),
          participationId: activity.id,
          participationName: activity.name || 'Unknown',
          score: existing?.score ?? 0,
        });
      }
    }

    return result;
  }
}
