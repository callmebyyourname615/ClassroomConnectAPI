import { parseBilingualName } from '../common/bilingual-name';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { YearLevel } from './year-level.entity';
import { CreateYearLevelDto } from './dto/create-year-level.dto';
import { UpdateYearLevelDto } from './dto/update-year-level.dto';
import { CacheService } from '../common/cache.service';

@Injectable()
export class YearLevelsService {
  constructor(
    @InjectRepository(YearLevel)
    private readonly repo: Repository<YearLevel>,
    private readonly cache: CacheService,
  ) {}

  async create(dto: CreateYearLevelDto): Promise<YearLevel> {
    const entity = this.repo.create({
      ...dto, // spreads name, is_active, is_deleted
      name: dto.name.trim(),
      name_translations: this.translations(dto.name),
      level_id: dto.levelId, // explicitly map levelId → level_id
    });

    const saved = await this.repo.save(entity);
    await this.cache.del('year-levels:all');
    await this.cache.delPattern('lessons:*');
    return saved;
  }

  async findAll(): Promise<YearLevel[]> {
    return this.cache.getOrSet('year-levels:all', 900, () =>
      this.repo.find({
        where: { is_deleted: false },
        relations: ['level'],
      }),
    );
  }

  async findOne(id: string): Promise<YearLevel | null> {
    return this.repo.findOne({
      where: { id, is_deleted: false },
      relations: ['level'],
    });
  }

  async update(id: string, dto: UpdateYearLevelDto): Promise<YearLevel> {
    const updateData: Partial<YearLevel> = {};

    if (dto.name !== undefined) {
      updateData.name = dto.name.trim();
      updateData.name_translations = this.translations(dto.name);
    }
    if (dto.levelId !== undefined) updateData.level_id = dto.levelId;
    if (dto.is_active !== undefined) updateData.is_active = dto.is_active;
    if (dto.is_deleted !== undefined) updateData.is_deleted = dto.is_deleted;

    if (Object.keys(updateData).length === 0) {
      return (await this.findOne(id))!;
    }

    await this.repo
      .createQueryBuilder()
      .update(YearLevel)
      .set(updateData)
      .where('id = :id', { id })
      .execute();

    await this.cache.del('year-levels:all');
    await this.cache.delPattern('lessons:*');
    return (await this.findOne(id))!;
  }

  async remove(id: string): Promise<void> {
    const yearLevel = await this.repo.findOne({ where: { id } });

    if (!yearLevel) {
      throw new NotFoundException(`Year level with ID ${id} not found`);
    }

    await this.repo.update(id, {
      is_deleted: true,
      is_active: false,
    });
    await this.cache.del('year-levels:all');
    await this.cache.delPattern('lessons:*');
  }
  private translations(name: string) {
    try {
      return parseBilingualName(name);
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }
}
