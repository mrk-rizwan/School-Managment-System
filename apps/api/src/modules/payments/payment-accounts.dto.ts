import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, ValidateBy } from 'class-validator';
import {
  PAYMENT_ACCOUNT_KINDS,
  PAYMENT_ACCOUNT_STATUSES,
  type PaymentAccountKind,
  type PaymentAccountStatus,
} from '@asms/shared';
import { IfPresent, NameField } from '../../common/fields';
import { PageQueryDto } from '../../common/pagination';

// phase-3-financial.md slice 18; rule 21.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const KIND = { enum: PAYMENT_ACCOUNT_KINDS, enumName: 'PaymentAccountKind' } as const;

/** Letters, digits and dashes, 4-34 (CHECK school_payment_accounts_account_no_check). */
export const ACCOUNT_NO_PATTERN = /^[0-9A-Za-z-]{4,34}$/;

/** 13 digits, plain or dashed 5-7-1: an identity number, never an account number. */
const IDENTITY_SHAPED = /^([0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9])$/;

export class PaymentAccountDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(KIND)
  kind: PaymentAccountKind;

  /** The account holder's name. */
  @ApiProperty()
  title: string;

  @ApiProperty()
  accountNo: string;

  @ApiProperty({ type: String, nullable: true })
  bankName: string | null;

  @ApiProperty({ enum: PAYMENT_ACCOUNT_STATUSES, enumName: 'PaymentAccountStatus' })
  status: PaymentAccountStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  disabledAt: Date | null;

  @ApiProperty({ type: String, nullable: true })
  disableReason: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** What a guardian sees: where to pay, nothing about who set it up. */
export class MyPaymentAccountDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(KIND)
  kind: PaymentAccountKind;

  @ApiProperty()
  title: string;

  @ApiProperty()
  accountNo: string;

  @ApiProperty({ type: String, nullable: true })
  bankName: string | null;
}

export class ListPaymentAccountsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: PAYMENT_ACCOUNT_STATUSES, enumName: 'PaymentAccountStatus' })
  @IsOptional()
  @IsIn(PAYMENT_ACCOUNT_STATUSES)
  status?: PaymentAccountStatus;
}

/** Spaces dropped and letters upper-cased: `pk36 scbl 0000` and `PK36SCBL0000` are one account. */
const compactUpper = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : value;

export class CreatePaymentAccountDto {
  @ApiProperty(KIND)
  @IsIn(PAYMENT_ACCOUNT_KINDS)
  kind: PaymentAccountKind;

  @ApiProperty({ minLength: 1, maxLength: 100, description: "The account holder's name" })
  @NameField(1, 100)
  title: string;

  @ApiProperty({
    pattern: ACCOUNT_NO_PATTERN.source,
    description: 'Spaces removed and letters upper-cased; never shaped like an identity number',
  })
  @Transform(compactUpper)
  @IsString()
  @Matches(ACCOUNT_NO_PATTERN, { message: 'accountNo must be 4-34 letters, digits or dashes' })
  @ValidateBy({
    name: 'notIdentityShaped',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && !IDENTITY_SHAPED.test(value),
      defaultMessage: () => 'accountNo must not be an identity number',
    },
  })
  accountNo: string;

  /** Banks only. */
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @IfPresent()
  @NameField(1, 100)
  bankName?: string;
}
