import { loadConfig } from '../../config';
import { createSqsClient, ensureQueues } from './sqs';

/** CLI: creates the SQS queues (useful outside docker compose, which creates them on start-up). */
const settings = loadConfig().sqs;
const urls = await ensureQueues(createSqsClient(settings), settings);
console.log('Queues ready', urls);
