import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DAILY_LIMIT = 500;

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { message, settings } = await req.json();

    // ── RATE LIMITING ──────────────────────────────────────────────────────────
    // Get user from JWT
    const authHeader = req.headers.get('Authorization') || '';
    const jwt = authHeader.replace('Bearer ', '');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { data: { user } } = await supabase.auth.getUser(jwt);
    const userId = user?.id;

    if (userId) {
      const today = new Date().toISOString().split('T')[0];
      const rateKey = `ai_calls_${userId}_${today}`;

      // Get current count
      const { data: rateData } = await supabase
        .from('ai_rate_limits')
        .select('count')
        .eq('key', rateKey)
        .single();

      const currentCount = rateData?.count || 0;

      if (currentCount >= DAILY_LIMIT) {
        return new Response(JSON.stringify({
          error: `Daily AI limit reached (${DAILY_LIMIT} calls/day). Resets at midnight.`,
          type: null,
          limitReached: true
        }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Increment count (upsert)
      await supabase
        .from('ai_rate_limits')
        .upsert({ key: rateKey, count: currentCount + 1, updated_at: new Date().toISOString() });
    }
    // ── END RATE LIMITING ──────────────────────────────────────────────────────

    if (!message) {
      return new Response(JSON.stringify({ error: 'No message provided' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY');
    if (!ANTHROPIC_KEY) {
      return new Response(JSON.stringify({ error: 'AI not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

    const serviceTypes = settings?.serviceTypes?.join(', ') || 'Concrete, Excavation, Landscaping, Roofing, HVAC, Plumbing, Electrical, Remodeling';
    const leadSources = settings?.leadSources?.join(', ') || 'Phone, Website, Facebook, Google, Referral';
    const teamMembers = settings?.teamMembers?.join(', ') || 'Owner, Admin, Crew Lead';

    const systemPrompt = `You are a data extraction assistant for Blueprint Hub Operations, a contractor business management app.
Today's date is ${today}.

Available service types: ${serviceTypes}
Available lead sources: ${leadSources}
Available team members: ${teamMembers}

Extract structured data from the contractor's natural language input and return a JSON object.

Detect the record type: "lead", "estimate", "job", "invoice", "followup", or "client".
Return null type if you cannot determine what to create.

Rules:
- Names: extract first and last name separately when possible
- Phones: format as (XXX) XXX-XXXX if 10 digits detected
- Dates: return as YYYY-MM-DD. "tomorrow" = ${tomorrow}, "next week" = ${nextWeek}
- Money: strip $ and commas, return as plain number string
- Match service types to the closest available option
- Match lead sources to closest available option
- For jobs, default status to "Scheduled" unless clearly in progress or done

Return ONLY valid JSON in this exact format:
{
  "type": "lead|estimate|job|invoice|followup|client|null",
  "data": { ...fields matching the record type },
  "summary": "Short human-readable HTML summary of what will be created"
}

For "lead" data fields: firstName, lastName, phone, email, address, serviceType, source, status, dateAdded, followUpDate, value, assignedTo, notes
For "estimate" data fields: clientName, serviceType, amount, status, dateCreated, sentDate, followUpDate, notes
For "job" data fields: clientName, serviceType, value, status, startDate, endDate, assignedTo, priority, notes
For "invoice" data fields: clientName, amount, amountPaid, dateSent, dueDate, notes
For "followup" data fields: name, relatedType, dueDate, reason, status, owner, notes
For "client" data fields: name, phone, email, serviceType, serviceAddress, status, notes`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: message }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic error: ${err}`);
    }

    const aiData = await response.json();
    const rawText = aiData.content[0].text.trim();

    // Extract JSON from response
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in AI response');

    const parsed = JSON.parse(jsonMatch[0]);

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message, type: null }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
