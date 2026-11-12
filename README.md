# Wagering Processor

Serviço que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de vários provedores de jogos, via HTTP e SQS. Ele garante correção financeira com várias instâncias rodando em paralelo: idempotência persistente, ledger imutável, saldo nunca negativo, inbox e outbox transacional.

**Stack:** Bun · TypeScript (strict) · NestJS · MikroORM · PostgreSQL 16 · SQS (LocalStack) · Docker Compose

As decisões de design, os trade-offs e as limitações estão em **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

## Requisitos

- [Bun](https://bun.sh) ≥ 1.4
- Docker + Docker Compose

## Subindo localmente

```bash
# 1. Infra: PostgreSQL (porta 55432) e LocalStack/SQS (porta 4566).
#    As filas são criadas automaticamente pelo LocalStack.
docker compose up -d postgres localstack

# 2. Dependências e migrations
bun install
cp .env.example .env
bun run migrate:up

# 3. Aplicação (API + consumer SQS + outbox publisher + worker de referências)
bun run start          # http://localhost:3000
```

> O PostgreSQL usa a porta **55432** no host para não conflitar com uma instalação local na 5432.

### Stack completa em containers (2 instâncias)

```bash
docker compose --profile app up -d --build
# app-1 → http://localhost:3001   app-2 → http://localhost:3002
```

O serviço `migrate` aplica as migrations antes de as instâncias subirem. As duas instâncias rodam todos os workers ao mesmo tempo, contra o mesmo banco e as mesmas filas.

## Comandos

| Comando | Descrição |
|---|---|
| `bun run start` | Sobe a aplicação |
| `bun run dev` | Sobe com watch |
| `bun run migrate:up` / `migrate:down` / `migrate:status` | Migrations (reversíveis) |
| `bun run sqs:setup` | Cria as filas (fora do compose) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test` | Todas as suítes |
| `bun run test:unit` | Unitários (não precisam de infra) |
| `bun run test:integration` | Integração com PostgreSQL e LocalStack reais |
| `bun run test:concurrency` | Concorrência com dois pools e dois processos reais |
| `bun run test:load` | Teste de carga (opcional, ver abaixo) |

Os testes de integração e concorrência precisam de `docker compose up -d postgres localstack`. Eles usam o banco `wagering_test` (criado pelo `docker/postgres/init.sql`) e filas com nome único por suíte, então nunca tocam nos dados de desenvolvimento.

## API

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | Cria carteira; `openingBalance` opcional gera um crédito `OPENING` na mesma transação SQL |
| `GET` | `/wallets/:id` | Saldo e versão |
| `GET` | `/wallets/:id/ledger?limit=50&cursor=` | Ledger paginado (keyset, do mais recente para o mais antigo) |
| `GET` | `/wallets/:id/reconciliation` | Conciliação de uma carteira |
| `POST` | `/transactions` | Submete transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/transactions/:id` | Consulta por id interno |
| `GET` | `/providers/:provider/transactions/:externalId` | Consulta por id do provider |
| `GET` | `/reconciliation?walletId=` | Conciliação (só reporta divergências, não corrige) |
| `GET` | `/health/live`, `/health/ready` | Liveness / readiness |
| `GET` | `/metrics` | Métricas Prometheus |

### Exemplo

```bash
curl -s -XPOST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","currency":"BRL","openingBalance":"100.00"}'

curl -s -i -XPOST localhost:3000/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: pg-123' \
  -d '{"provider":"pg","externalId":"123","playerId":"player-1","currency":"BRL","roundId":"r-1","type":"BET","amount":"80.00"}'

# Reversão: referencia o externalId da original
curl -s -i -XPOST localhost:3000/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: pg-124' \
  -d '{"provider":"pg","externalId":"124","playerId":"player-1","currency":"BRL","roundId":"r-1","type":"REFUND","amount":"80.00","referenceExternalId":"123"}'
```

Valores monetários são **sempre strings decimais** (`"80.00"`). Números são rejeitados. `LOSS` usa `"0.00"`.

| Resultado | Status |
|---|---|
| Processada | `201` (replay: mesmo status + `Idempotent-Replayed: true`) |
| Aguardando referência (`PENDING_REFERENCE`) | `202` |
| Rejeição de negócio (`failureCode`) | `422` |
| Payload inválido | `400` |
| Mesma chave, payload diferente | `409` |
| Falha transitória (repetir com a mesma chave) | `503` + `Retry-After` |

### Mensagens SQS

Fila `wager-transactions.fifo`. O corpo é o mesmo JSON do `POST /transactions`, mais um `idempotencyKey` opcional (o padrão é `provider:externalId`). Os eventos publicados pelo outbox vão para a fila `wager-events`.

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id player-1 --message-deduplication-id pg-125 \
  --message-body '{"provider":"pg","externalId":"125","playerId":"player-1","currency":"BRL","roundId":"r-2","type":"WIN","amount":"15.00"}'
```

## Configuração

Todas as variáveis têm valores padrão para desenvolvimento local (veja `.env.example` e `src/config.ts`). As principais:

| Variável | Padrão | Descrição |
|---|---|---|
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:55432/wagering` | |
| `DATABASE_LOCK_TIMEOUT_MS` | `5000` | Espera máxima pelo lock da carteira (depois disso, 503 / retry) |
| `SQS_ENDPOINT` | `http://localhost:4566` | `aws` para usar o endpoint real da AWS |
| `APP_WORKERS` | `consumer,outbox,pending-reference` | Workers desta instância (`none` = só HTTP) |
| `SQS_MAX_RECEIVE_COUNT` | `5` | Recebimentos antes de mandar para a DLQ |
| `PENDING_REFERENCE_TTL_MS` | `600000` | Tempo máximo esperando a transação original |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `20` | Tentativas máximas de resolver a referência |

## Teste de carga

`bun run test:load` sobe **duas instâncias** da aplicação (com o outbox publisher ativo) contra o banco de desenvolvimento. Ele cria 200 carteiras com 1000.00 cada, mais uma carteira "quente" compartilhada, e roda uma carga em *closed loop*: 64 clientes concorrentes durante 30s, alternando entre as instâncias. A composição é 55% BET, 20% WIN, 10% LOSS, 10% replays (mesma `Idempotency-Key`) e 5% BET na carteira quente (pior caso de contenção em um único lock). No fim ele roda a conciliação e grava um relatório em `load-test-results/`. Os parâmetros podem ser ajustados por variáveis `LOAD_TEST_*` (veja o cabeçalho do script).

**Resultado medido** (Windows 10, Ryzen 7 7700X 8C/16T, 32 GB; PostgreSQL e LocalStack no Docker Desktop; gerador de carga na mesma máquina):

| Métrica | Valor |
|---|---|
| Requisições | 35.837 em 30s (**~1.190 req/s**) |
| Latência p50 / p95 / p99 | 53 ms / 73 ms / 93 ms |
| Respostas | 34.106 × `201`, 1.731 × `422`, **0 erros 5xx / de rede** |
| Replays (p50 / p99) | 31 ms / 53 ms (respondidos sem tocar na carteira) |
| Carteira quente (p50 / p95 / p99) | 61 ms / 191 ms / 537 ms |
| Conciliação ao final | **consistente**, 0 divergências |

Leitura honesta dos números:

- Os `422` são esperados: a carteira quente esgota o saldo e passa a rejeitar com `INSUFFICIENT_FUNDS`.
- A cauda da carteira quente mostra o custo do lock por linha: operações da mesma carteira entram em fila no PostgreSQL. Carteiras diferentes não são afetadas.
- Como gerador de carga, aplicação e banco dividem a mesma máquina, isso é um teste de **sanidade sob carga**, não um benchmark de capacidade. Não houve tuning (pool padrão de 20 conexões por instância, PostgreSQL com configuração padrão da imagem).

## Estrutura

```
src/
  domain/            Money, Wallet, LedgerEntry, WagerTransaction, regras, eventos
  application/       casos de uso, validação, idempotência, conciliação
  infrastructure/    PostgreSQL (MikroORM, migrations, repositórios), SQS, observabilidade
  interfaces/http/   controllers NestJS, filtro de erros, guard de autenticação
  container.ts       composition root
  main.ts            bootstrap + graceful shutdown
test/
  unit/  integration/  concurrency/
scripts/load-test.ts
```
