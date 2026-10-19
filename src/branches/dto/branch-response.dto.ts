import { ApiProperty } from '@nestjs/swagger';

export class BranchResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  branch_id: string;

  @ApiProperty()
  branch_no: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ required: false, nullable: true })
  name_translations: { la: string; en: string | null } | null;

  @ApiProperty({ required: false, nullable: true })
  profile_pic: string | null;

  @ApiProperty()
  contact: string;

  @ApiProperty()
  phone: string;

  @ApiProperty()
  is_active: boolean;

  @ApiProperty()
  is_deleted: boolean;

  @ApiProperty()
  created_at: Date;

  @ApiProperty()
  updated_at: Date;
}
