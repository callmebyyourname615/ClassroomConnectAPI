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
import { ParentMontessoriService } from './parent-montessori.service';

@Controller('student-reports/:studentId/montessori')
export class ParentMontessoriController {
  constructor(private readonly service: ParentMontessoriService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(
    @Req() req: Request,
    @Param('studentId', ParseUUIDPipe) student: string,
    @Query() query: Record<string, string>,
  ) {
    return this.service.list(req['user'], student, query);
  }

  @Get(':reportId')
  @Header('Cache-Control', 'private, no-store')
  detail(
    @Req() req: Request,
    @Param('studentId', ParseUUIDPipe) student: string,
    @Param('reportId', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string>,
  ) {
    return this.service.detail(req['user'], student, id, query);
  }
}
