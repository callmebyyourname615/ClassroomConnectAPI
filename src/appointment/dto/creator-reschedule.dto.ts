// ============================================================
// FILE 8: src/appointment/dto/creator-reschedule.dto.ts
// ============================================================
import { IsDateString, IsOptional, IsString, Matches } from 'class-validator';

export class CreatorRescheduleDto {
  @IsOptional()
  @IsString()
  participant_id?: string;

  @IsDateString()
  rescheduled_date: string;

  @Matches(/^\d{2}:\d{2}(:\d{2})?$/, {
    message: 'rescheduled_from_time must be HH:MM or HH:MM:SS',
  })
  rescheduled_from_time: string;

  @Matches(/^\d{2}:\d{2}(:\d{2})?$/, {
    message: 'rescheduled_to_time must be HH:MM or HH:MM:SS',
  })
  rescheduled_to_time: string;
}
