// Run with PLAYWRIGHT_PATH pointing to an installed Playwright package.
// Uses a local mock account/backend; never contacts the live project.
const { chromium, webkit } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const shim = `
window.supabase = {};
const cloud = window.PromptCloud;
const meta = cloud.normalizePrompt({id: 1, title: 'Test editor', text: 'Original system', section: 'workshop'});
let runs = [];
Object.assign(cloud, {
 configured: () => true, getSession: async () => ({user: {id:'test-user'}}),
 getUser: () => ({id:'test-user'}), startSession: async () => {}, onAuthChange: () => {},
 getPrompts: () => [meta], getRuns: () => runs,
 saveRun: async r => { runs.push(r); return r; },
 client: () => ({
   rpc: async (_, p) => window.mockRpc(p),
   from: () => ({ select(){return this}, eq(){return this}, order(){return this},
     range: async (a,b) => ({data: (await window.mockRows()).slice(a,b+1)}) })
 })
});
window.PromptSettings.writeCredentials({provider:'groq',keys:{groq:'fake-key'},models:{groq:'test-model'},effort:'high'});
`;
const runnerShim = `
window.PromptRunner.run = async ({onDelta, messages}) => {
 window.lastMessages = messages;
 onDelta('Generated response');
 if (window.holdRun) await new Promise(() => {});
 return {text:'Generated response', provider:'groq', requestedModel:'test-model', servedModel:'test-model',
 inputTokens:1,outputTokens:2,costUsd:0,durationMs:10};
};`;
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (!['index.html','style.css','settings.js','cloud.js','diff.js','markdown.js','runner.js','script.js','workshop.js','supabase-config.js'].includes(name)) {
      res.writeHead(404).end(); return;
    }
    let body = await readFile(path.join(root, name), 'utf8');
    // The production site is HTTPS. This fixture uses a loopback HTTP server;
    // WebKit otherwise upgrades its scripts to a nonexistent HTTPS listener.
    if (name === 'index.html') body = body.replace('; upgrade-insecure-requests', '');
    if (name === 'cloud.js') body += shim;
    if (name === 'runner.js') body += runnerShim;
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(body);
  } catch (err) { res.writeHead(500).end(err.message); }
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const [name, engine, mobile] of [['Chromium desktop',chromium,false],['WebKit mobile',webkit,true]]) {
    const browser = await engine.launch({headless:true,
      ...(engine === webkit && process.env.WEBKIT_EXECUTABLE_PATH ? {executablePath:process.env.WEBKIT_EXECUTABLE_PATH} : {})});
    try {
      const context = await browser.newContext(mobile ? {viewport:{width:390,height:844},isMobile:true,hasTouch:true} : {});
      await context.route('https://**/*', route => route.abort());
      const rows = new Map();
      await context.exposeFunction('mockRows', () => [...rows.values()]);
      await context.exposeFunction('mockRpc', p => {
        const old = rows.get(p.p_id);
        if (!old && !p.p_base || old?.token === p.p_base) {
          rows.set(p.p_id, {id:p.p_id,token:p.p_token,snapshot:p.p_snapshot,updated_at:new Date().toISOString()});
          return {data:true};
        }
        return {data:old?.token === p.p_token};
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', err => { errors.push(err.message); console.error(name, err.message); });
      await page.goto(url);
      await page.locator('#app-container').waitFor({state:'visible'}).catch(async error => {
        console.error(await page.locator('#login-error').textContent()); throw error;
      });
      await page.evaluate(() => document.querySelector('[data-section="workshop"]').click());
      await page.locator('#workshop-input').fill('Unsent before refresh');
      await page.waitForTimeout(400);
      await page.reload();
      await page.locator('#workshop-recover-btn').waitFor({state:'visible'});
      await page.locator('#workshop-recover-btn').click();
      await page.locator('#workshop-sessions').getByRole('button',{name:'Resume conversation',exact:true}).first().click();
      assert.equal(await page.locator('#workshop-input').inputValue(), 'Unsent before refresh');
      await page.locator('#workshop-run-btn').click();
      await page.waitForTimeout(400);
      await page.locator('#workshop-input').fill('Follow-up draft');
      await page.waitForTimeout(400);
      await page.reload();
      await page.locator('#workshop-recover-btn').click();
      await page.locator('#workshop-sessions').getByRole('button',{name:'Resume conversation',exact:true}).first().click();
      assert.equal(await page.locator('#workshop-input').inputValue(), 'Follow-up draft');
      assert.match(await page.locator('#workshop-thread').innerText(), /Generated response/);
      await page.locator('#workshop-run-btn').click();
      await page.waitForTimeout(300);
      const messages = await page.evaluate(() => window.lastMessages);
      assert.equal(messages.length, 3);
      assert.equal(messages[1].content, 'Generated response');
      assert.equal(messages[2].content, 'Follow-up draft');
      await page.evaluate(() => { window.holdRun = true; });
      await page.locator('#workshop-input').fill('Interrupted follow-up');
      await page.locator('#workshop-run-btn').click();
      await page.waitForTimeout(1200);
      const progress = page.locator('#live-progress [role="progressbar"]');
      const percent = Number(await progress.getAttribute('aria-valuenow'));
      assert.ok(percent > 0 && percent < 100, 'in-flight progress remains an estimate below completion');
      assert.match(await progress.getAttribute('aria-valuetext'), /Estimated progress/);
      assert.equal(await page.locator('#live-orb').count(), 0);
      await page.reload();
      await page.locator('#workshop-recover-btn').click();
      await page.locator('#workshop-sessions').getByRole('button',{name:'Resume conversation',exact:true}).first().click();
      assert.match(await page.locator('#workshop-thread').innerText(), /Interrupted request/);
      assert.equal(await page.locator('#workshop-stop-btn').isVisible(), false);
      await page.locator('#workshop-input').fill('Newest local draft');
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      await page.reload();
      await page.locator('#workshop-recover-btn').click();
      await page.locator('#workshop-sessions').getByRole('button',{name:'View history only',exact:true}).first().click();
      assert.equal(await page.locator('#workshop-input').inputValue(), '');
      assert.match(await page.locator('#run-detail-body').innerText(), /Newest local draft/);
      await page.evaluate(() => document.querySelector('#run-dialog').close());
      await page.locator('#workshop-sessions').getByRole('button',{name:'Resume conversation',exact:true}).first().click();
      assert.equal(await page.locator('#workshop-input').inputValue(), 'Newest local draft');
      await page.locator('#workshop-recover-btn').click();
      await page.locator('#workshop-sessions').getByRole('button',{name:'Duplicate / start from this point',exact:true}).first().click();
      await page.locator('#confirm-accept-btn').click();
      assert.equal(await page.locator('#workshop-input').inputValue(), 'Newest local draft');
      await page.waitForTimeout(300);
      assert.equal(rows.size, 2, 'duplicate creates exactly one additional conversation');
      assert.ok(!JSON.stringify([...rows.values()]).includes('fake-key'), 'snapshots contain no API keys');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      console.log(name + ': refresh, resume, full context, interrupted stream, layout passed');
    } finally { await browser.close(); }
  }
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => server.close());
