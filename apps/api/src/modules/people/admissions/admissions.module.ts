import { Module } from '@nestjs/common';

// Owned by the slice 6 part B (admission with idempotency, readmission; contracts/slice-6.md) agent. Registered in AppModule by the main thread so the
// parallel agents never edit app.module.ts.
@Module({})
export class AdmissionsModule {}
