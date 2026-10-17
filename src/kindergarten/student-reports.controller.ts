import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { StudentReportsService } from './student-reports.service';

@Controller('student-reports/:studentId')
export class StudentReportsController {
  constructor(private readonly service: StudentReportsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  report(
    @Req() req: Request,
    @Param('studentId', ParseUUIDPipe) student: string,
    @Query() query: Record<string, string>,
  ) {
    return this.service.report(req['user'], student, query);
  }

  @Get('images/:assetId')
  @Header('Cache-Control', 'private, no-store')
  image(
    @Req() req: Request,
    @Param('studentId', ParseUUIDPipe) student: string,
    @Param('assetId', ParseUUIDPipe) asset: string,
    @Query() query: Record<string, string>,
  ) {
    return this.service.image(req['user'], student, asset, query);
  }
}
