import { createApp } from './app';
import { migrate, waitForDatabase } from './db';

const PORT = Number(process.env.PORT || 3000);

async function main(): Promise<void> {
  await waitForDatabase();
  await migrate();

  const app = createApp();
  app.listen(PORT, () => {
    console.log(`stowage-approval-service listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error('fatal: failed to start service', err);
  process.exit(1);
});
