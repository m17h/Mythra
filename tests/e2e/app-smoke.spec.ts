import { expect, test, _electron as electron } from '@playwright/test';

test('launches the Electron app shell', async () => {
  const app = await electron.launch({ args: ['.'] });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle(/Mythra/);
  } finally {
    await app.close();
  }
});
