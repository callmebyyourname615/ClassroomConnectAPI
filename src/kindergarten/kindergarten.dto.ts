import {
  Allow,
  IsArray,
  IsInt,
  IsObject,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
export class KindergartenChange {
  @IsString() @MaxLength(32) collection: string;
  @IsString() @MaxLength(512) key: string;
  @IsInt() @Min(0) expectedVersion: number;
  // Null represents a tombstone. Payload-specific validation lives in the service.
  @Allow() value: any;
}
export class SaveKindergartenRecords {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KindergartenChange)
  changes: KindergartenChange[];
}
export class SaveKindergartenReport {
  @IsObject() snapshot: Record<string, any>;
}
