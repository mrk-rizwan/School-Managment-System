import { Module } from '@nestjs/common';
import { ObjectStorage } from './object-storage';

/** The object store. Imported by the modules that read or write document content. */
@Module({ providers: [ObjectStorage], exports: [ObjectStorage] })
export class StorageModule {}
