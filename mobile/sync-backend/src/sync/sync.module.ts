import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { DjangoBridgeService } from './django-bridge.service';

@Module({
  imports: [AuthModule],
  controllers: [SyncController],
  providers: [SyncService, DjangoBridgeService],
})
export class SyncModule {}
