import { parseBilingualName } from '../common/bilingual-name';
import {
  Injectable,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Level } from './level.entity';
import { CreateLevelDto } from './dto/create-level.dto';
import { UpdateLevelDto } from './dto/update-level.dto';
import { CacheService } from '../common/cache.service';

@Injectable()
export class LevelsService {
  constructor(
    @InjectRepository(Level)
    private readonly repo: Repository<Level>,
    private readonly cache: CacheService,
  ) {}

  async create(dto: CreateLevelDto): Promise<Level> {
    const level = this.repo.create({
      ...dto,
      name: dto.name.trim(),
      name_translations: this.translations(dto.name),
    });
    const saved = await this.repo.save(level);
    await this.cache.del('levels:all');
    await this.cache.del('year-levels:all');
    await this.cache.delPattern('lessons:*');
    return saved;
  }

  async findAll(): Promise<Level[]> {
    return this.cache.getOrSet('levels:all', 900, () => this.repo.find());
  }

  async findOne(id: string): Promise<Level | null> {
    return this.repo.findOne({ where: { id } });
  }

  async update(id: string, dto: UpdateLevelDto): Promise<Level | null> {
    await this.repo.update(id, {
      ...dto,
      ...(dto.name !== undefined
        ? {
            name: dto.name.trim(),
            name_translations: this.translations(dto.name),
          }
        : {}),
    });
    await this.cache.del('levels:all');
    await this.cache.del('year-levels:all');
    await this.cache.delPattern('lessons:*');
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    try {
      await this.repo.delete(id);
      await this.cache.del('levels:all');
      await this.cache.del('year-levels:all');
      await this.cache.delPattern('lessons:*');
    } catch (error: any) {
      if (error.code === '23503') {
        throw new ConflictException(
          'Cannot delete this level because it is referenced by one or more year levels. Please delete them first.',
        );
      }
      throw error;
    }
  }
  private translations(name: string) {
    try {
      return parseBilingualName(name);
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }
}
