import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CreateUploadSessionDto } from './dto/create-upload-session.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { PresignedUrlResponseDto } from './dto/presigned-url-response.dto';
import { UploadSessionResponseDto } from './dto/upload-session-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { toVideoResponse } from './videos.mapper';
import { VideosService } from './videos.service';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a video draft',
    description:
      "Pre-registers a video as a draft for the caller's channel, ahead of the upload.",
  })
  @ApiResponse({
    status: 201,
    description: 'Video draft created',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<VideoResponseDto> {
    return toVideoResponse(await this.videosService.createDraft(user.sub, dto));
  }

  @Post(':id/upload-session')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a multipart upload session',
    description:
      'Initiates an S3/MinIO multipart upload for a draft video, up to 10GB.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload session created',
    type: UploadSessionResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'File exceeds the 10GB upload limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async createUploadSession(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CreateUploadSessionDto,
  ): Promise<UploadSessionResponseDto> {
    return this.videosService.createUploadSession(id, user.sub, dto);
  }

  @Post(':id/upload-session/parts/:partNumber')
  @ApiOperation({
    summary: 'Presign an upload part URL',
    description:
      'Returns a presigned PUT URL for a single part of the active multipart upload session.',
  })
  @ApiResponse({
    status: 201,
    description: 'Presigned part URL',
    type: PresignedUrlResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Video or upload session not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async presignUploadPart(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
  ): Promise<PresignedUrlResponseDto> {
    const url = await this.videosService.presignUploadPart(
      id,
      user.sub,
      partNumber,
    );
    return { url, expiresIn: 3600 };
  }

  @Post(':id/upload-session/abort')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Abort an upload session',
    description:
      'Aborts the active multipart upload session, leaving the video as draft for retry.',
  })
  @ApiResponse({ status: 204, description: 'Upload session aborted' })
  @ApiResponse({
    status: 404,
    description: 'Video or upload session not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUploadSession(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<void> {
    return this.videosService.abortUploadSession(id, user.sub);
  }
}
