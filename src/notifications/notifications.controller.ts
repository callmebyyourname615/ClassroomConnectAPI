import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Put,
  Patch,
  Delete,
  Req,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Post()
  create(@Body() dto: CreateNotificationDto, @Req() request: any) {
    this.requireStaff(request);
    return this.service.create(dto);
  }

  @Get()
  findAll(@Req() request: any) {
    this.requireStaff(request);
    return this.service.findAll();
  }

  @Post('branch')
  findByBranch(@Body() body: { branch_id: string }, @Req() request: any) {
    this.requireStaff(request);
    return this.service.findByBranch(body);
  }

  @Get('parent/:parentId')
  findByParent(@Param('parentId') parentId: string, @Req() request: any) {
    this.requireStaff(request);
    return this.service.findByParent(parentId);
  }

  @Get('student/:studentId')
  findByStudent(@Param('studentId') studentId: string, @Req() request: any) {
    this.requireStaff(request);
    return this.service.findByStudent(studentId);
  }

  private requireStaff(request: any) {
    if (request.user?.user_type === 'parent')
      throw new ForbiddenException('Use the parent inbox endpoint');
  }

  private parentId(request: any): string {
    if (request.user?.user_type !== 'parent' || !request.user?.sub) {
      throw new ForbiddenException('Parent account required');
    }
    return request.user.sub;
  }

  @Get('mine')
  inbox(@Req() request: any) {
    return this.service.findParentInbox(this.parentId(request));
  }

  @Patch('mine/:id/read')
  setParentRead(
    @Req() request: any,
    @Param('id') id: string,
    @Body() body: { seen: boolean },
  ) {
    if (typeof body.seen !== 'boolean')
      throw new BadRequestException('seen must be boolean');
    return this.service.setParentRead(id, this.parentId(request), body.seen);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() request: any) {
    this.requireStaff(request);
    return this.service.findOne(id);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateNotificationDto,
    @Req() request: any,
  ) {
    this.requireStaff(request);
    return this.service.update(id, dto);
  }

  @Patch(':id/seen')
  markSeen(@Param('id') id: string, @Req() request: any) {
    this.requireStaff(request);
    return this.service.markSeen(id);
  }

  @Patch(':id/clicked')
  markClicked(@Param('id') id: string, @Req() request: any) {
    this.requireStaff(request);
    return this.service.markClicked(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() request: any) {
    this.requireStaff(request);
    return this.service.remove(id);
  }
}
