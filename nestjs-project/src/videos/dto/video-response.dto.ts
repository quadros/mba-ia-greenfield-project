import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class VideoResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-0000-4000-8000-000000000000' })
  id: string;

  @ApiProperty({ example: 'a1b2c3d4-0000-4000-8000-000000000001' })
  channelId: string;

  @ApiProperty({ example: 'My first video' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ required: false, nullable: true, example: 12 })
  durationSeconds: number | null;

  @ApiProperty({ required: false, nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ required: false, nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    example: 'videos/a1b2c3d4/thumbnail.jpg',
  })
  thumbnailKey: string | null;

  @ApiProperty({ required: false, nullable: true, example: null })
  errorMessage: string | null;

  @ApiProperty({ example: '2026-07-19T12:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-07-19T12:00:00.000Z' })
  updatedAt: Date;
}
