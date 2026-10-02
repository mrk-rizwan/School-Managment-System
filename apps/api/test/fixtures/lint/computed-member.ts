import type { GuardedPrismaClient } from './prisma';

export function reach(db: GuardedPrismaClient): unknown[] {
  const k = '$queryRawUnsafe';
  const viaVariable = db[k];
  const viaDollarLiteral = db['$transaction'];
  const viaReflect: unknown = Reflect.get(db, 'school');
  const byName = db['school'];
  const list = [1, 2];
  const byIndex = list[0];
  return [viaVariable, viaDollarLiteral, viaReflect, byName, byIndex];
}
