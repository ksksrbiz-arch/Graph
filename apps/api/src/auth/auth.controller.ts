import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthService, type TokenPair } from './auth.service';

class RegisterDto {
  email!: string;
  password!: string;
  displayName?: string;
}

class LoginDto {
  email!: string;
  password!: string;
}

class RefreshDto {
  refreshToken!: string;
}

class LogoutDto {
  refreshToken!: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a new account' })
  register(@Body() dto: RegisterDto): Promise<TokenPair> {
    return this.auth.register(dto.email, dto.password, dto.displayName);
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Email/password login' })
  login(@Body() dto: LoginDto): Promise<TokenPair> {
    return this.auth.login(dto.email, dto.password);
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate refresh token and issue new access token' })
  refresh(@Body() dto: RefreshDto): Promise<TokenPair> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Revoke refresh token (logout)' })
  async logout(
    @Body() dto: LogoutDto,
    @Req() _req: Request,
  ): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }
}

