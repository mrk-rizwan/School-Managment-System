// A planted write repository (slice 45): the support module writes nothing but its own sessions
// and audit rows, through SupportSessionRepository.
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { PlatformAuditRepository } from '../../repositories/platform/platform-audit.repository';

export const repositories = [AuditLogRepository, PlatformAuditRepository];
