import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { User } from './entities/User';
import { AdminGuard } from './guards/admin.guard';
import { MagicLinkEmailQueue } from './magic-link-email-queue';
import { MagicLinkTokenStore } from './magic-link-token-store';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    ConfigModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, AdminGuard, MagicLinkTokenStore, MagicLinkEmailQueue],
  exports: [AuthService, AdminGuard],
})
export class AuthModule { }
