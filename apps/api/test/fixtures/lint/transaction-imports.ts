import { Propagation, Transactional } from '@nestjs-cls/transactional';
import { TransactionHost } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';

export const reach = [Propagation, Transactional, TransactionHost, TransactionalAdapterPrisma];
