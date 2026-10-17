import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { MontessoriService } from './montessori.service';
import { SaveMontessoriReport } from './montessori.dto';
@Controller('montessori/:branchId')
export class MontessoriController {
  constructor(private readonly service: MontessoriService) {}
  @Get('context') context(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
  ) {
    return this.service.context(req['user'], branch);
  }
  @Get('attendance') attendance(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Query() query: Record<string, string>,
  ) {
    return this.service.attendance(req['user'], branch, query);
  }
  @Get('reports') list(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Query() query: Record<string, string>,
  ) {
    return this.service.list(req['user'], branch, query);
  }
  @Get('reports/:id') get(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.get(req['user'], branch, id);
  }
  @Get('reports/:id/history') history(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.history(req['user'], branch, id);
  }
  @Put('reports/:id') save(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SaveMontessoriReport,
  ) {
    return this.service.save(req['user'], branch, id, body);
  }
}
