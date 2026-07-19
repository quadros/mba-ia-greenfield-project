import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { VideoQueueService } from '../queue/video-queue.service';
import {
  FileTooLargeException,
  InvalidUploadStateException,
  UploadSessionNotFoundException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { CompleteUploadSessionDto } from './dto/upload-part.dto';
import { CreateUploadSessionDto } from './dto/create-upload-session.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  MAX_UPLOAD_SIZE_BYTES,
  UPLOAD_PART_SIZE_BYTES,
} from './videos.constants';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly videoQueueService: VideoQueueService,
  ) {}

  private async resolveChannelId(userId: string): Promise<string> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoNotFoundException();
    }
    return channel.id;
  }

  private async findOwnedOrThrow(
    videoId: string,
    userId: string,
  ): Promise<Video> {
    const channelId = await this.resolveChannelId(userId);
    const video = await this.videoRepository.findOne({
      where: { id: videoId, channel_id: channelId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async createDraft(userId: string, dto: CreateVideoDto): Promise<Video> {
    const channelId = await this.resolveChannelId(userId);
    return this.videoRepository.save(
      this.videoRepository.create({
        channel_id: channelId,
        title: dto.title,
        status: VideoStatus.DRAFT,
      }),
    );
  }

  async createUploadSession(
    videoId: string,
    userId: string,
    dto: CreateUploadSessionDto,
  ): Promise<{ uploadId: string; partSize: number; partCount: number }> {
    const video = await this.findOwnedOrThrow(videoId, userId);

    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidUploadStateException(
        'Video is not in draft status — an upload session cannot be started',
      );
    }
    if (dto.sizeBytes > MAX_UPLOAD_SIZE_BYTES) {
      throw new FileTooLargeException();
    }

    const extension = extensionFromContentType(dto.contentType);
    const storageKey = `videos/${video.id}/original${extension}`;
    const { uploadId } = await this.storageService.createMultipartUpload(
      storageKey,
      dto.contentType,
    );

    video.storage_key = storageKey;
    video.upload_id = uploadId;
    video.size_bytes = String(dto.sizeBytes);
    await this.videoRepository.save(video);

    const partCount = Math.ceil(dto.sizeBytes / UPLOAD_PART_SIZE_BYTES);
    return { uploadId, partSize: UPLOAD_PART_SIZE_BYTES, partCount };
  }

  async presignUploadPart(
    videoId: string,
    userId: string,
    partNumber: number,
  ): Promise<string> {
    const video = await this.findOwnedOrThrow(videoId, userId);
    if (!video.upload_id || !video.storage_key) {
      throw new UploadSessionNotFoundException();
    }
    return this.storageService.presignUploadPart(
      video.storage_key,
      video.upload_id,
      partNumber,
    );
  }

  async completeUploadSession(
    videoId: string,
    userId: string,
    dto: CompleteUploadSessionDto,
  ): Promise<Video> {
    const video = await this.findOwnedOrThrow(videoId, userId);
    if (!video.upload_id || !video.storage_key) {
      throw new UploadSessionNotFoundException();
    }
    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidUploadStateException(
        'Upload session is not awaiting completion',
      );
    }

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      video.upload_id,
      dto.parts.map(({ partNumber, eTag }) => ({ partNumber, eTag })),
    );

    video.status = VideoStatus.PROCESSING;
    const saved = await this.videoRepository.save(video);

    await this.videoQueueService.enqueueProcessing(video.id);

    return saved;
  }

  async findOwnedById(videoId: string, userId: string): Promise<Video> {
    return this.findOwnedOrThrow(videoId, userId);
  }

  async getPlaybackUrl(videoId: string, userId: string): Promise<string> {
    const video = await this.findOwnedOrThrow(videoId, userId);
    if (video.status !== VideoStatus.READY) {
      throw new InvalidUploadStateException(
        'Video is not ready for playback yet',
      );
    }
    return this.storageService.presignGetObject(video.storage_key as string);
  }

  async abortUploadSession(videoId: string, userId: string): Promise<void> {
    const video = await this.findOwnedOrThrow(videoId, userId);
    if (!video.upload_id || !video.storage_key) {
      throw new UploadSessionNotFoundException();
    }

    await this.storageService.abortMultipartUpload(
      video.storage_key,
      video.upload_id,
    );

    video.upload_id = null;
    video.storage_key = null;
    video.size_bytes = null;
    await this.videoRepository.save(video);
  }
}

function extensionFromContentType(contentType: string): string {
  const map: Record<string, string> = {
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'video/x-matroska': '.mkv',
  };
  return map[contentType] ?? '';
}
