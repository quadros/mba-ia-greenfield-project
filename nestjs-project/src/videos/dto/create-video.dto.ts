import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateVideoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;
}
