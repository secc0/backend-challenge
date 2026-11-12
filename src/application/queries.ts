import type { LedgerEntry } from '../domain/ledger-entry';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { Database } from '../infrastructure/database/database';
import type { WagerTransactionRepository } from '../infrastructure/persistence/wager-transaction.repository';
import type { WalletRepository } from '../infrastructure/persistence/wallet.repository';
import { NotFoundError } from './errors';

export interface LedgerPage {
  items: LedgerEntry[];
  nextCursor: string | null;
}

/** Read side. Reads run in autocommit mode and never take locks. */
export class WalletQueries {
  constructor(
    private readonly db: Database,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
  ) {}

  async wallet(id: string): Promise<Wallet> {
    const wallet = await this.wallets.findById(this.db.reader(), id);
    if (!wallet) throw new NotFoundError(`Wallet ${id} not found`);
    return wallet;
  }

  /** Newest first. The cursor is the sequence of the last item returned. */
  async ledger(walletId: string, options: { limit: number; cursor?: string }): Promise<LedgerPage> {
    await this.wallet(walletId);
    const beforeSequence = options.cursor !== undefined ? decodeCursor(options.cursor) : undefined;
    const items = await this.wallets.ledgerPage(this.db.reader(), walletId, {
      limit: options.limit + 1,
      beforeSequence,
    });
    const hasMore = items.length > options.limit;
    const page = hasMore ? items.slice(0, options.limit) : items;
    const last = page[page.length - 1];
    return { items: page, nextCursor: hasMore && last ? encodeCursor(last.sequence) : null };
  }

  async transaction(id: string): Promise<WagerTransaction> {
    const tx = await this.transactions.findById(this.db.reader(), id);
    if (!tx) throw new NotFoundError(`Transaction ${id} not found`);
    return tx;
  }

  async transactionByProviderId(provider: string, externalId: string): Promise<WagerTransaction> {
    const tx = await this.transactions.findByProviderExternalId(this.db.reader(), provider, externalId);
    if (!tx) throw new NotFoundError(`Transaction ${provider}/${externalId} not found`);
    return tx;
  }
}

function encodeCursor(sequence: number): string {
  return Buffer.from(`seq:${sequence}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^seq:(\d+)$/.exec(decoded);
  if (!match?.[1]) throw new NotFoundError('Invalid cursor');
  return Number(match[1]);
}
