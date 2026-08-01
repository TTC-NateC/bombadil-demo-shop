import { PrismaClient } from "@prisma/client";

// Singleton, guarded against Next's dev hot-reload creating a new client (and a
// new connection pool) on every module invalidation.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
