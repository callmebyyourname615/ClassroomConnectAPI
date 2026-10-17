import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsInt,
  Min,
  MaxLength,
  IsIn,
} from 'class-validator';

export class CreateAppointmentPersonDto {
  @IsString()
  @IsNotEmpty()
  branch_id: string;

  @IsString()
  @IsNotEmpty()
  appointment_id: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  academic_year_id: string;

  @IsString()
  @IsNotEmpty()
  person_id: string;

  @IsString()
  @IsNotEmpty()
  @IsIn([
    'PARENT',
    'TEACHER',
    'ADMIN',
    'SUPER_ADMIN',
    'SUPER_SUPER_ADMIN',
    'Student',
    'Parent',
    'Teacher',
    'Staff',
    'Other',
  ])
  person_type: string;

  @IsOptional()
  @IsString()
  @IsIn([
    'PENDING',
    'ACCEPTED',
    'DECLINED',
    'RESCHEDULED',
    'Pending',
    'Accepted',
    'Declined',
    'Rescheduled',
    'Attended',
    'NoShow',
  ])
  status?: string = 'Pending';

  @IsString()
  notes: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  declined_count?: number = 0;

  @IsOptional()
  @IsInt()
  @Min(0)
  rescheduled_count?: number = 0;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean = true;
}
