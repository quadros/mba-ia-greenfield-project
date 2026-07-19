import { IsInt, IsNotEmpty, IsPositive, IsString } from 'class-validator';

export class CreateUploadSessionDto {
  // Upper bound (10GB) is enforced in VideosService, not here — it must
  // surface as 413 FILE_TOO_LARGE, distinct from a 400 validation error.
  @IsInt()
  @IsPositive()
  sizeBytes: number;

  @IsString()
  @IsNotEmpty()
  contentType: string;
}
