import { ChargeRepository } from '../../repositories/charge.repository';
import { FinanceReportRepository } from '../../repositories/finance-report.repository';
import { PaymentRepository } from '../../repositories/payment.repository';

export const repositories = [ChargeRepository, FinanceReportRepository, PaymentRepository];
