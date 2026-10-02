interface Raw {
  $queryRawUnsafe: (sql: string) => unknown;
  $executeRawUnsafe: (sql: string) => unknown;
}

export function reach(prisma: Raw): unknown[] {
  const read = prisma.$queryRawUnsafe('SELECT 1');
  const write = prisma['$executeRawUnsafe']('SELECT 1');
  const template = prisma[`$queryRawUnsafe`]('SELECT 1');
  const { $queryRawUnsafe } = prisma;
  const { ['$executeRawUnsafe']: execute } = prisma;
  const name = '$queryRawUnsafe';
  return [read, write, template, $queryRawUnsafe, execute, name];
}
