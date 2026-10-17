import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Req,
} from '@nestjs/common';
import { WebPushService } from './web-push.service';
@Controller('notifications/push')
export class WebPushController {
  constructor(private readonly push: WebPushService) {}
  private parentId(request: any) {
    if (request.user?.user_type !== 'parent' || !request.user?.sub)
      throw new ForbiddenException('Parent account required');
    return request.user.sub;
  }
  @Get('configuration')
  configuration(@Req() request: any) {
    this.parentId(request);
    return this.push.configuration();
  }
  @Post('subscribe')
  subscribe(@Req() request: any, @Body() body: any) {
    return this.push.subscribe(this.parentId(request), body);
  }
  @Post('unsubscribe')
  unsubscribe(@Req() request: any, @Body() body: { endpoint: string }) {
    return this.push.unsubscribe(this.parentId(request), body.endpoint);
  }
}
