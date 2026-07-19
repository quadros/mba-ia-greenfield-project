import { ApiProperty } from '@nestjs/swagger';

export class PresignedUrlResponseDto {
  @ApiProperty({ example: 'https://minio:9000/streamtube-videos/...' })
  url: string;

  @ApiProperty({ example: 3600 })
  expiresIn: number;
}
