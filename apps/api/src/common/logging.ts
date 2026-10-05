import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import pino, { DestinationStream } from 'pino';
import type { IncomingMessage } from 'node:http';
import { ENV, Env } from '../config/env';

// A CNIC/B-Form split 5-7-1 by dashes, spaces, `+` or their URL encodings (`%20`, `%2B`, `%2D`),
// as a query string carries it; or any run of 13+ digits (a CNIC/B-Form without separators).
const SEPARATOR = String.raw`(?:[\s+-]|%20|%2B|%2D){1,3}`;
const IDENTITY_NUMBER = new RegExp(
  String.raw`\d{5}${SEPARATOR}\d{7}${SEPARATOR}\d|\d{13,}`,
  'gi',
);

/**
 * A Pakistani mobile in E.164 or local form (R111, slice 9): `+923001234567`, `923001234567`,
 * `03001234567`, also URL-encoded (`%2B92...`). As in provider error text, one space or dash may
 * follow the country code and the 3xx (`+92 300 1234567`, `0300-1234567`), the mobile scrubber's
 * coverage. The digit guards keep ids and timestamps whole. Phone numbers never reach a log line
 * unmasked.
 */
const PHONE_SEPARATOR = String.raw`(?:[\s-]|%20|%2D)?`;
export const PHONE_NUMBER = new RegExp(
  String.raw`(?:(?:\+|%2B)?92${PHONE_SEPARATOR}|(?<!\d)0)3\d{2}${PHONE_SEPARATOR}\d{7}(?!\d)`,
  'gi',
);

/** Where log lines go. Tests override this token to capture output. */
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');

/**
 * Masks identity numbers in the final serialised line, so no field, message, URL or error
 * text can carry one into the logs whatever its shape. Timestamps are ISO strings (below)
 * because epoch milliseconds are themselves 13 digits.
 */
export function scrubbingStream(destination: DestinationStream): DestinationStream {
  return {
    write: (line: string) =>
      destination.write(line.replace(IDENTITY_NUMBER, '[id]').replace(PHONE_NUMBER, '[phone]')),
  };
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
                // R173: an FCM registration token is a push address to one phone.
                '*.pushToken',
                '*.bearerToken',
                // contracts/slice-9.md §5.4, §5.5, §8.1: pairing QR, Meta token, provider bodies.
                '*.qr',
                '*.accessToken',
                '*.to',
                '*.from',
                '*.chatId',
                '*.body',
                '*.text',
                '*.phone',
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
