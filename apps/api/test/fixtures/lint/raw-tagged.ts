export const read = (prisma: { $queryRaw(strings: TemplateStringsArray): unknown }) =>
  prisma.$queryRaw`SELECT 1`;
