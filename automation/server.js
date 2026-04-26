const express = require('express');
const twilio = require('twilio');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// ── CONFIG ─────────────────────────────────────────────────────────────────────
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE || '+18775427817';

const client = twilio(TWILIO_SID, TWILIO_TOKEN);

// In-memory scheduled jobs (upgrades to DB later)
const scheduledJobs = [];

// ── HELPERS ────────────────────────────────────────────────────────────────────
async function sendSMS(to, message, businessName = 'Blueprint Hub') {
  const phone = to.replace(/\D/g, '');
  const formatted = phone.startsWith('1') ? `+${phone}` : `+1${phone}`;
  
  console.log(`📱 Sending SMS to ${formatted}: ${message.substring(0, 50)}...`);
  
  try {
    const result = await client.messages.create({
      body: message,
      from: TWILIO_PHONE,
      to: formatted
    });
    console.log(`✅ SMS sent: ${result.sid}`);
    return { success: true, sid: result.sid };
  } catch (err) {
    console.error(`❌ SMS failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

function scheduleSMS(phone, delayDays, message) {
  const sendAt = new Date();
  sendAt.setDate(sendAt.getDate() + delayDays);
  
  scheduledJobs.push({ phone, sendAt, message, sent: false });
  console.log(`⏰ Scheduled SMS to ${phone} in ${delayDays} days (${sendAt.toDateString()})`);
}

// ── CRON: Check scheduled jobs every hour ─────────────────────────────────────
cron.schedule('0 * * * *', async () => {
  const now = new Date();
  for (const job of scheduledJobs) {
    if (!job.sent && job.sendAt <= now) {
      await sendSMS(job.phone, job.message);
      job.sent = true;
    }
  }
});

// ── AUTOMATION 1: NEW LEAD → INSTANT SMS ──────────────────────────────────────
app.post('/webhook/lead-created', async (req, res) => {
  const { name, phone, job_type, business_name } = req.body;
  
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  
  const firstName = name ? name.split(' ')[0] : 'there';
  const biz = business_name || 'your contractor';
  const jobType = job_type || 'your project';
  
  const message = `Hey ${firstName}, this is ${biz}. Got your request for ${jobType}. When's a good time to talk about it?`;
  
  const result = await sendSMS(phone, message);
  console.log(`🎯 Automation 1: New Lead SMS → ${name} (${phone})`);
  res.json({ automation: 'lead-created', ...result });
});

// ── AUTOMATION 2: MISSED CALL ─────────────────────────────────────────────────
app.post('/webhook/missed-call', async (req, res) => {
  const { phone, business_name } = req.body;
  
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  
  const message = `Hey, sorry I missed your call. What can I help you with?`;
  
  const result = await sendSMS(phone, message);
  console.log(`🎯 Automation 2: Missed Call SMS → ${phone}`);
  res.json({ automation: 'missed-call', ...result });
});

// ── AUTOMATION 3: ESTIMATE SENT → FOLLOW-UP SEQUENCE ─────────────────────────
app.post('/webhook/estimate-sent', async (req, res) => {
  const { name, phone, job_type } = req.body;
  
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  
  const firstName = name ? name.split(' ')[0] : 'there';
  const jobType = job_type || 'your project';
  
  // Day 1
  scheduleSMS(phone, 1,
    `Hey ${firstName}, just wanted to make sure you saw the estimate for the ${jobType}. Let me know if you have any questions!`
  );
  
  // Day 3
  scheduleSMS(phone, 3,
    `Hey ${firstName}, checking in on the ${jobType} project. Still something you're looking to get done?`
  );
  
  // Day 7
  scheduleSMS(phone, 7,
    `Hey ${firstName}, last follow-up on the ${jobType}. If now's not the right time, no worries — just let me know.`
  );
  
  console.log(`🎯 Automation 3: Estimate follow-up sequence scheduled → ${name} (${phone})`);
  res.json({ automation: 'estimate-sent', scheduled: 3, days: [1, 3, 7] });
});

// ── AUTOMATION 4: JOB WON → ONBOARDING ───────────────────────────────────────
app.post('/webhook/job-approved', async (req, res) => {
  const { name, phone, job_type, payment_link } = req.body;
  
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  
  const firstName = name ? name.split(' ')[0] : 'there';
  const jobType = job_type || 'your project';
  
  // Onboarding message
  await sendSMS(phone,
    `Hey ${firstName}, glad to get started on your ${jobType}! Next step is getting you scheduled — I'll send details shortly.`
  );
  
  // Deposit link (if provided)
  if (payment_link) {
    await new Promise(r => setTimeout(r, 2000));
    await sendSMS(phone,
      `To lock in your spot, you can handle the deposit here: ${payment_link}`
    );
  }
  
  console.log(`🎯 Automation 4: Job Won onboarding → ${name} (${phone})`);
  res.json({ automation: 'job-approved', messages_sent: payment_link ? 2 : 1 });
});

// ── AUTOMATION 5: JOB COMPLETED → REVIEW REQUEST ─────────────────────────────
app.post('/webhook/job-completed', async (req, res) => {
  const { name, phone, review_link } = req.body;
  
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  
  const firstName = name ? name.split(' ')[0] : 'there';
  const link = review_link || 'https://g.page/r/review';
  
  // Immediate review request
  await sendSMS(phone,
    `Hey ${firstName}, appreciate you working with us! Would you mind leaving a quick review? It really helps. ${link}`
  );
  
  // Day 2: Referral ask
  scheduleSMS(phone, 2,
    `Also ${firstName}, if you know anyone who needs similar work, feel free to send them our way. We appreciate the support!`
  );
  
  console.log(`🎯 Automation 5: Job Completed review request → ${name} (${phone})`);
  res.json({ automation: 'job-completed', immediate: 1, scheduled: 1 });
});

// ── AUTOMATION 6: REACTIVATION (30 days no contact) ──────────────────────────
app.post('/webhook/reactivate', async (req, res) => {
  const { name, phone, job_type } = req.body;
  
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  
  const firstName = name ? name.split(' ')[0] : 'there';
  const jobType = job_type || 'that project';
  
  const message = `Hey ${firstName}, not sure if you're still thinking about ${jobType}, but we've got some availability coming up if you want to revisit it.`;
  
  const result = await sendSMS(phone, message);
  console.log(`🎯 Automation 6: Reactivation → ${name} (${phone})`);
  res.json({ automation: 'reactivate', ...result });
});

// ── SEND CUSTOM SMS (manual trigger) ─────────────────────────────────────────
app.post('/send-sms', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });
  const result = await sendSMS(to, message);
  res.json(result);
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'Blueprint Hub Automation Engine Running 🔨',
    version: '1.0.0',
    automations: [
      'POST /webhook/lead-created',
      'POST /webhook/missed-call', 
      'POST /webhook/estimate-sent',
      'POST /webhook/job-approved',
      'POST /webhook/job-completed',
      'POST /webhook/reactivate',
      'POST /send-sms'
    ],
    scheduled_jobs: scheduledJobs.filter(j => !j.sent).length
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Blueprint Hub Automation Engine running on port ${PORT}`);
  console.log(`📱 Twilio: ${TWILIO_PHONE}`);
  console.log(`✅ All 6 automations ready\n`);
});
