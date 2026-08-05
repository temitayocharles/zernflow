#!/usr/bin/env node

const baseUrl = (process.argv[2] || process.env.PRODUCTION_BASE_URL || '').replace(/\/$/, '');
if (!baseUrl || !baseUrl.startsWith('https://')) {
  console.error('Usage: node scripts/production-smoke.mjs https://your-production-host');
  process.exit(2);
}

const checks = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, pass: true, detail });
  } catch (error) {
    checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

for (const path of ['/', '/register', '/login', '/forgot-password', '/reset-password']) {
  await check(`GET ${path}`, async () => {
    const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
    if (response.status !== 200) throw new Error(`expected 200, received ${response.status}`);
    return { status: response.status };
  });
}

await check('protected dashboard redirect', async () => {
  const response = await fetch(`${baseUrl}/dashboard`, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (![302, 303, 307, 308].includes(response.status) || location !== '/login') {
    throw new Error(`expected redirect to /login, received ${response.status} ${location}`);
  }
  return { status: response.status, location };
});

await check('retired browser credential endpoint', async () => {
  const response = await fetch(`${baseUrl}/api/v1/channels/test-key`, {
    method: 'POST',
    redirect: 'manual',
  });
  const body = await response.json();
  if (response.status !== 410 || body.code !== 'browser_managed_credentials_retired') {
    throw new Error(`expected 410 browser_managed_credentials_retired, received ${response.status}`);
  }
  const forbidden = ['token', 'secret', 'apiKey', 'credential'];
  if (Object.keys(body).some((key) => forbidden.includes(key))) {
    throw new Error('response exposed a forbidden secret-bearing field');
  }
  return { status: response.status, code: body.code, replacement: body.replacement };
});

const passed = checks.filter((item) => item.pass).length;
console.log(JSON.stringify({ passed, total: checks.length, allPassed: passed === checks.length, checks }, null, 2));
process.exit(passed === checks.length ? 0 : 1);
