require('fs').existsSync('.env') && require('fs').readFileSync('.env','utf8').split('\n').forEach(l=>{const[k,...v]=l.split('=');k&&(process.env[k.trim()]=v.join('=').trim())});
const crypto = require('crypto');
const https = require('https');

const secret = process.env.RECHARGE_WEBHOOK_SECRET;
if (!secret) { console.error('Set RECHARGE_WEBHOOK_SECRET env var'); process.exit(1); }

const payload = JSON.stringify({
  charge: {
    id: Date.now(),
    type: 'RECURRING',
    shopify_customer_id: '8925445259425',
    customer_id: '12345',
    email: 'maximusmattuchio@gmail.com'
  }
});

const sig = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('base64');

const options = {
  hostname: 'db-rewards-maximusmattuchio-1325s-projects.vercel.app',
  path: '/api/webhook',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-recharge-topic': 'charge/paid',
    'x-recharge-hmac-sha256': sig,
    'Content-Length': Buffer.byteLength(payload)
  }
};

const req = https.request(options, res => {
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Response:', data);
  });
});

req.on('error', e => console.error('Error:', e.message));
req.write(payload);
req.end();
