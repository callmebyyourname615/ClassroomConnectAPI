import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, ForbiddenException } from '@nestjs/common';
import {
  RubricReportDataService,
  type AtomicMonthlyReportPublishDto,
  type SaveRubricReportDataDto,
} from './rubric-report-data.service';

@Controller('rubric-report-data')
export class RubricReportDataController {
  constructor(private readonly service: RubricReportDataService) {}

  @Get()
  async findAll(@Query() query: Partial<SaveRubricReportDataDto>) {
    return { data: await this.service.findAll(query) };
  }

  @Get('configuration/:configurationId')
  async findConfiguration(@Param('configurationId') configurationId: string) {
    return { data: await this.service.findConfigurationById(configurationId) };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return { data: await this.service.findById(id) };
  }

  @Put()
  async upsert(@Body() body: { data?: SaveRubricReportDataDto }) {
    return { data: await this.service.upsert(body?.data || (body as SaveRubricReportDataDto)) };
  }

  @Post('payload')
  async createPayload(@Body() body: { data?: SaveRubricReportDataDto }) {
    return { data: await this.service.createTransient(body?.data || (body as SaveRubricReportDataDto)) };
  }

  @Post('monthly-report-review')
  async reviewMonthlyReport(@Req() req: any, @Body() body: {configurationId: string; configurationVersion: number}) {
    if (!req.user?.sub || req.user.user_type === 'parent') throw new ForbiddenException('Staff account required');
    return {data: await this.service.reviewMonthlyReport(body)};
  }

  @Post('monthly-report-publish')
  async publishMonthlyReport(@Body() body: { operation?: AtomicMonthlyReportPublishDto }) {
    return this.service.publishMonthlyReport(body?.operation || (body as AtomicMonthlyReportPublishDto));
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
