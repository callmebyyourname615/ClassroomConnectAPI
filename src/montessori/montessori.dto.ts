import { IsInt, IsObject, IsUUID, Min } from 'class-validator';
export class SaveMontessoriReport {
  @IsUUID() id: string;
  @IsInt() @Min(0) expectedVersion: number;
  @IsObject() report: Record<string, any>;
}
