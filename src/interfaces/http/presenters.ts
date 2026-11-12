import type { LedgerEntry } from '../../domain/ledger-entry';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';

/** HTTP representations. Money always travels as decimal strings. */

export function presentWallet(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toString(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function presentLedgerEntry(entry: LedgerEntry) {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    sequence: entry.sequence,
    direction: entry.direction,
    amount: entry.amount.toString(),
    currency: entry.amount.currency,
    balanceBefore: entry.balanceBefore.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    createdAt: entry.createdAt.toISOString(),
  };
}

export function presentTransaction(tx: WagerTransaction) {
  return {
    id: tx.id,
    provider: tx.provider,
    externalId: tx.externalId,
    idempotencyKey: tx.idempotencyKey,
    type: tx.kind,
    status: tx.status,
    failureCode: tx.failureCode,
    failureReason: tx.failureReason,
    playerId: tx.playerId,
    walletId: tx.walletId,
    roundId: tx.roundId,
    amount: tx.amount.toString(),
    currency: tx.currency,
    balanceAfter: tx.balanceAfter?.toString() ?? null,
    referenceExternalId: tx.referenceExternalId,
    referenceTransactionId: tx.referenceTransactionId,
    referenceExpiresAt: tx.referenceExpiresAt?.toISOString() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}

/**
 * Status code for a submitted transaction. A replay returns the same code as
 * the original execution (plus the `Idempotent-Replayed: true` header).
 *   201 PROCESSED · 202 PENDING_REFERENCE/PENDING · 422 REJECTED/FAILED
 */
export function statusCodeFor(tx: WagerTransaction): number {
  switch (tx.status) {
    case 'PROCESSED':
      return 201;
    case 'PENDING':
    case 'PENDING_REFERENCE':
      return 202;
    case 'REJECTED':
    case 'FAILED':
      return 422;
  }
}
