import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ForbiddenException,
  Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { ApiConsumes, ApiOperation } from '@nestjs/swagger';
import { TeacherHomeworkService } from './teacher-homework.service';
import { CreateTeacherHomeworkDto } from './dto/create-teacher-homework.dto';
import { UpdateTeacherHomeworkDto } from './dto/update-teacher-homework.dto';
import { CreateTeacherHomeworkItemDto } from './dto/create-teacher-homework-item.dto';
import { UpdateTeacherHomeworkItemDto } from './dto/update-teacher-homework-item.dto';
import { TeacherHomeworkStatus } from './teacher-homework-status.enum';

const ALLOWED_IMAGE_TYPES = ['.jpg', '.jpeg', '.png', '.gif'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

@Controller('teacher-homework')
export class TeacherHomeworkController {
  constructor(
    private readonly teacherHomeworkService: TeacherHomeworkService,
  ) {}

  private requireStaff(req: any) {
    if (!req.user?.sub || req.user.user_type === 'parent')
      throw new ForbiddenException('Staff account required');
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new homework (with optional image)' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads/homeworks',
        filename: (_req, file, cb) => {
          const uniqueSuffix =
            Date.now() + '-' + Math.round(Math.random() * 1e9);
          const ext = extname(file.originalname).toLowerCase();
          cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
        },
      }),
      fileFilter: (_req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase();
        if (!ALLOWED_IMAGE_TYPES.includes(ext)) {
          return cb(
            new BadRequestException(
              'Only image files are allowed (.jpg, .jpeg, .png, .gif)',
            ),
            false,
          );
        }
        cb(null, true);
      },
      limits: { fileSize: MAX_FILE_SIZE },
    }),
  )
  async create(
    @Req() req: any,
    @Body() createDto: CreateTeacherHomeworkDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    this.requireStaff(req);
    return this.teacherHomeworkService.create(createDto, file);
  }

  @Get()
  findAll(
    @Query('teachLearningId') teachLearningId?: string,
    @Query('status') status?: TeacherHomeworkStatus,
  ) {
    return this.teacherHomeworkService.findAll(teachLearningId, status);
  }

  @Post(':homeworkId/items')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add an item to a homework (with optional image)' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads/homeworks',
        filename: (_req, file, cb) => {
          const uniqueSuffix =
            Date.now() + '-' + Math.round(Math.random() * 1e9);
          const ext = extname(file.originalname).toLowerCase();
          cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
        },
      }),
      fileFilter: (_req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase();
        if (!ALLOWED_IMAGE_TYPES.includes(ext)) {
          return cb(
            new BadRequestException(
              'Only image files are allowed (.jpg, .jpeg, .png, .gif)',
            ),
            false,
          );
        }
        cb(null, true);
      },
      limits: { fileSize: MAX_FILE_SIZE },
    }),
  )
  async createItem(
    @Param('homeworkId', ParseUUIDPipe) homeworkId: string,
    @Body() createDto: CreateTeacherHomeworkItemDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.teacherHomeworkService.createItem(homeworkId, createDto, file);
  }

  @Get(':homeworkId/items')
  findItems(@Param('homeworkId', ParseUUIDPipe) homeworkId: string) {
    return this.teacherHomeworkService.findItems(homeworkId);
  }

  @Get('items/:itemId')
  findItem(@Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.teacherHomeworkService.findItem(itemId);
  }

  @Patch('items/:itemId')
  updateItem(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() updateDto: UpdateTeacherHomeworkItemDto,
  ) {
    return this.teacherHomeworkService.updateItem(itemId, updateDto);
  }

  @Delete('items/:itemId')
  removeItem(@Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.teacherHomeworkService.removeItem(itemId);
  }

  @Patch(':id/publish')
  publish(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    this.requireStaff(req);
    return this.teacherHomeworkService.publish(id);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.teacherHomeworkService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
    @Body() updateDto: UpdateTeacherHomeworkDto,
  ) {
    this.requireStaff(req);
    return this.teacherHomeworkService.update(id, updateDto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.teacherHomeworkService.remove(id);
  }
}
