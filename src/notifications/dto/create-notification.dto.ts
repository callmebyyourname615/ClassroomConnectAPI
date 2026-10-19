import {
  IsOptional,
  IsString,
  IsUUID,
  IsNumber,
  IsObject,
} from 'class-validator';

export class CreateNotificationDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  message?: string;

  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsOptional()
  @IsUUID()
  academic_year_id?: string;

  @IsOptional()
  @IsUUID()
  student_id?: string;

  @IsOptional()
  @IsUUID()
  parent_id?: string;

  @IsOptional()
  @IsUUID()
  admin_id?: string;

  @IsOptional()
  @IsUUID()
  module_id?: string;

  @IsOptional()
  @IsString()
  module_type?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsNumber()
  target_type?: number;

  @IsOptional()
  @IsNumber()
  target?: number;

  @IsOptional()
  @IsNumber()
  seen?: number;

  @IsOptional()
  @IsNumber()
  clicked?: number;
}
