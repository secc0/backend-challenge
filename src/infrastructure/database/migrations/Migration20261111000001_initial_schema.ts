import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema. Every financial invariant that can be expressed in SQL is
 * enforced here, so a bug in application code cannot silently corrupt data:
 *  - balances / ledger balances are NUMERIC and CHECK >= 0;
 *  - uniqueness of idempotency keys, provider transaction ids, inbox messages,
 *    one ledger entry per (wallet, transaction) and per (wallet, sequence),
 *    and a single PROCESSED reversal per original transaction;
 *  - the ledger is append-only (UPDATE / DELETE raise an exception);
 *  - financial columns of a transaction are immutable and terminal statuses
 *    are final.
 */
export class Migration20261111000001InitialSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid PRIMARY KEY,
        player_id   varchar(128) NOT NULL,
        currency    char(3)      NOT NULL,
        balance     numeric(20, 2) NOT NULL DEFAULT 0,
        version     bigint       NOT NULL DEFAULT 0,
        created_at  timestamptz  NOT NULL DEFAULT now(),
        updated_at  timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_non_negative CHECK (version >= 0),
        CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                        uuid PRIMARY KEY,
        idempotency_key           varchar(255) NOT NULL,
        payload_hash              char(64)     NOT NULL,
        provider                  varchar(64)  NOT NULL,
        external_id               varchar(128) NOT NULL,
        player_id                 varchar(128) NOT NULL,
        currency                  char(3)      NOT NULL,
        wallet_id                 uuid NULL REFERENCES wallets(id),
        round_id                  varchar(128) NULL,
        kind                      varchar(16)  NOT NULL,
        amount                    numeric(20, 2) NOT NULL,
        reference_external_id     varchar(128) NULL,
        reference_transaction_id  uuid NULL REFERENCES wager_transactions(id),
        status                    varchar(24)  NOT NULL,
        failure_code              varchar(64)  NULL,
        failure_reason            text         NULL,
        balance_after             numeric(20, 2) NULL,
        reference_attempts        integer      NOT NULL DEFAULT 0,
        next_reference_retry_at   timestamptz  NULL,
        reference_expires_at      timestamptz  NULL,
        created_at                timestamptz  NOT NULL DEFAULT now(),
        updated_at                timestamptz  NOT NULL DEFAULT now(),
        processed_at              timestamptz  NULL,
        CONSTRAINT wager_tx_idempotency_key_uq UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider, external_id),
        CONSTRAINT wager_tx_kind_chk CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wager_tx_status_chk CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wager_tx_amount_non_negative CHECK (amount >= 0),
        CONSTRAINT wager_tx_balance_after_non_negative CHECK (balance_after IS NULL OR balance_after >= 0),
        CONSTRAINT wager_tx_reference_required CHECK (
          (kind IN ('REFUND','ROLLBACK')) = (reference_external_id IS NOT NULL)
        ),
        CONSTRAINT wager_tx_failure_code_chk CHECK (
          (status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)
        ),
        CONSTRAINT wager_tx_processed_has_wallet CHECK (status <> 'PROCESSED' OR wallet_id IS NOT NULL)
      );
    `);
    // An original transaction can be reversed (REFUND or ROLLBACK) at most once.
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND reference_transaction_id IS NOT NULL;
    `);
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_idx
        ON wager_transactions (next_reference_retry_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      CREATE INDEX wager_tx_waiting_for_reference_idx
        ON wager_transactions (provider, reference_external_id)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`CREATE INDEX wager_tx_wallet_idx ON wager_transactions (wallet_id, created_at);`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid PRIMARY KEY,
        wallet_id       uuid NOT NULL REFERENCES wallets(id),
        transaction_id  uuid NOT NULL REFERENCES wager_transactions(id),
        sequence        bigint NOT NULL,
        direction       varchar(6) NOT NULL,
        amount          numeric(20, 2) NOT NULL,
        currency        char(3) NOT NULL,
        balance_before  numeric(20, 2) NOT NULL,
        balance_after   numeric(20, 2) NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ledger_wallet_transaction_uq UNIQUE (wallet_id, transaction_id),
        CONSTRAINT ledger_wallet_sequence_uq UNIQUE (wallet_id, sequence),
        CONSTRAINT ledger_direction_chk CHECK (direction IN ('CREDIT','DEBIT')),
        CONSTRAINT ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT ledger_arithmetic_chk CHECK (
          balance_after = CASE direction WHEN 'CREDIT' THEN balance_before + amount ELSE balance_before - amount END
        )
      );
    `);

    this.addSql(`
      CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% blocked)', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_immutable
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
    `);

    this.addSql(`
      CREATE FUNCTION guard_wager_transaction_update() RETURNS trigger AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is final (%)', OLD.id, OLD.status
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
           OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
           OR NEW.provider IS DISTINCT FROM OLD.provider
           OR NEW.external_id IS DISTINCT FROM OLD.external_id
           OR NEW.player_id IS DISTINCT FROM OLD.player_id
           OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.round_id IS DISTINCT FROM OLD.round_id
           OR NEW.kind IS DISTINCT FROM OLD.kind
           OR NEW.amount IS DISTINCT FROM OLD.amount
           OR NEW.reference_external_id IS DISTINCT FROM OLD.reference_external_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'financial fields of wager transaction % are immutable', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard
        BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION guard_wager_transaction_update();
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_no_delete
        BEFORE DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer        varchar(128) NOT NULL,
        message_id      varchar(255) NOT NULL,
        transaction_id  uuid NULL REFERENCES wager_transactions(id),
        received_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (consumer, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_events (
        id               uuid PRIMARY KEY,
        position         bigserial NOT NULL UNIQUE,
        aggregate_type   varchar(64) NOT NULL,
        aggregate_id     uuid NOT NULL,
        event_type       varchar(128) NOT NULL,
        payload          jsonb NOT NULL,
        occurred_at      timestamptz NOT NULL,
        published_at     timestamptz NULL,
        attempts         integer NOT NULL DEFAULT 0,
        next_attempt_at  timestamptz NOT NULL DEFAULT now(),
        last_error       text NULL
      );
    `);
    this.addSql(`
      CREATE INDEX outbox_events_unpublished_idx
        ON outbox_events (next_attempt_at, position)
        WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_events;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP FUNCTION IF EXISTS guard_wager_transaction_update();');
    this.addSql('DROP FUNCTION IF EXISTS forbid_ledger_mutation();');
    this.addSql('DROP TABLE IF EXISTS wallets;');
  }
}
