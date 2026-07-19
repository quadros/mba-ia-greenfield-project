import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { InjectRepository } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import {
  frameToBuffer,
  getDefaultVideoStream,
  getMediaDuration,
  probeAsync,
  summarizeVideoStream,
} from 'mediaforge';
import { VIDEO_PROCESSING_QUEUE } from '../../queue/queue.constants';
import type { ProcessVideoJobData } from '../../queue/video-queue.service';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';

const THUMBNAIL_TIMESTAMP_SECONDS = 1;

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOneByOrFail({ id: videoId });
    const storageKey = video.storage_key as string;

    const tempFilePath = join(
      tmpdir(),
      `${videoId}-original${extname(storageKey) || '.bin'}`,
    );

    try {
      const stream = await this.storageService.getObjectStream(storageKey);
      await pipeline(stream, createWriteStream(tempFilePath));

      const probeResult = await probeAsync(tempFilePath);
      const durationSeconds = getMediaDuration(probeResult);
      const videoStream = getDefaultVideoStream(probeResult);
      const summary = videoStream ? summarizeVideoStream(videoStream) : null;

      // Clamp strictly inside [0, duration) — seeking exactly to (or past) the
      // last frame's timestamp returns an empty buffer with no error.
      const timestamp =
        durationSeconds !== null
          ? Math.max(
              0,
              Math.min(THUMBNAIL_TIMESTAMP_SECONDS, durationSeconds - 0.1),
            )
          : 0;
      const thumbnailBuffer = await frameToBuffer({
        input: tempFilePath,
        timestamp,
        format: 'png',
      });
      const thumbnailKey = `videos/${videoId}/thumbnail.png`;
      await this.storageService.putObject(
        thumbnailKey,
        thumbnailBuffer,
        'image/png',
      );

      video.status = VideoStatus.READY;
      video.thumbnail_key = thumbnailKey;
      video.duration_seconds = durationSeconds
        ? Math.round(durationSeconds)
        : null;
      video.width = summary?.width ?? null;
      video.height = summary?.height ?? null;
      video.codec = summary?.codec ?? null;
      video.bitrate = summary?.bitrateBps
        ? Math.round(summary.bitrateBps)
        : null;
      await this.videoRepository.save(video);
    } finally {
      await unlink(tempFilePath).catch(() => undefined);
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>, error: Error): Promise<void> {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) {
      // Not the final attempt — BullMQ's own retry/backoff will re-run this
      // job; the video stays `processing` in the meantime.
      return;
    }

    this.logger.error(
      `Video ${job.data.videoId} processing failed permanently: ${error.message}`,
    );
    await this.videoRepository.update(job.data.videoId, {
      status: VideoStatus.FAILED,
      error_message: error.message.slice(0, 1000),
    });
  }
}
