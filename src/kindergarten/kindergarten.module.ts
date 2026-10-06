import { Module } from '@nestjs/common';
import { KindergartenController } from './kindergarten.controller';
import { KindergartenService } from './kindergarten.service';
@Module({
  controllers: [KindergartenController],
  providers: [KindergartenService],
})
export class KindergartenModule {}
