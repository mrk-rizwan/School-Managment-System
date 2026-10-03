// Request-bound parameters the brand rule must accept. Linted at a controller path.
import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { IsInt, IsOptional, IsString } from 'class-validator';
import type { Request, Response } from 'express';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { IdParam } from '../../common/ids';

export class CreateStudentDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsInt()
  rollNumber?: number;

  @IsString({ each: true })
  tags!: string[];
}

export class ListStudentsQueryDto {
  @IsOptional()
  @IsString()
  q?: string;
}

@Controller('students')
export class StudentsController {
  @Post()
  create(
    @Body() body: CreateStudentDto,
    @Query() query: ListStudentsQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): string {
    return [body, query, session, req, res].length.toString();
  }

  @Get(':id/:slug')
  get(@IdParam() id: bigint, @Param('slug') slug: string): string {
    return `${id}${slug}`;
  }
}
