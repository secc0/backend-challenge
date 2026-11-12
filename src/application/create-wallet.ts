import { eventsFor } from '../domain/events';
import { Money } from '../domain/money';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { processWager } from '../domain/wager-processor';
import type { Database } from '../infrastructure/database/database';
import { isUniqueViolation, transientKind } from '../infrastructure/database/db-errors';
import type { OutboxRepository } from '../infrastructure/persistence/outbox.repository';
import type { WagerTransactionRepository } from '../infrastructure/persistence/wager-transaction.repository';
import type { WalletRepository } from '../infrastructure/persistence/wallet.repository';
import { payloadHash } from './canonical-json';
import type { CreateWalletCommand } from './commands';
import { TransientError, WalletAlreadyExistsError } from './errors';

export const OPENING_PROVIDER = 'internal';

/**
 * Creates a wallet and, when an opening balance is given, credits it through
 * an OPENING transaction + ledger entry, all in the same SQL transaction.
 */
export class CreateWallet {
  constructor(
    private readonly db: Database,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly outbox: OutboxRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(command: CreateWalletCommand, correlationId: string | null): Promise<Wallet> {
    const now = this.clock();
    const wallet = Wallet.create({ playerId: command.playerId, currency: command.currency, now });
    const opening = command.openingBalance ? Money.of(command.openingBalance, command.currency) : null;

    try {
      await this.db.transaction(async (sql) => {
        await this.wallets.insert(sql, wallet);
        if (opening && opening.isPositive()) {
          const externalId = `opening:${wallet.id}`;
          const tx = WagerTransaction.create({
            idempotencyKey: externalId,
            payloadHash: payloadHash({ walletId: wallet.id, amount: opening.toString(), currency: opening.currency }),
            provider: OPENING_PROVIDER,
            externalId,
            playerId: wallet.playerId,
            roundId: null,
            kind: 'OPENING',
            amount: opening,
            now,
          });
          const outcome = processWager({ transaction: tx, wallet, reference: null, referenceAlreadyReversed: false, now });
          await this.transactions.insert(sql, tx);
          await this.wallets.saveChanges(sql, wallet);
          const entry = outcome.type === 'PROCESSED' ? outcome.ledgerEntry : null;
          await this.outbox.append(sql, eventsFor(tx, wallet, entry, now), correlationId);
        }
      });
    } catch (error) {
      if (isUniqueViolation(error, ['wallets_player_currency_uq'])) {
        const existing = await this.wallets.findByPlayerAndCurrency(this.db.reader(), command.playerId, command.currency);
        throw new WalletAlreadyExistsError(existing?.id ?? 'unknown');
      }
      const kind = transientKind(error);
      if (kind) throw new TransientError('Temporary infrastructure failure, retry later', kind, error);
      throw error;
    }
    return wallet;
  }
}
