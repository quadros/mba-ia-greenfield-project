import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsString,
  ValidateNested,
} from 'class-validator';

export class UploadedPartDto {
  @IsInt()
  @IsPositive()
  partNumber: number;

  @IsString()
  @IsNotEmpty()
  eTag: string;
}

export class CompleteUploadSessionDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => UploadedPartDto)
  parts: UploadedPartDto[];
}
