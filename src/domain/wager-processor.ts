import { InsufficientFundsError } from './errors';
import { FailureCode } from './failure-codes';
import type { LedgerEntry } from './ledger-entry';
import type { Wallet } from './wallet';
import { REVERSIBLE_TARGETS, type WagerTransaction } from './wager-transaction';

export interface ProcessingInput {
  /** Transaction in PENDING or PENDING_REFERENCE status. */
  transaction: WagerTransaction;
  /** Wallet of the transaction, already locked by the caller. */
  wallet: Wallet;
  /** Transaction referenced by a REFUND/ROLLBACK, resolved by (provider, referenceExternalId). */
  reference: WagerTransaction | null;
  /** Whether the reference already has a PROCESSED reversal. */
  referenceAlreadyReversed: boolean;
  now: Date;
}

export type ProcessingOutcome =
  | { type: 'PROCESSED'; ledgerEntry: LedgerEntry | null }
  | { type: 'REJECTED'; code: FailureCode }
  | { type: 'AWAITING_REFERENCE' };

/**
 * Pure business rules. Mutates the transaction and the wallet aggregate in
 * memory; persisting the result is the caller's job (inside one SQL transaction).
 */
export function processWager(input: ProcessingInput): ProcessingOutcome {
  const { transaction: tx, wallet, now } = input;

  switch (tx.kind) {
    case 'OPENING':
    case 'WIN': {
      const entry = wallet.credit(tx.amount, tx.id, now);
      tx.markProcessed({ walletId: wallet.id, balanceAfter: wallet.balance, now });
      return { type: 'PROCESSED', ledgerEntry: entry };
    }

    case 'LOSS': {
      tx.markProcessed({ walletId: wallet.id, balanceAfter: wallet.balance, now });
      return { type: 'PROCESSED', ledgerEntry: null };
    }

    case 'BET': {
      if (!wallet.canDebit(tx.amount)) {
        return reject(input, FailureCode.INSUFFICIENT_FUNDS, 'Insufficient funds for bet');
      }
      const entry = wallet.debit(tx.amount, tx.id, now);
      tx.markProcessed({ walletId: wallet.id, balanceAfter: wallet.balance, now });
      return { type: 'PROCESSED', ledgerEntry: entry };
    }

    case 'REFUND':
    case 'ROLLBACK':
      return processReversal(input, tx.kind);
  }
}

function processReversal(input: ProcessingInput, kind: 'REFUND' | 'ROLLBACK'): ProcessingOutcome {
  const { transaction: tx, wallet, reference: ref, now } = input;

  if (!ref || ref.status === 'PENDING' || ref.status === 'PENDING_REFERENCE') {
    return { type: 'AWAITING_REFERENCE' };
  }
  if (ref.status !== 'PROCESSED') {
    return reject(input, FailureCode.REFERENCE_NOT_PROCESSED, `Referenced transaction is ${ref.status}`, ref.id);
  }
  if (!REVERSIBLE_TARGETS[kind].includes(ref.kind)) {
    return reject(input, FailureCode.INVALID_REFERENCE_TYPE, `${kind} cannot target a ${ref.kind}`, ref.id);
  }
  if (ref.currency !== tx.currency) {
    return reject(input, FailureCode.CURRENCY_MISMATCH, 'Reference currency differs', ref.id);
  }
  if (ref.walletId !== wallet.id || ref.playerId !== tx.playerId || ref.roundId !== tx.roundId) {
    return reject(input, FailureCode.REFERENCE_MISMATCH, 'Reference belongs to another player, wallet or round', ref.id);
  }
  if (!ref.amount.equals(tx.amount)) {
    return reject(input, FailureCode.AMOUNT_MISMATCH, 'Reversal amount must equal the original amount', ref.id);
  }
  if (input.referenceAlreadyReversed) {
    return reject(input, FailureCode.ALREADY_REVERSED, 'Referenced transaction was already reversed', ref.id);
  }

  let entry: LedgerEntry;
  if (ref.kind === 'BET') {
    // Reversing a debit gives the stake back.
    entry = wallet.credit(tx.amount, tx.id, now);
  } else {
    // Reversing a credit (WIN / REFUND) takes the money back.
    try {
      entry = wallet.debit(tx.amount, tx.id, now);
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        return reject(input, FailureCode.INSUFFICIENT_FUNDS_FOR_REVERSAL, 'Insufficient funds to reverse a credit', ref.id);
      }
      throw error;
    }
  }
  tx.markProcessed({ walletId: wallet.id, balanceAfter: wallet.balance, referenceTransactionId: ref.id, now });
  return { type: 'PROCESSED', ledgerEntry: entry };
}

function reject(
  input: ProcessingInput,
  code: FailureCode,
  reason: string,
  referenceTransactionId: string | null = null,
): ProcessingOutcome {
  input.transaction.reject({ code, reason, walletId: input.wallet.id, referenceTransactionId, now: input.now });
  return { type: 'REJECTED', code };
}
