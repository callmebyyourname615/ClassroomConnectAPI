import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Req,
} from '@nestjs/common';
import { MobilePushService } from './mobile-push.service';
@Controller('notifications/mobile-push')
export class MobilePushController {
  constructor(private readonly push: MobilePushService) {}
  private parentId(req: any) {
    if (req.user?.user_type !== 'parent' || !req.user?.sub)
      throw new ForbiddenException('Parent account required');
    return req.user.sub;
  }
  @Get('configuration') configuration(@Req() req: any) {
    this.parentId(req);
    return this.push.configuration();
  }
  @Post('register') register(@Req() req: any, @Body() body: any) {
    return this.push.register(this.parentId(req), body);
  }
  @Post('unregister') unregister(@Req() req: any, @Body() body: any) {
    return this.push.unregister(this.parentId(req), body?.deviceId);
  }
}
