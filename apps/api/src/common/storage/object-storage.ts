import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { ENV, type Env } from '../../config/env';

// The private object store (S3 in production, MinIO locally) behind three operations: put, a
// streamed get and delete (plan §5 slice 6). There is deliberately no presigned-URL method: the
// API streams every download itself after its capability and scope checks (R43).
//
// Encryption at rest: production requests SSE-S3 on every object (and the bucket should enforce
// it by default). A local MinIO without a KMS refuses the SSE header, so it is sent only when
// NODE_ENV is production.

export interface StoredObject {
  body: Readable;
  contentLength: number | null;
}

/** The object does not exist (deleted, or never written). */
export class ObjectNotFoundError extends Error {
  override readonly name = 'ObjectNotFoundError';
}

const isMissing = (error: unknown): boolean =>
  error instanceof S3ServiceException &&
  (error.name === 'NoSuchKey' ||
    error.name === 'NotFound' ||
    error.$metadata.httpStatusCode === 404);

@Injectable()
export class ObjectStorage implements OnModuleDestroy {
  private readonly logger = new Logger('ObjectStorage');
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly production: boolean;
  private bucketReady: Promise<void> | undefined;

  constructor(@Inject(ENV) env: Env) {
    this.bucket = env.S3_BUCKET;
    this.production = env.NODE_ENV === 'production';
    this.client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      // MinIO and most S3-compatible stores address buckets by path, not by subdomain.
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
      maxAttempts: 2,
    });
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
        ...(this.production ? { ServerSideEncryption: 'AES256' as const } : {}),
      }),
    );
  }

  /** The object as a stream. ObjectNotFoundError if it does not exist. */
  async get(key: string): Promise<StoredObject> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!(out.Body instanceof Readable)) throw new Error('object body is not a Node stream');
      return { body: out.Body, contentLength: out.ContentLength ?? null };
    } catch (error) {
      if (isMissing(error)) throw new ObjectNotFoundError();
      throw error;
    }
  }

  /** Idempotent: deleting an absent object succeeds (S3 semantics). */
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * Outside production the bucket is created on first write if missing (local MinIO, CI). In
   * production it is provisioned with its policy and default encryption, and only checked.
   */
  private ensureBucket(): Promise<void> {
    this.bucketReady ??= this.createBucketIfMissing().catch((error: unknown) => {
      this.bucketReady = undefined;
      throw error;
    });
    return this.bucketReady;
  }

  private async createBucketIfMissing(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error) {
      if (!isMissing(error) || this.production) throw error;
    }
    this.logger.warn({ bucket: this.bucket }, 'object storage bucket missing; creating it');
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      // Another process created it first.
      if (!(error instanceof S3ServiceException && error.name === 'BucketAlreadyOwnedByYou')) {
        throw error;
      }
    }
  }
}
