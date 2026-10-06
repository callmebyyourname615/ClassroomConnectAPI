import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request, Response } from 'express';
import { KindergartenService } from './kindergarten.service';
import {
  SaveKindergartenRecords,
  SaveKindergartenReport,
} from './kindergarten.dto';
@Controller('kindergarten/:branchId')
export class KindergartenController {
  constructor(private readonly service: KindergartenService) {}
  @Get('records') load(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
  ) {
    return this.service.load(req['user'], branch);
  }
  @Patch('records') save(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Body() body: SaveKindergartenRecords,
  ) {
    return this.service.save(req['user'], branch, body.changes);
  }
  @Post('assets')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  upload(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.service.upload(req['user'], branch, file);
  }
  @Post('evidence-files')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }))
  evidenceUpload(@Req() req: Request, @Param('branchId', ParseUUIDPipe) branch: string, @UploadedFile() file: Express.Multer.File) {
    return this.service.upload(req['user'], branch, file, true);
  }
  @Get('assets/:id') async asset(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const asset = await this.service.asset(req['user'], branch, id);
    res.setHeader('Content-Type', asset.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(asset.content);
  }
  @Post('reports') report(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Body() body: SaveKindergartenReport,
  ) {
    return this.service.report(req['user'], branch, body.snapshot);
  }
  @Get('reports/:id') getReport(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getReport(req['user'], branch, id);
  }
  @Get('attendance/:classId/:yearId') attendance(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('classId', ParseUUIDPipe) room: string,
    @Param('yearId', ParseUUIDPipe) year: string,
  ) {
    return this.service.attendance(req['user'], branch, room, year);
  }
}
