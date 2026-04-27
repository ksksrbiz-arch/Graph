// REST profile endpoints — spec §6.1. All routes are JWT-guarded.
// GDPR delete (Rule 19) is a soft-delete on the users table; the background
// job in Phase 7 handles hard erasure.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { UserProfile } from '@pkg/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsersService } from './users.service';

class UpdateProfileDto {
  displayName?: string;
  locale?: string;
}

interface AuthedRequest extends Request {
  user: { sub: string };
}

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get own profile' })
  getMe(@Req() req: AuthedRequest): Promise<UserProfile> {
    return this.users.findById(req.user.sub);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update display name or locale' })
  updateMe(
    @Req() req: AuthedRequest,
    @Body() dto: UpdateProfileDto,
  ): Promise<UserProfile> {
    return this.users.updateProfile(req.user.sub, {
      displayName: dto.displayName,
      locale: dto.locale,
    });
  }

  @Delete('me')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete own account (GDPR Rule 19)' })
  async deleteMe(@Req() req: AuthedRequest): Promise<void> {
    await this.users.softDelete(req.user.sub);
  }
}
