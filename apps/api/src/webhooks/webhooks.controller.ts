import { Controller, Get, Header, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { WhatsAppProvider } from '@asms/shared';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Webhook } from '../common/auth/route-access';
import { notFound } from '../common/errors/api-exception';
import { ENV, whatsappProviderEnabled, type Env } from '../config/env';
import { rawBodyOf } from './raw-body';
import { WebhooksService } from './webhooks.service';

/**
 * Provider callbacks (contracts/slice-9.md §8). In no OpenAPI document (WebhooksModule's tree is
 * excluded): providers are not API clients. The global per-IP throttler is skipped; webhooks have
 * their own buckets (verified 3,000/min, failed verification 10/min, §1.6). The body is read
 * from the request only after the signature over its raw bytes has been verified, and the
 * response never echoes it.
 */
@SkipThrottle()
@Controller('webhooks')
export class WebhooksController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly webhooks: WebhooksService,
  ) {}

  /** A provider this deployment does not run (WHATSAPP_PROVIDERS_ENABLED): as if not mounted. */
  private requireEnabled(provider: WhatsAppProvider): void {
    if (!whatsappProviderEnabled(this.env, provider)) throw notFound();
  }

  @Post('waha')
  @Webhook('waha')
  @HttpCode(204)
  async waha(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    this.requireEnabled('waha');
    const ip = req.ip ?? 'unknown';
    await this.webhooks.refuseIfFailedBudgetSpent(ip, res);
    await this.webhooks.verify(
      ip,
      res,
      rawBodyOf(req),
      'sha512',
      this.env.WAHA_WEBHOOK_SECRET,
      req.get('x-webhook-hmac'),
    );
    const body: unknown = req.body;
    await this.webhooks.waha(body);
  }

  @Get('meta')
  @Webhook('meta')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async metaHandshake(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<string> {
    this.requireEnabled('cloud_api');
    const ip = req.ip ?? 'unknown';
    await this.webhooks.refuseIfFailedBudgetSpent(ip, res);
    const query: unknown = req.query;
    return this.webhooks.metaChallenge(ip, query);
  }

  @Post('meta')
  @Webhook('meta')
  @HttpCode(204)
  async meta(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    this.requireEnabled('cloud_api');
    const ip = req.ip ?? 'unknown';
    await this.webhooks.refuseIfFailedBudgetSpent(ip, res);
    const presented = req.get('x-hub-signature-256');
    await this.webhooks.verify(
      ip,
      res,
      rawBodyOf(req),
      'sha256',
      this.env.META_APP_SECRET,
      presented?.startsWith('sha256=') ? presented.slice('sha256='.length) : undefined,
    );
    const body: unknown = req.body;
    await this.webhooks.meta(body);
  }
}
