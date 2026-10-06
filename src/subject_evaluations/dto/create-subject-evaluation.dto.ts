import { Type, Transform } from 'class-transformer';
import {
  IsString,
  IsUUID,
  IsOptional,
  IsArray,
  IsObject,
  IsNumber,
  Min,
  ValidateNested,
} from 'class-validator';

export class ContentDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  maxScore?: number;

  @IsString()
  t_title: string;

  @IsString()
  t_page: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  e_title?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  e_page?: string[];

  // Persisted table-line scan. For example a detected 4-row table becomes
  // [{ page: 4, rows: [0, 1, 2, 3] }].
  @IsOptional()
  @IsArray()
  @IsObject({ each: true })
  e_rows?: Array<{ page: number; rows: number[] }>;
}

export class CreateSubjectEvaluationDto {
  @Transform(({ value, obj }) => value || obj.lessonId)
  @IsUUID()
  lesson_id: string;

  @IsOptional()
  @IsUUID()
  lessonId?: string;

  @IsString()
  topic: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ContentDto)
  contents: ContentDto[];
}
