import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { ReportRequestsService } from './report-requests.service';

@Controller('student-reports/:studentId')
export class ParentReportRequestsController {
  constructor(private readonly service: ReportRequestsService) {}

  @Get('request-options')
  @Header('Cache-Control', 'private, no-store')
  options(
    @Req() req: Request,
    @Param('studentId', ParseUUIDPipe) student: string,
    @Query() query: Record<string, string>,
  ) {
    return this.service.options(req['user'], student, query);
  }

  @Get('requests')
  @Header('Cache-Control', 'private, no-store')
  history(
    @Req() req: Request,
    @Param('studentId', ParseUUIDPipe) student: string,
    @Query() query: Record<string, string>,
  ) {
    return this.service.history(req['user'], student, query);
  }

  @Get('requests/:id')
  @Header('Cache-Control', 'private, no-store')
  detail(
    @Req() req: Request,
    @Param('studentId', ParseUUIDPipe) student: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string>,
  ) {
    const prefix = req.originalUrl.split('/student-reports/')[0];
    return this.service.detail(
      req['user'],
      student,
      id,
      query,
      `${req.protocol}://${req.get('host')}${prefix}`,
    );
  }

  @Post('requests')
  @Header('Cache-Control', 'private, no-store')
  create(
    @Req() req: Request,
    @Param('studentId', ParseUUIDPipe) student: string,
    @Body() body: Record<string, any>,
    @Headers('idempotency-key') key: string,
  ) {
    return this.service.create(req['user'], student, body, key);
  }

  @Delete('requests/:id')
  @Header('Cache-Control', 'private, no-store')
  remove(
    @Req() req: Request,
    @Param('studentId', ParseUUIDPipe) student: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string>,
    @Body() body: Record<string, any>,
  ) {
    return this.service.parentRemove(req['user'], student, id, query, body);
  }
}

@Controller('official-report-requests/:branchId')
export class StaffReportRequestsController {
  constructor(private readonly service: ReportRequestsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  queue(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Query() query: Record<string, string>,
  ) {
    return this.service.queue(req['user'], branch, query);
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  detail(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.staffDetail(req['user'], branch, id);
  }

  @Get(':id/documents/:documentId/document')
  @Header('Cache-Control', 'private, no-store')
  async downloadDocument(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    const result = await this.service.staffDocument(
      req['user'],
      branch,
      id,
      documentId,
    );
    return new StreamableFile(result.content, {
      type: 'application/pdf',
      disposition: `attachment; filename="${result.filename}"`,
    });
  }

  @Patch(':id/documents/:documentId')
  @Header('Cache-Control', 'private, no-store')
  documentStatus(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() body: Record<string, any>,
  ) {
    return this.service.updateDocumentStatus(
      req['user'],
      branch,
      id,
      documentId,
      body,
    );
  }

  @Patch(':id')
  @Header('Cache-Control', 'private, no-store')
  update(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Record<string, any>,
  ) {
    return this.service.update(req['user'], branch, id, body);
  }

  @Delete(':id')
  @Header('Cache-Control', 'private, no-store')
  remove(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Record<string, any>,
  ) {
    return this.service.remove(req['user'], branch, id, body);
  }

  @Get(':id/document')
  @Header('Cache-Control', 'private, no-store')
  async download(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const result = await this.service.staffDocument(req['user'], branch, id);
    return new StreamableFile(result.content, {
      type: 'application/pdf',
      disposition: `attachment; filename="${result.filename}"`,
    });
  }

  @Post(':id/document')
  @Header('Cache-Control', 'private, no-store')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    }),
  )
  document(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Record<string, any>,
    @UploadedFile() file?: { buffer: Buffer },
  ) {
    return this.service.update(
      req['user'],
      branch,
      id,
      { expectedVersion: Number(body.expectedVersion), status: 'ready' },
      file?.buffer,
    );
  }

  @Post(':id/documents/:documentId/document')
  @Header('Cache-Control', 'private, no-store')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    }),
  )
  uploadDocument(
    @Req() req: Request,
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() body: Record<string, any>,
    @UploadedFile() file?: { buffer: Buffer },
  ) {
    return this.service.updateDocumentFile(
      req['user'],
      branch,
      id,
      documentId,
      Number(body.expectedVersion),
      file?.buffer,
    );
  }
}

@Controller('official-report-documents')
export class ReportDocumentsController {
  constructor(private readonly service: ReportRequestsService) {}

  @Public()
  @Get(':id/:documentId')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async downloadRequestedDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Query('token') token: string,
  ) {
    const result = await this.service.document(id, token, documentId);
    return new StreamableFile(result.content, {
      type: 'application/pdf',
      disposition: `attachment; filename="${result.filename}"`,
    });
  }

  @Public()
  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('token') token: string,
  ) {
    const result = await this.service.document(id, token);
    return new StreamableFile(result.content, {
      type: 'application/pdf',
      disposition: `attachment; filename="${result.filename}"`,
    });
  }
}
