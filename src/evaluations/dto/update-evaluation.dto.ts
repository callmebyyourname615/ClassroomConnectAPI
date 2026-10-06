import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, IsUUID, Min } from 'class-validator';

export class UpdateEvaluationDto {
  @IsOptional()
  @IsUUID()
  subjectId?: string;

  @IsOptional()
  @IsUUID()
  classId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  score?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  contentIndex?: number;
}
