# Arquitetura

Este documento explica as decisões de design, os trade-offs e as limitações conhecidas do processador de transações.

## 1. Visão geral

```
 Provider ──HTTP──► Controllers ──┐
                                  ├──► SubmitWagerTransaction ──► PostgreSQL (1 transação SQL)
 SQS FIFO ────────► WagerConsumer ┘     (mesmo caso de uso)         wallets
   └─ DLQ (FIFO)                                                    wager_transactions
                                                                    wallet_ledger_entries
                                                                    inbox_messages
                                                                    outbox_events
                                                                        │
 OutboxPublisher (N instâncias) ◄── FOR UPDATE SKIP LOCKED ─────────────┤
        └──► SQS wager-events                                           │
 PendingReferenceWorker (N instâncias) ◄── lease + SKIP LOCKED ─────────┘
```

Toda instância é idêntica e sem estado: roda a API HTTP e, conforme `APP_WORKERS`, o consumer SQS, o publisher do outbox e o worker de referências pendentes. Coordenação entre instâncias acontece **somente** pelo PostgreSQL (locks de linha, constraints e `SKIP LOCKED`). Não há lock global, cache local nem estado em memória que afete a correção.

### Camadas

| Camada | Pasta | Responsabilidade |
|---|---|---|
| Domínio | `src/domain` | `Money`, `Wallet` (aggregate root), `LedgerEntry`, `WagerTransaction`, regras (`wager-processor.ts`), eventos. Sem dependência de framework. Entidades com construtor privado + `create`/`rehydrate`. |
| Aplicação | `src/application` | Casos de uso: submissão, criação de carteira, resolução de referências pendentes, consultas, conciliação. Orquestram a transação SQL. |
| Infraestrutura | `src/infrastructure` | MikroORM/PostgreSQL, repositórios, SQS (consumer, outbox publisher), logs, métricas. |
| Interfaces | `src/interfaces/http` | Controllers NestJS, mapeamento de erros para status HTTP, guard de autenticação. |

`src/container.ts` é o *composition root*: monta o grafo de objetos com código simples. O Nest recebe o container pronto, e os testes montam exatamente o mesmo grafo sem subir o Nest.

## 2. Autenticação (opcional, não implementada)

**Decisão:** não integrei um IdP. O desafio marca autenticação como opcional e sem pontuação. Preferi investir o tempo nas garantias financeiras.

**Ponto de extensão:** `AuthGuard` (`src/interfaces/http/auth.guard.ts`) já está registrado como guard global e intercepta toda rota não marcada com `@Public()`. Para integrar Keycloak/Zitadel basta implementar `authenticate()`: validar o JWT (assinatura via JWKS do provedor, `iss`, `aud`, `exp`) e, se quisermos autorização por provider, comparar o `provider` do token com o do payload. Nenhum controller precisa mudar.

- `GET /health/live`, `GET /health/ready` e `GET /metrics` são `@Public()`.
- Mensagens da fila são tratadas como canal interno confiável (a proteção é IAM/política da fila) e não passam pelo guard.

## 3. ORM: MikroORM

O MikroORM fornece o **pool de conexões, a demarcação de transações (`em.transactional`) e o Migrator** (migrations versionadas e reversíveis, com `up` e `down`).

Os repositórios escrevem **SQL explícito** via `em.execute` em vez de usar a unit of work com entidades decoradas. Fiz isso de propósito: os caminhos críticos dependem de detalhes que precisam ficar visíveis e revisáveis no código:

- `SELECT ... FOR UPDATE` na carteira (ordem de locks);
- `FOR UPDATE SKIP LOCKED` no outbox e no worker de referências;
- `INSERT ... ON CONFLICT DO NOTHING` no inbox;
- `UPDATE ... WHERE version = ?` (compare-and-set);
- casts `CAST(? AS numeric)` para que dinheiro nunca passe por `number`.

Com isso as entidades de domínio ficam como classes puras, sem decorators de ORM, e o mapeamento linha↔entidade fica explícito em cada repositório (`mapWallet`, `mapTransaction`, ...).

**Trade-off:** perde-se change tracking e geração automática de SQL. Para um núcleo financeiro pequeno, a previsibilidade compensa.

## 4. Dinheiro

| Onde | Representação |
|---|---|
| Entrada/saída (HTTP, SQS, eventos) | string decimal: `"10.50"`. `number` é **rejeitado** (um float pode já ter perdido precisão antes de chegar). |
| Domínio | `Money`: imutável (`Object.freeze`), `bigint` em unidades mínimas + código da moeda; aritmética só entre moedas iguais; nunca negativo. |
| Banco | `NUMERIC(20,2)`. O driver `pg` devolve `NUMERIC`/`BIGINT` como string; os SELECTs fazem `::text` e os INSERTs `CAST(? AS numeric)`. |

Validação estrita: até 2 casas decimais, sem sinal, sem expoente, sem espaços, sem zeros à esquerda. A moeda é modelada (`CurrencyDefinition` com `scale`), mas só `BRL` é aceita (`SUPPORTED_CURRENCIES`). Para habilitar outra moeda basta incluí-la na lista. Uma carteira existe por `(player_id, currency)`.

## 5. Concorrência

**Unidade de concorrência: a carteira.** Toda operação que altera saldo segue a mesma sequência, dentro de **uma** transação `READ COMMITTED`:

1. `SET LOCAL lock_timeout` (padrão 5s) e `statement_timeout`.
2. (SQS) registra a mensagem no inbox.
3. Procura a transação por `Idempotency-Key` ou `(provider, externalId)`. Se já existe, responde como replay sem tocar na carteira.
4. **`SELECT ... FROM wallets WHERE player_id = ? AND currency = ? FOR UPDATE`**: lock pessimista da linha da carteira.
5. **Procura de novo** (uma duplicata concorrente pode ter commitado enquanto esperávamos o lock; em READ COMMITTED cada statement vê o último commit).
6. Aplica as regras de domínio em memória.
7. Persiste a transação, `UPDATE wallets ... WHERE id = ? AND version = ?` (compare-and-set, defesa em profundidade), os lançamentos do ledger e os eventos do outbox.
8. Commit.

### Por que lock pessimista e não otimista?

- Carteiras "quentes" (muitas apostas simultâneas do mesmo jogador) são o caso normal em jogos. Com lock otimista, a contenção vira tempestade de retries e latência imprevisível; com `FOR UPDATE` as operações simplesmente entram em fila no PostgreSQL.
- O lock é **por linha**: carteiras diferentes não se bloqueiam (há teste para isso).
- `SERIALIZABLE` também resolveria, mas gera falhas de serialização que exigem retry de toda a transação, e o lock explícito deixa a intenção mais clara.

### Defesas adicionais

- `version` com compare-and-set: se, por bug, alguém atualizar a carteira sem o lock, o update falha em vez de perder escrita.
- Constraints como árbitro final: `CHECK (balance >= 0)`, `UNIQUE(idempotency_key)`, `UNIQUE(provider, external_id)`, `UNIQUE(wallet_id, transaction_id)` e `UNIQUE(wallet_id, sequence)` no ledger, índice único parcial "uma reversão processada por original".
- Corridas resolvidas com retry: violação de unicidade nas constraints de idempotência (duas requisições idênticas criando a transação ao mesmo tempo quando a carteira não existe), deadlock e falha de serialização disparam retry da unidade de trabalho inteira (até 3x). O retry encontra a transação vencedora e responde como replay.
- `lock_timeout` estourado vira `TransientError` → HTTP 503 / mensagem volta para a fila. Métrica `wallet_lock_conflicts_total`.

### Ordem de locks e deadlocks

Sempre **carteira → transação**. O worker de referências pendentes primeiro "reivindica" o trabalho num commit curto (sem segurar lock de carteira), e depois, em outra transação, trava a carteira e só então a linha da transação pendente. O caminho de submissão nunca segura lock de transação esperando carteira, então não há ciclo.

### Cenário obrigatório

Saldo 100.00 e duas `BET` de 80.00 simultâneas: a segunda espera o lock, enxerga saldo 20.00 e é rejeitada com `INSUFFICIENT_FUNDS`. Resultado: saldo 20.00, um único débito no ledger. Isso é coberto por testes com dois pools de conexão no mesmo processo (repetido 25x) e com **dois processos separados** via HTTP.

## 6. Idempotência

- **Persistente** (tabela `wager_transactions`). Nada em memória, então vale entre instâncias e após restart (há teste).
- Duas chaves de identidade: o header `Idempotency-Key` (`UNIQUE`) e o id natural do provider `(provider, externalId)` (`UNIQUE`). Qualquer uma que bata identifica a mesma transação.
- **`payloadHash`**: SHA-256 (hex) do **JSON canônico** do payload de negócio:
  - chaves de objeto ordenadas por code point, sem espaços, membros `undefined` omitidos (no estilo RFC 8785 para os tipos que aceitamos);
  - campos: `provider, externalId, playerId, currency, roundId, type, amount, referenceExternalId`. O próprio `Idempotency-Key` **não** entra;
  - `amount` normalizado pelo `Money` (`"10.5"` e `"10.50"` são a mesma requisição).
- Mesma chave (ou mesmo `provider/externalId`) com o **mesmo hash** → replay: devolve o resultado original, com o mesmo status HTTP e o header `Idempotent-Replayed: true`. Isso vale também para rejeições: uma `BET` rejeitada por saldo continua rejeitada no replay, mesmo que o saldo tenha aumentado depois.
- Mesma chave com **hash diferente** → `409 IDEMPOTENCY_CONFLICT`, e nada é alterado.
- Na fila: se a mensagem não traz `idempotencyKey`, a chave é `provider:externalId`. Além disso o **inbox** `(consumer, message_id)` deduplica redeliveries da mesma mensagem.

## 7. Modelo e regras de negócio

### Estados

```
PENDING ──► PROCESSED | REJECTED
   └─────► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
```

`PROCESSED`, `REJECTED` e `FAILED` são finais. Um trigger impede qualquer `UPDATE` em transação final e qualquer alteração nos campos financeiros (`amount`, `kind`, `player_id`, ...). `DELETE` também é bloqueado. `PENDING` é o estado inicial em memória: a decisão acontece na mesma transação SQL, então nunca é persistido como estado intermediário.

### Efeito de cada tipo

| Tipo | Efeito | Observações |
|---|---|---|
| `OPENING` | crédito | interno, criado junto com a carteira (`openingBalance`), na mesma transação SQL |
| `BET` | débito | `INSUFFICIENT_FUNDS` se saldo < valor |
| `WIN` | crédito | |
| `LOSS` | nenhum | `amount` deve ser `0.00`, sem lançamento no ledger (só fecha a rodada) |
| `REFUND` | crédito | só referencia `BET` |
| `ROLLBACK` | crédito se a referência é `BET`, débito se é `WIN`/`REFUND` | `INSUFFICIENT_FUNDS_FOR_REVERSAL` se faltar saldo para estornar um crédito |

### Referências (REFUND / ROLLBACK)

- Resolvidas por `(provider, referenceExternalId)`: um provider não enxerga transações de outro.
- Precisam bater carteira, jogador, moeda e rodada (`REFERENCE_MISMATCH` / `CURRENCY_MISMATCH`) e ter o mesmo valor (`AMOUNT_MISMATCH`).
- A referência precisa estar `PROCESSED` (`REFERENCE_NOT_PROCESSED`).
- **Uma original só pode ser revertida uma vez**, seja por REFUND ou por ROLLBACK (`ALREADY_REVERSED`). Isso é *mais restritivo* que "uma vez por tipo de operação": permitir REFUND **e** ROLLBACK da mesma BET devolveria a aposta duas vezes. O banco garante com o índice único parcial `wager_tx_single_reversal_uq`. Para desfazer um REFUND, faz-se ROLLBACK **do REFUND**.

### Referência ausente (entrega fora de ordem)

Se a original ainda não chegou, a transação fica `PENDING_REFERENCE` (HTTP 202, evento `WagerTransactionPendingReference`):

- O `PendingReferenceWorker` (roda em qualquer número de instâncias) reivindica lotes vencidos com `FOR UPDATE SKIP LOCKED` e empurra `next_reference_retry_at` como **lease** de 30s. Se a instância morrer, outra assume quando o lease expira.
- Backoff exponencial (`PENDING_REFERENCE_INITIAL_BACKOFF_MS`, máx. `..._MAX_BACKOFF_MS`).
- Quando a original é processada, as transações que a esperam são "acordadas" (`next_reference_retry_at = now()`) na mesma transação SQL.
- Limites: TTL (`PENDING_REFERENCE_TTL_MS`, padrão 10 min) **ou** número de tentativas (`PENDING_REFERENCE_MAX_ATTEMPTS`). Ao estourar → `FAILED` com `REFERENCE_NOT_FOUND`.

### Códigos de falha (estáveis)

`WALLET_NOT_FOUND`, `INSUFFICIENT_FUNDS`, `INSUFFICIENT_FUNDS_FOR_REVERSAL`, `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`, `INVALID_REFERENCE_TYPE`, `REFERENCE_MISMATCH`, `CURRENCY_MISMATCH`, `AMOUNT_MISMATCH`, `ALREADY_REVERSED`.

Uma transação para um jogador sem carteira é **persistida** como `REJECTED / WALLET_NOT_FOUND` (com `wallet_id` nulo). Assim, um replay depois que a carteira for criada continua devolvendo o resultado original, o que mantém a idempotência coerente.

## 8. Ledger

- Um lançamento por mudança de saldo (`CREDIT`/`DEBIT`), com `balance_before`, `balance_after` e `sequence` (= nova `version` da carteira).
- Append-only: trigger bloqueia `UPDATE` e `DELETE`; `CHECK` garante `balance_after = balance_before ± amount` e saldos ≥ 0.
- `version` só incrementa quando o saldo muda (LOSS e rejeições não incrementam).
- Partidas dobradas não foram implementadas (opcional). Cada lançamento é a perna da carteira; a contrapartida (conta do provider/casa) seria uma segunda tabela de contas sem mudança no fluxo.

**Conciliação** (`GET /reconciliation`, `GET /wallets/:id/reconciliation`) compara e **apenas reporta**: saldo vs. soma do ledger, saldo vs. último `balance_after`, `version` vs. número de lançamentos, continuidade da cadeia (`balance_before` = `balance_after` anterior, sequências sem buracos), e transações `PROCESSED` vs. lançamentos (exatamente um, mesmo valor; nenhum para LOSS/rejeitadas). Corrigir dado financeiro é decisão humana.

## 9. SQS

- Fila `wager-transactions.fifo` com `RedrivePolicy` para `wager-transactions-dlq.fifo` (`maxReceiveCount` = 5).
- **Não dependemos do FIFO para consistência.** O `MessageGroupId` ajuda a ordenar por carteira, mas a correção vem do lock, das constraints, do inbox e do `PENDING_REFERENCE` (há teste com o mesmo pagamento em grupos diferentes, processado por dois consumers ao mesmo tempo).
- O consumer chama **o mesmo caso de uso** da API.
- **Inbox** `(consumer, message_id)`: inserido na mesma transação SQL do efeito financeiro. Redelivery → `ON CONFLICT DO NOTHING` → replay.
- **Ack (DeleteMessage) só depois do commit.** Se o processo morrer entre commit e ack, a mensagem volta e o inbox a reconhece (teste "crash after commit").
- Classificação de erros:
  - **Negócio** (rejeição): é um resultado normal. Commit e ack.
  - **Permanente** (JSON inválido, payload inválido, conflito de idempotência): vai direto para a DLQ com os atributos `FailureReason`/`FailureMessage`, depois é removida da fila principal.
  - **Transitório** (lock timeout, deadlock, banco indisponível) ou inesperado: nada foi commitado. Não damos ack, aumentamos o visibility timeout (backoff `2^n` s, máx. 60s) e, ao atingir `SQS_MAX_RECEIVE_COUNT`, a mensagem vai para a DLQ (`RETRIES_EXHAUSTED`). A `RedrivePolicy` da fila é a segunda rede de proteção.
- **Graceful shutdown:** em `SIGTERM`/`SIGINT`, o long-poll é abortado, o lote em andamento termina, a API para de aceitar requisições e o pool é fechado. Há timeout de 25s. Mensagens não confirmadas simplesmente reaparecem.

## 10. Outbox transacional

- Eventos são gravados em `outbox_events` **na mesma transação SQL** de transação, saldo, ledger e inbox. Nada é publicado antes do commit.
- `OutboxPublisher`: `SELECT ... FOR UPDATE SKIP LOCKED LIMIT n` → `SendMessageBatch` → `published_at = now()` → commit. Vários publishers (em várias instâncias) nunca enviam a mesma linha ao mesmo tempo. Há teste com 4 publishers em 2 pools: cada evento chega exatamente uma vez.
- Falha no envio: `attempts++`, `last_error`, `next_attempt_at` com backoff.
- Garantia **at-least-once**: se o processo morrer depois do SQS aceitar e antes do commit, o lote é reenviado. Consumidores deduplicam por `eventId`.
- Eventos: envelope abstrato (`DomainEvent`: `eventId`, `eventType`, `eventVersion`, `aggregateType`, `aggregateId`, `occurredAt`, `correlationId`) com subclasses tipadas: `WagerTransactionProcessed`, `WagerTransactionRejected` (REJECTED e FAILED, distinguidos por `status`), `WagerTransactionPendingReference` e `WalletBalanceChanged` (só quando o saldo muda). Dinheiro sempre como string.
- Destino: fila standard `wager-events`.

## 11. Contrato HTTP

| Situação | Status |
|---|---|
| Transação processada (primeira vez ou replay) | `201` (+ `Idempotent-Replayed: true/false`) |
| Aceita mas aguardando referência | `202` |
| Rejeição de negócio / falha definitiva | `422` com `failureCode` |
| Payload inválido, header ausente, JSON malformado | `400 VALIDATION_ERROR` com `details` |
| Mesma chave com payload diferente | `409 IDEMPOTENCY_CONFLICT` |
| Carteira já existe | `409 WALLET_ALREADY_EXISTS` |
| Não encontrado | `404 NOT_FOUND` |
| Falha transitória (lock timeout, banco fora) | `503 TRANSIENT_FAILURE` + `Retry-After: 1`. O cliente deve repetir **com a mesma chave**. |

## 12. Observabilidade

- **Logs JSON** de uma linha por evento, com `correlationId` propagado por `AsyncLocalStorage` (`X-Correlation-Id` no HTTP; atributo `CorrelationId` ou `MessageId` no SQS), `instance`, `transactionId`, `walletId`, `status` e `failureCode`. Valores financeiros e payloads são **redigidos** (`amount`, `balance*`, `payload`, `body`, `authorization`).
- O `correlationId` também vai para o envelope dos eventos do outbox.
- **Métricas Prometheus** (`GET /metrics`): `wager_transactions_total{type,status,channel}`, `wager_rejections_total{failure_code}`, `wager_duplicates_total{channel,source}`, `wager_idempotency_conflicts_total`, `wallet_lock_conflicts_total{kind}`, `wager_processing_duration_seconds`, `http_request_duration_seconds`, `sqs_messages_total{result}`, `sqs_retries_total`, `sqs_dlq_total{reason}`, `outbox_pending_events`, `outbox_lag_seconds`, `outbox_published_total`, `outbox_publish_failures_total`, `pending_reference_resolutions_total{result}`.
- **Health:** `/health/live` (processo responde, sem checar dependências, para não reiniciar o pod quando o banco cai) e `/health/ready` (PostgreSQL + fila SQS acessíveis; `503` caso contrário).

## 13. Estratégia de testes

| Suíte | O que prova |
|---|---|
| `test/unit` | `Money`, invariantes da `Wallet`, todas as regras e códigos de falha, ciclo de vida da transação, eventos, JSON canônico e hash, validação de payload |
| `test/integration` | Contra **PostgreSQL e LocalStack reais**: migrations reversíveis, constraints/triggers, atomicidade (crash antes do commit não deixa rastro), idempotência (inclusive após restart), reversões, `PENDING_REFERENCE` (resolução, TTL, limite), inbox, crash após commit, retry → DLQ, mensagens venenosas, outbox com publishers concorrentes, contrato HTTP completo (inclusive 503 real por lock timeout), conciliação |
| `test/concurrency` | Paralelismo real: dois pools no mesmo processo **e dois processos da aplicação** via HTTP. Cenário 100/80 (25 repetições), 50 apostas idênticas, 50 apostas distintas, reversões concorrentes, carga mista em várias carteiras, ausência de lock global, consumers SQS competindo, **instância morta com SIGKILL no meio da carga** e clientes refazendo na outra |

Nenhum teste mocka PostgreSQL ou SQS. Os testes de integração e concorrência terminam verificando o invariante final: o saldo de cada carteira é igual ao reconstruído a partir do ledger (conciliação sem divergências).

## 14. Trade-offs e limitações conhecidas

- **Ordem dos eventos publicados:** com vários publishers e uma fila standard, eventos de uma mesma carteira podem chegar fora de ordem. `WalletBalanceChanged` traz `version`, então consumidores podem ordenar ou descartar versões antigas. Se a ordem estrita for requisito, publicar numa fila FIFO com `MessageGroupId = aggregateId` resolveria.
- **`TRUNCATE`** não é bloqueado pelos triggers (só `UPDATE`/`DELETE` por linha). Em produção a aplicação deveria usar um usuário sem privilégio de `TRUNCATE`/DDL. Os testes usam `TRUNCATE` entre casos.
- **Throughput por carteira** é limitado pelo lock da linha (operações da mesma carteira são serializadas). É o preço da correção, e foi medido no teste de carga (`HOT_BET`).
- **Criação de carteira** não aceita `Idempotency-Key`. Uma segunda criação para o mesmo jogador/moeda devolve `409` com o `walletId` existente, o que dá ao cliente o mesmo efeito prático.
- **Conciliação** é um scan completo. Para volumes grandes deveria ser incremental ou por janela de tempo.
- **LOSS** exige `amount = 0.00`. Se algum provider enviar o valor apostado, isso precisaria virar configuração por provider.
- **Partidas dobradas** e **autenticação** não foram implementadas (ambas opcionais), mas os pontos de extensão estão descritos acima.
- **LocalStack** está fixado em `3.8.1`, porque versões mais novas da imagem exigem token de licença.
