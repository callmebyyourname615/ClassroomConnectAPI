import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Patch,
  Delete,
  ParseIntPipe,
  Query,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { EvaluationService } from './evaluation.service';
import { CreateEvaluationDto } from './dto/create-evaluation.dto';
import { UpdateEvaluationDto } from './dto/update-evaluation.dto';
import { Evaluation } from './evaluation.entity';

@Controller('evaluations')
export class EvaluationController {
  constructor(private readonly evaluationService: EvaluationService) {}

  private requireStaff(request: any) {
    if (request.user?.user_type === 'parent')
      throw new ForbiddenException('Staff account required');
  }

  @Post()
  create(
    @Body() dto: CreateEvaluationDto,
    @Req() request: any,
  ): Promise<Evaluation> {
    this.requireStaff(request);
    return this.evaluationService.create(dto);
  }

  @Get()
  findAll(): Promise<Evaluation[]> {
    return this.evaluationService.findAll();
  }

  @Get('report-source')
  findReportSource(
    @Query('classId') classId: string,
    @Query('subjectEvaluationIds') subjectEvaluationIds = '',
  ) {
    return this.evaluationService.findReportSource(
      classId,
      subjectEvaluationIds
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    );
  }

  @Get('student/:studentId')
  findByStudent(@Param('studentId') studentId: string): Promise<Evaluation[]> {
    return this.evaluationService.findByStudent(studentId);
  }

  @Patch(':id')
  updateScore(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEvaluationDto,
    @Req() request: any,
  ): Promise<Evaluation> {
    this.requireStaff(request);
    return this.evaluationService.updateScore(id, dto);
  }

  @Delete(':id')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: any,
  ): Promise<{ message: string }> {
    this.requireStaff(request);
    return this.evaluationService.remove(id);
  }
}
