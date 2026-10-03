import { Module } from '@nestjs/common';

/**
 * Provider delivery reports (Phase 2 slice 9, contracts/slice-9.md §8): WAHA and the WhatsApp
 * Cloud API, each route under the @Webhook(provider) access decorator. In no OpenAPI document
 * (src/openapi-documents.ts): providers are not API clients. Empty until slice 9; a route added
 * here needs its access decorator like every other (RouteAccessGuard).
 */
@Module({})
export class WebhooksModule {}
