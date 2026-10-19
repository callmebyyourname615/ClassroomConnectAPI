import { Module } from '@nestjs/common';
import { MontessoriController } from './montessori.controller';
import { MontessoriService } from './montessori.service';
import { ParentMontessoriController } from './parent-montessori.controller';
import { ParentMontessoriService } from './parent-montessori.service';
@Module({
  controllers: [MontessoriController, ParentMontessoriController],
  providers: [MontessoriService, ParentMontessoriService],
  exports: [MontessoriService],
})
export class MontessoriModule {}
