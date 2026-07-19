import { Video } from './entities/video.entity';
import { VideoResponseDto } from './dto/video-response.dto';

export function toVideoResponse(video: Video): VideoResponseDto {
  return {
    id: video.id,
    channelId: video.channel_id,
    title: video.title,
    status: video.status,
    durationSeconds: video.duration_seconds,
    width: video.width,
    height: video.height,
    thumbnailKey: video.thumbnail_key,
    errorMessage: video.error_message,
    createdAt: video.created_at,
    updatedAt: video.updated_at,
  };
}
