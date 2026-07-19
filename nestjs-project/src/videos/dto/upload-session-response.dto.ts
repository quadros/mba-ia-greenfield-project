import { ApiProperty } from '@nestjs/swagger';

export class UploadSessionResponseDto {
  @ApiProperty({ example: 'AbCdEf123...' })
  uploadId: string;

  @ApiProperty({ example: 104857600, description: 'Part size in bytes' })
  partSize: number;

  @ApiProperty({ example: 3 })
  partCount: number;
}
