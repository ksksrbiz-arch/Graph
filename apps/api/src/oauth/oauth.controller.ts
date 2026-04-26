import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { ConnectorId } from '@pkg/shared';
import { CONNECTOR_IDS } from '@pkg/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OAuthService } from './oauth.service';

interface AuthedRequest extends Request {
  user: { sub: string };
}

class ConnectDto {
  redirectUri!: string;
  scopes?: string[];
  returnTo?: string;
}

@ApiTags('oauth')
@Controller('oauth')
export class OAuthController {
  constructor(private readonly oauth: OAuthService) {}

  @Post('connect/:connectorId')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'Begin an OAuth handshake — returns the URL the SPA should redirect to',
  })
  connect(
    @Req() req: AuthedRequest,
    @Param('connectorId') connectorId: string,
    @Body() dto: ConnectDto,
  ): { authorizeUrl: string; state: string } {
    const id = this.assertConnectorId(connectorId);
    if (!dto?.redirectUri) {
      throw new BadRequestException('redirectUri is required');
    }
    return this.oauth.authorize({
      userId: req.user.sub,
      connectorId: id,
      redirectUri: dto.redirectUri,
      ...(dto.scopes && dto.scopes.length > 0 ? { scopes: dto.scopes } : {}),
      ...(dto.returnTo ? { returnTo: dto.returnTo } : {}),
    });
  }

  /**
   * Provider-side redirect target. Public (no JWT) because the user's browser
   * is hitting it after consenting at the provider — the encrypted state
   * parameter is the only authentication we have here, and `OAuthService`
   * validates it before we touch the cipher.
   */
  @Get('callback/:connectorId')
  @ApiOperation({ summary: 'OAuth callback — exchanges code for tokens' })
  async callback(
    @Param('connectorId') connectorId: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const id = this.assertConnectorId(connectorId);
    if (error) {
      throw new BadRequestException(
        `oauth provider error: ${error}${
          errorDescription ? ` — ${errorDescription}` : ''
        }`,
      );
    }
    if (!code || !state) {
      throw new BadRequestException('code and state are required');
    }
    const redirectUri = this.callbackUri(res.req, id);
    const config = await this.oauth.handleCallback({
      connectorId: id,
      code,
      state,
      redirectUri,
    });

    // For now respond with a tiny self-closing HTML page that signals success
    // back to the opener window. The SPA listens for this `postMessage` to
    // refresh its connector list. Phase 1 may swap this for a redirect to
    // `state.returnTo`.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(connectedPage(id, config.userId));
  }

  private assertConnectorId(value: string): ConnectorId {
    if (!(CONNECTOR_IDS as readonly string[]).includes(value)) {
      throw new BadRequestException(`unknown connectorId: ${value}`);
    }
    return value as ConnectorId;
  }

  private callbackUri(req: Request, connectorId: ConnectorId): string {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
    const host = req.headers.host;
    return `${proto}://${host}/api/v1/oauth/callback/${connectorId}`;
  }
}

function connectedPage(connectorId: string, userId: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<title>Connected</title>
<body style="font-family: system-ui; padding: 2rem; background: #0b0d12; color: #e6e8ee;">
  <h1>${escapeHtml(connectorId)} connected.</h1>
  <p>You can close this window.</p>
  <script>
    try {
      window.opener && window.opener.postMessage(
        { source: 'pkg-oauth', connectorId: ${JSON.stringify(connectorId)}, userId: ${JSON.stringify(userId)} },
        '*'
      );
    } catch (e) {}
    setTimeout(() => window.close(), 800);
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&'
      ? '&amp;'
      : c === '<'
        ? '&lt;'
        : c === '>'
          ? '&gt;'
          : c === '"'
            ? '&quot;'
            : '&#39;',
  );
}
