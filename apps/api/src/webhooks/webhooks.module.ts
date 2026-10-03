import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { WebhooksController } from './webhooks.controller';
import { WEBHOOK_PROVIDERS } from './webhooks.service';

/**
 * Provider delivery reports (Phase 2 slice 9, contracts/slice-9.md §8): WAHA and the WhatsApp
 * Cloud API, each route under the @Webhook(provider) access decorator. In no OpenAPI document
 * (src/openapi-documents.ts): providers are not API clients. SMS has no webhook in Phase 2
 * (Sendpk is pull-only, §8.4): POST /webhooks/sms/:provider is deliberately not mounted.
 */
@Module({
  imports: [MessagingModule],
  controllers: [WebhooksController],
  providers: [...WEBHOOK_PROVIDERS],
})
export class WebhooksModule {}
