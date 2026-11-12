import 'reflect-metadata';

// Integration and concurrency suites run against the docker compose services,
// using a dedicated database so they never touch development data.
process.env.DATABASE_URL ??= 'postgres://wagering:wagering@localhost:55432/wagering_test';
process.env.SQS_ENDPOINT ??= 'http://localhost:4566';
process.env.AWS_REGION ??= 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.LOG_LEVEL ??= 'error';
