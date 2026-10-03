import { Inject, Injectable, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { ENV, type Env } from '../../config/env';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * SMTP options. Production refuses to send unless the server upgrades to TLS (STARTTLS), so a
 * stripped upgrade cannot leak reset and verify links in clear; local Mailpit has no TLS.
 */
export function smtpOptions(env: Pick<Env, 'NODE_ENV' | 'SMTP_HOST' | 'SMTP_PORT'>): SMTPTransport.Options {
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: false,
    requireTLS: env.NODE_ENV === 'production',
  };
}

const ATTEMPTS = 3;
const BACKOFF_MS = [500, 2_000];

/**
 * Outgoing mail (plan §2: in-process, after commit, three attempts with backoff). `send` never
 * rejects: a mail failure must not alter a response or committed state (R92). Failures are logged
 * without the address or the body, which may carry a token.
 */
@Injectable()
export class Mailer implements OnModuleDestroy {
  private readonly logger = new Logger('Mailer');
  #transport: Transporter | undefined;

  constructor(@Inject(ENV) private readonly env: Env) {}

  async send(message: MailMessage): Promise<void> {
    this.#transport ??= createTransport(smtpOptions(this.env));
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        await this.#transport.sendMail({ from: this.env.SMTP_FROM, ...message });
        return;
      } catch (error) {
        const code = error instanceof Error ? error.name : 'unknown';
        if (attempt === ATTEMPTS) {
          this.logger.error({ attempt, code, subject: message.subject }, 'mail not sent');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt - 1] ?? 2_000));
      }
    }
  }

  onModuleDestroy(): void {
    this.#transport?.close();
  }
}

@Module({ providers: [Mailer], exports: [Mailer] })
export class MailModule {}
