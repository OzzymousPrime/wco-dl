import {
  Body, CanActivate, Controller, ExecutionContext, Get, HttpCode, Injectable, Post, Query, Req, Res, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JsonRequestGuard } from './json-request.guard';
import { SESSION_COOKIE, SetupService, SetupStatus } from './setup.service';

/** Lets a request through when no password is set, or when this browser has given it. */
@Injectable()
export class SetupGuard implements CanActivate {
  constructor(private readonly setup: SetupService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!this.setup.authorised(req.headers.cookie)) throw new UnauthorizedException('Locked: enter the password');
    return true;
  }
}

// HttpOnly: the page's own scripts never see it. SameSite=Strict: no other site can use it. No "Secure", because
// most people open this over plain http on their own network.
const cookie = (token: string, maxAgeSeconds: number) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;

/** Setup and Settings (see SetupService). No route here ever answers with a key, a token or the password. */
@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  // For every page: is Sonarr connected (else send a newcomer to setup), and is this page locked?
  @Get('state')
  state(@Req() req: Request) {
    return this.setup.state(req.headers.cookie);
  }

  @Post('unlock')
  @HttpCode(200)
  @UseGuards(JsonRequestGuard)
  async unlock(@Body() body: any, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Set-Cookie', cookie(await this.setup.unlock(body?.password), 12 * 60 * 60));
    return { ok: true };
  }

  @Post('signout')
  @HttpCode(200)
  @UseGuards(JsonRequestGuard)
  signOut(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.setup.signOut(req.headers.cookie);
    res.setHeader('Set-Cookie', cookie('', 0));
    return { ok: true };
  }

  // The check-up: tests Sonarr, the download folder and the Cloudflare helper, and says what to fix.
  @Get()
  @UseGuards(SetupGuard)
  status(): Promise<SetupStatus> {
    return this.setup.status();
  }

  @Get('folders')
  @UseGuards(SetupGuard)
  folders(@Query('path') dir?: string) {
    return this.setup.folders(dir);
  }

  @Post('sonarr')
  @HttpCode(200)
  @UseGuards(SetupGuard, JsonRequestGuard)
  saveSonarr(@Body() body: any): Promise<SetupStatus> {
    return this.setup.saveSonarr(body);
  }

  @Post('folder')
  @HttpCode(200)
  @UseGuards(SetupGuard, JsonRequestGuard)
  saveFolder(@Body() body: any): Promise<SetupStatus> {
    return this.setup.saveFolder(body);
  }

  @Post('extras')
  @HttpCode(200)
  @UseGuards(SetupGuard, JsonRequestGuard)
  saveExtras(@Body() body: any): Promise<SetupStatus> {
    return this.setup.saveExtras(body);
  }

  @Post('reset')
  @HttpCode(200)
  @UseGuards(SetupGuard, JsonRequestGuard)
  reset(@Body() body: any): Promise<SetupStatus> {
    return this.setup.reset(body);
  }

  @Post('lock')
  @HttpCode(200)
  @UseGuards(SetupGuard, JsonRequestGuard)
  async lock(@Body() body: any, @Res({ passthrough: true }) res: Response) {
    const token = await this.setup.setLock(body);
    res.setHeader('Set-Cookie', token ? cookie(token, 12 * 60 * 60) : cookie('', 0));
    return { ok: true, on: !!token };
  }
}
