import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExaminationResult } from './examination-result.entity';
import { Examination } from '../examination/examination.entity';
import { CreateExaminationResultDto } from './dto/create-examination-result.dto';
import { BulkCreateExaminationResultDto } from './dto/bulk-create-examination-result.dto';
import { UpdateExaminationResultDto } from './dto/update-examination-result.dto';
import { notifyExaminationResults } from './examination-result-notification';

@Injectable()
export class ExaminationResultService {
  constructor(
    @InjectRepository(ExaminationResult)
    private readonly resultRepository: Repository<ExaminationResult>,

    @InjectRepository(Examination)
    private readonly examinationRepository: Repository<Examination>,
  ) {}

  // -------------------------------------------------------
  // Helpers
  // -------------------------------------------------------
  private async getExamination(examinationId: string): Promise<Examination> {
    const exam = await this.examinationRepository.findOne({
      where: { id: examinationId, isDeleted: false },
    });
    if (!exam) {
      throw new NotFoundException(
        `Examination with ID ${examinationId} not found`,
      );
    }
    return exam;
  }

  private async saveAndNotify(
    results: ExaminationResult[],
  ): Promise<ExaminationResult[]> {
    return this.resultRepository.manager.transaction(async (manager) => {
      const saved = await manager
        .getRepository(ExaminationResult)
        .save(results);
      await notifyExaminationResults(manager, saved);
      return saved;
    });
  }

  private calculateIsPassed(score: number, passScore: number): boolean {
    return score >= passScore;
  }

  // -------------------------------------------------------
  // CREATE — single result
  // -------------------------------------------------------
  async create(dto: CreateExaminationResultDto): Promise<ExaminationResult> {
    const exam = await this.getExamination(dto.examinationId);

    if (dto.score > Number(exam.maxScore)) {
      throw new BadRequestException(
        `Score ${dto.score} exceeds max score ${exam.maxScore}`,
      );
    }

    // Prevent duplicate result for same student + exam
    const existing = await this.resultRepository.findOne({
      where: {
        examinationId: dto.examinationId,
        studentId: dto.studentId,
        isDeleted: false,
      },
    });
    if (existing) {
      throw new ConflictException(
        `Result for student ${dto.studentId} in this examination already exists`,
      );
    }

    const isPassed = this.calculateIsPassed(dto.score, Number(exam.passScore));

    const result = this.resultRepository.create({
      ...dto,
      isPassed,
    });

    return (await this.saveAndNotify([result]))[0];
  }

  // -------------------------------------------------------
  // BULK CREATE — teacher submits all student scores at once
  // -------------------------------------------------------
  async bulkCreate(
    dto: BulkCreateExaminationResultDto,
  ): Promise<ExaminationResult[]> {
    const exam = await this.getExamination(dto.examinationId);

    const resultsToSave: ExaminationResult[] = [];

    for (const item of dto.results) {
      if (item.score > Number(exam.maxScore)) {
        throw new BadRequestException(
          `Score ${item.score} for student ${item.studentId} exceeds max score ${exam.maxScore}`,
        );
      }

      const existing = await this.resultRepository.findOne({
        where: {
          examinationId: dto.examinationId,
          studentId: item.studentId,
          isDeleted: false,
        },
      });
      if (existing) {
        throw new ConflictException(
          `Result for student ${item.studentId} in this examination already exists`,
        );
      }

      const isPassed = this.calculateIsPassed(
        item.score,
        Number(exam.passScore),
      );

      resultsToSave.push(
        this.resultRepository.create({
          examinationId: dto.examinationId,
          gradedBy: dto.gradedBy,
          studentId: item.studentId,
          enrollmentId: item.enrollmentId,
          score: item.score,
          remark: item.remark ?? null,
          isPassed,
        }),
      );
    }

    return this.saveAndNotify(resultsToSave);
  }

  // -------------------------------------------------------
  // FIND ALL
  // -------------------------------------------------------
  async findAll(): Promise<ExaminationResult[]> {
    return this.resultRepository.find({
      where: { isDeleted: false },
      relations: ['examination', 'student', 'enrollment', 'admin'],
      order: { createdAt: 'DESC' },
    });
  }

  // -------------------------------------------------------
  // FIND ONE
  // -------------------------------------------------------
  async findOne(id: string): Promise<ExaminationResult> {
    const result = await this.resultRepository.findOne({
      where: { id, isDeleted: false },
      relations: ['examination', 'student', 'enrollment', 'admin'],
    });

    if (!result) {
      throw new NotFoundException(`Examination result with ID ${id} not found`);
    }

    return result;
  }

  // -------------------------------------------------------
  // FIND BY EXAMINATION — all student scores for one exam
  // -------------------------------------------------------
  async findByExamination(examinationId: string): Promise<ExaminationResult[]> {
    await this.getExamination(examinationId);

    return this.resultRepository.find({
      where: { examinationId, isDeleted: false },
      relations: ['student', 'enrollment', 'admin'],
      order: { score: 'DESC' },
    });
  }

  async findSummaryByExamination(
    examinationId: string,
  ): Promise<Partial<ExaminationResult>[]> {
    return this.resultRepository.find({
      select: {
        id: true,
        examinationId: true,
        studentId: true,
        score: true,
      },
      where: { examinationId, isDeleted: false },
      order: { score: 'DESC' },
    });
  }

  // -------------------------------------------------------
  // FIND BY STUDENT — all exam results for one student
  // -------------------------------------------------------
  async findByStudent(studentId: string): Promise<ExaminationResult[]> {
    return this.resultRepository.find({
      where: { studentId, isDeleted: false },
      relations: ['examination', 'enrollment'],
      order: { gradedAt: 'DESC' },
    });
  }

  // -------------------------------------------------------
  // UPDATE — teacher corrects a score
  // -------------------------------------------------------
  async update(
    id: string,
    dto: UpdateExaminationResultDto,
  ): Promise<ExaminationResult> {
    const result = await this.findOne(id);
    const changed =
      (dto.score !== undefined && Number(dto.score) !== Number(result.score)) ||
      (dto.examinationId !== undefined &&
        dto.examinationId !== result.examinationId) ||
      (dto.studentId !== undefined && dto.studentId !== result.studentId);

    if (dto.score !== undefined) {
      const exam = await this.getExamination(
        dto.examinationId ?? result.examinationId,
      );

      if (dto.score > Number(exam.maxScore)) {
        throw new BadRequestException(
          `Score ${dto.score} exceeds max score ${exam.maxScore}`,
        );
      }

      result.isPassed = this.calculateIsPassed(
        dto.score,
        Number(exam.passScore),
      );
    }

    Object.assign(result, dto);
    return changed
      ? (await this.saveAndNotify([result]))[0]
      : this.resultRepository.save(result);
  }

  // -------------------------------------------------------
  // SOFT DELETE
  // -------------------------------------------------------
  async remove(id: string): Promise<{ message: string }> {
    const result = await this.findOne(id);
    result.isDeleted = true;
    await this.resultRepository.save(result);
    return { message: `Examination result #${id} deleted successfully` };
  }
}
