import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import pino, { DestinationStream } from 'pino';
import type { IncomingMessage } from 'node:http';
import { ENV, Env } from '../config/env';

// A CNIC/B-Form with dashes, or any run of 13+ digits (a CNIC/B-Form without them).
const IDENTITY_NUMBER = /\d{5}-\d{7}-\d|\d{13,}/g;

/** Where log lines go. Tests override this token to capture output. */
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');

/**
 * Masks identity numbers in the final serialised line, so no field, message, URL or error
 * text can carry one into the logs whatever its shape. Timestamps are ISO strings (below)
 * because epoch milliseconds are themselves 13 digits.
 */
export function scrubbingStream(destination: DestinationStream): DestinationStream {
  return { write: (line: string) => destination.write(line.replace(IDENTITY_NUMBER, '[id]')) };
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      providers: [{ provide: LOG_DESTINATION, useFactory: () => pino.destination(1) }],
      inject: [ENV, LOG_DESTINATION],
      useFactory: (env: Env, destination: DestinationStream) => ({
        pinoHttp: [
          {
            level: env.NODE_ENV === 'production' ? 'info' : 'debug',
            timestamp: pino.stdTimeFunctions.isoTime,
            // Bind only the id to every line logged during a request, under one key.
            quietReqLogger: true,
            customAttributeKeys: { reqId: 'requestId' },
            genReqId: (req: IncomingMessage) => req.id,
            // Request bodies are never logged (pino-http's serializer omits them); these
            // cover the headers and any object a log call passes in.
            redact: {
              paths: [
                'req.headers.cookie',
                'req.headers.authorization',
                'res.headers["set-cookie"]',
                '*.password',
                '*.cnic',
                '*.bForm',
                '*.token',
              ],
              censor: '[redacted]',
            },
          },
          scrubbingStream(destination),
        ],
      }),
    }),
  ],
})
export class LoggingModule {}
