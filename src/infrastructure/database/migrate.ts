import { loadConfig } from '../../config';
import { Database } from './database';

/** CLI: bun src/infrastructure/database/migrate.ts up|down|status */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const db = await Database.connect(loadConfig().database);
  try {
    const migrator = db.orm.getMigrator();
    if (command === 'up') {
      const applied = await migrator.up();
      console.log(`Applied ${applied.length} migration(s)`, applied.map((m) => m.name));
    } else if (command === 'down') {
      const reverted = await migrator.down();
      console.log(`Reverted ${reverted.length} migration(s)`, reverted.map((m) => m.name));
    } else if (command === 'status') {
      console.log('Executed:', (await migrator.getExecutedMigrations()).map((m) => m.name));
      console.log('Pending:', (await migrator.getPendingMigrations()).map((m) => m.name));
    } else {
      throw new Error(`Unknown command ${command}`);
    }
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
