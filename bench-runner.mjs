import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});

const page = await browser.newPage();

// Collect console output
page.on('console', msg => {
  const text = msg.text();
  if (text.startsWith('__benchResults')) {
    // skip the JSON dump, we'll get it via evaluate
  } else {
    console.log(text);
  }
});

page.on('pageerror', err => console.error('PAGE ERROR:', err.message));

console.log('Navigating to bench.html...');
await page.goto('http://localhost:3000/bench.html', { waitUntil: 'networkidle0', timeout: 10000 });

console.log('Starting benchmark...');
await page.click('.run-btn');

// Wait for results (up to 10 minutes)
const results = await page.waitForFunction(
  () => window.__benchResults,
  { timeout: 600000, polling: 2000 }
);

const data = await results.jsonValue();
console.log('\n=== MACHINE-READABLE RESULTS ===');
console.log(JSON.stringify(data, null, 2));

await browser.close();
process.exit(0);
