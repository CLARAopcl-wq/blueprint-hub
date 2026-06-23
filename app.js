
// ── SUPABASE INIT ─────────────────────────────────────────────────────────────
// ── GOOGLE CALENDAR CONFIG ─────────────────────────────────────────────────────
const GCAL_CLIENT_ID = '20425489960-tetdd3d4poioaqsrtn50b646mv8v9pd8.apps.googleusercontent.com';
const GCAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
let gcalToken = null;

async function connectGoogleCalendar(){
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GCAL_CLIENT_ID,
      scope: GCAL_SCOPE,
      callback: (resp) => {
        if(resp.error){ reject(resp.error); return; }
        gcalToken = resp.access_token;
        localStorage.setItem('bh_gcal_token', gcalToken);
        resolve(gcalToken);
      }
    });
    client.requestAccessToken();
  });
}

async function ensureGcalToken(){
  if(gcalToken) return gcalToken;
  const stored = localStorage.getItem('bh_gcal_token');
  if(stored){ gcalToken = stored; return gcalToken; }
  return await connectGoogleCalendar();
}

async function addJobToCalendar(job){
  try {
    const token = await ensureGcalToken();
    const startDate = job.startDate || job.scheduledDate || new Date().toISOString().split('T')[0];
    const endDate = job.endDate || startDate;
    const event = {
      summary: `🔨 ${job.serviceType || 'Job'} — ${job.clientName || 'Client'}`,
      description: `Blueprint Hub Job #${job.id}\nValue: $${job.value || '0'}\nStatus: ${job.status || 'Scheduled'}\nNotes: ${job.notes || ''}`,
      start: { date: startDate },
      end: { date: endDate },
      extendedProperties: { private: { bhJobId: job.id } }
    };
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    const data = await res.json();
    if(data.id){
      // Save calendar event ID back to job
      const jobIdx = db.jobs.findIndex(j => j.id === job.id);
      if(jobIdx >= 0){ db.jobs[jobIdx].gcalEventId = data.id; save(); }
      return data.id;
    }
  } catch(e) {
    console.warn('Calendar sync error:', e.message);
  }
}

async function updateJobInCalendar(job){
  if(!job.gcalEventId) return addJobToCalendar(job);
  try {
    const token = await ensureGcalToken();
    const startDate = job.startDate || job.scheduledDate || new Date().toISOString().split('T')[0];
    const event = {
      summary: `🔨 ${job.serviceType || 'Job'} — ${job.clientName || 'Client'}${job.status === 'Completed' ? ' ✅' : ''}`,
      description: `Blueprint Hub Job #${job.id}\nValue: $${job.value || '0'}\nStatus: ${job.status || 'Scheduled'}`,
      start: { date: startDate },
      end: { date: job.endDate || startDate }
    };
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${job.gcalEventId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
  } catch(e) {
    console.warn('Calendar update error:', e.message);
  }
}

const SUPABASE_URL = 'https://tsltxrutoynlvsdyljtm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRzbHR4cnV0b3lubHZzZHlsanRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1ODQ1NTEsImV4cCI6MjA5MTE2MDU1MX0.rSkMjWhEwZ44tFq0JT2aeWBZAaJNCi1E7oQfdOKJ1m8';
const _supa = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: window.localStorage,
    storageKey: 'bh_supabase_auth',
  }
});

// ── DATA ──────────────────────────────────────────────────────────────────────
const DEFAULT_DATA = {
  leads:[],estimates:[],jobs:[],invoices:[],followups:[],clients:[],summaries:[],crewLog:[],
  settings:{
    businessName:'',
    leadStatuses:['New','Contacted','Estimate Scheduled','Estimate Sent','Won','Lost'],
    leadSources:['Phone','Text','Website','Facebook','Instagram','Google','Referral','Yard Sign','Repeat Customer','Other'],
    serviceTypes:['Concrete','Excavation','Landscaping','Roofing','HVAC','Plumbing','Electrical','Remodeling','Pest Control','Pressure Washing','Other'],
    estimateStatuses:['Draft','Sent','Pending','Approved','Rejected'],
    jobStatuses:['Scheduled','In Progress','Waiting','Completed','Invoiced','Paid'],
    invoiceStatuses:['Unpaid','Partial','Paid','Overdue'],
    clientStatuses:['Active','Inactive'],
    priorityLevels:['Low','Medium','High'],
    followUpStatuses:['Open','Done'],
    teamMembers:['Owner','Admin','Office Manager','Estimator','Crew Lead'],
    teamMemberPhones:{},
    receptionist:{
      name:'',
      services:'',
      tone:'Professional',
      openingMessage:'',
      customInstructions:'',
    },
  }
};

let db = JSON.parse(JSON.stringify(DEFAULT_DATA));
let currentUser = null;
let editingId = null, editingType = null;
let saveTimeout = null;

// Cloud save — debounced so we don't hammer Supabase on every keystroke
async function save() {
  if(!currentUser) return;
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    try {
      const { error } = await _supa
        .from('user_data')
        .upsert({ user_id: currentUser.id, data: db, updated_at: new Date().toISOString() },
                 { onConflict: 'user_id' });
      if(error) console.error('Save error:', error.message);
    } catch(e) { console.error('Save failed:', e); }
  }, 800);
}

async function loadUserData() {
  try {
    const { data, error } = await _supa
      .from('user_data')
      .select('data')
      .eq('user_id', currentUser.id)
      .single();
    if(data && data.data) {
      // Merge with defaults to ensure new keys exist
      db = Object.assign(JSON.parse(JSON.stringify(DEFAULT_DATA)), data.data);
      if(!db.settings.teamMemberPhones) db.settings.teamMemberPhones = {};
    }
  } catch(e) { /* first time user — use defaults */ }
}

function genId(prefix,arr){
  let max=0;
  arr.forEach(r=>{const n=parseInt((r.id||'').replace(/\D/g,''));if(n>max)max=n;});
  return prefix+(String(max+1).padStart(3,'0'));
}
function today(){return new Date().toISOString().split('T')[0];}
function fmt(d){if(!d)return'—';const p=d.split('-');return p.length===3?`${p[1]}/${p[2]}/${p[0]}`:d;}
function money(v){return v?'$'+Number(v).toLocaleString():'—';}

// ── AUTH ──────────────────────────────────────────────────────────────────────
function showPanel(name) {
  ['signin','signup','forgot'].forEach(p => {
    document.getElementById('panel-'+p).style.display = p===name?'block':'none';
  });
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-pass').value;
  const errEl = document.getElementById('login-error');
  errEl.style.display='none';
  if(!email||!pass){ errEl.textContent='Please enter email and password.'; errEl.style.display='block'; return; }
  const { data, error } = await _supa.auth.signInWithPassword({ email, password: pass });
  if(error){ errEl.textContent = error.message; errEl.style.display='block'; return; }
  _sessionHandled = true; await onSignedIn(data.user);
}

async function doSignup() {
  const biz   = document.getElementById('signup-biz').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const pass  = document.getElementById('signup-pass').value;
  const errEl = document.getElementById('signup-error');
  errEl.style.display='none';
  if(!email||!pass){ errEl.textContent='Email and password are required.'; errEl.style.display='block'; return; }
  if(pass.length < 6){ errEl.textContent='Password must be at least 6 characters.'; errEl.style.display='block'; return; }
  const { data, error } = await _supa.auth.signUp({ email, password: pass });
  if(error){ errEl.textContent = error.message; errEl.style.display='block'; return; }
  if(biz) db.settings.businessName = biz;
  _sessionHandled = true; await onSignedIn(data.user);
}

async function doForgot() {
  const email = document.getElementById('forgot-email').value.trim();
  const msgEl = document.getElementById('forgot-msg');
  if(!email){ msgEl.style.color='var(--red)'; msgEl.textContent='Enter your email.'; msgEl.style.display='block'; return; }
  const { error } = await _supa.auth.resetPasswordForEmail(email);
  if(error){ msgEl.style.color='var(--red)'; msgEl.textContent=error.message; }
  else { msgEl.style.color='var(--green)'; msgEl.textContent='Reset link sent! Check your email.'; }
  msgEl.style.display='block';
}

async function doLogout() {
  if(!confirm('Sign out of Blueprint Hub?')) return;
  await _supa.auth.signOut();
  currentUser = null;
  db = JSON.parse(JSON.stringify(DEFAULT_DATA));
  document.getElementById('app').style.display='none';
  document.getElementById('login-screen').style.display='flex';
  showPanel('signin');
}

async function onSignedIn(user) {
  currentUser = user;
  showLoader('Loading your data...');
  document.getElementById('login-screen').style.display='none';
  document.getElementById('app').style.display='none';
  const email = user.email || '';
  const username = email.split('@')[0];
  const topbarUser = document.getElementById('topbar-user');
  if(topbarUser) topbarUser.textContent = '👤 ' + username;

  // Populate sidebar account
  const avatarEl = document.getElementById('account-avatar');
  const nameEl = document.getElementById('account-name');
  const emailEl = document.getElementById('account-email');
  if(avatarEl) avatarEl.textContent = username.charAt(0).toUpperCase();
  if(nameEl) nameEl.textContent = username;
  if(emailEl) emailEl.textContent = email;

  await loadUserData();
  hideLoader();
  document.getElementById('app').style.display='flex';
  initPushNotifications();
  renderAll();
  restoreLastPage();
  updateNavBadges();
  checkAutoSummary();

  // Update name with business name if set
  if(db.settings?.businessName){
    if(nameEl) nameEl.textContent = db.settings.businessName;
  }
}

// Check existing session on load + listen for auth changes
let _sessionHandled = false;
(async () => {
  showLoader();
  document.getElementById('login-screen').style.display='none';
  document.getElementById('app').style.display='none';

  // Listen for auth changes first
  _supa.auth.onAuthStateChange(async (event, session) => {
    if(event === 'SIGNED_OUT') {
      _sessionHandled = false;
      currentUser = null;
      db = JSON.parse(JSON.stringify(DEFAULT_DATA));
      document.getElementById('app').style.display='none';
      document.getElementById('login-screen').style.display='flex';
      showPanel('signin');
      return;
    }
    if((event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') && session) {
      currentUser = session.user;
    }
  });

  // Then check for existing session
  const { data: { session } } = await _supa.auth.getSession();
  if(session && session.user && !_sessionHandled) {
    _sessionHandled = true;
    await onSignedIn(session.user);
  } else if(!session) {
    hideLoader();
    document.getElementById('login-screen').style.display='flex';
  }
})();

// ── LOADER ────────────────────────────────────────────────────────────────────
function showLoader(msg='Loading Blueprint Hub...'){
  const el = document.getElementById('app-loader');
  el.querySelector('.spinner-label').textContent = msg;
  el.classList.remove('hidden');
}
function hideLoader(){
  document.getElementById('app-loader').classList.add('hidden');
}

// ── NAV BADGES ────────────────────────────────────────────────────────────────
function updateNavBadges(){
  const now = today();
  const badges = {
    'nav-leads': db.leads.filter(l=>l.status!=='Won'&&l.status!=='Lost').length,
    'nav-estimates': db.estimates.filter(e=>['Draft','Sent','Pending'].includes(e.status)).length,
    'nav-jobs': db.jobs.filter(j=>['Scheduled','In Progress','Waiting','Completed'].includes(j.status)).length,
    'nav-invoices': db.invoices.filter(i=>calcAutoStatus(i)!=='Paid').length,
    'nav-followups': db.followups.filter(f=>f.status==='Open'&&f.dueDate&&f.dueDate<=now).length,
  };
  Object.entries(badges).forEach(([id,count])=>{
    const el = document.getElementById(id);
    if(!el) return;
    const existing = el.querySelector('.nav-badge');
    if(existing) existing.remove();
    if(count > 0){
      const b = document.createElement('span');
      b.className = 'nav-badge';
      b.textContent = count;
      el.appendChild(b);
    }
  });
}

// ── SEARCH FILTER ─────────────────────────────────────────────────────────────
function getSearch(id){
  const el = document.getElementById(id);
  return el ? el.value.toLowerCase().trim() : '';
}
function matchSearch(q, ...fields){
  if(!q) return true;
  return fields.some(f => f && String(f).toLowerCase().includes(q));
}

// ── ROTATING QUICK ENTRY PLACEHOLDER ─────────────────────────────────────────
const QE_EXAMPLES = [
  'New lead John Smith, roofing, called from Google, 555-1234',
  'Job done for Maria Garcia, send invoice $4500',
  'Follow up with Bob tomorrow about his estimate',
  'New estimate for Dave, concrete driveway, $8000',
  'Won the job — starting next week for Tony Martinez, electrical',
  'New lead from Facebook, Sarah Lee, HVAC repair, 614-555-9876',
];
let qeIndex = 0;
function rotateQEPlaceholder(){
  const el = document.getElementById('quick-input');
  if(!el) return;
  qeIndex = (qeIndex+1) % QE_EXAMPLES.length;
  el.placeholder = QE_EXAMPLES[qeIndex];
}
setInterval(rotateQEPlaceholder, 4000);

// ── MOBILE SIDEBAR ────────────────────────────────────────────────────────────
function toggleSidebar(){
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('sidebar-overlay');
  const isOpen = sb.classList.contains('open');
  if(isOpen){ closeSidebar(); } else {
    sb.classList.add('open');
    ov.classList.add('open');
    document.getElementById('hamburger-btn').textContent = '✕';
  }
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
  document.getElementById('hamburger-btn').textContent = '☰';
}

// ── NAVIGATION ────────────────────────────────────────────────────────────────
function showPage(name,el){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  el.classList.add('active');
  localStorage.setItem('bh_last_page', name);
  render(name);
}

function restoreLastPage(){
  const last = localStorage.getItem('bh_last_page') || 'dashboard';
  const navItems = document.querySelectorAll('.nav-item');
  let found = false;
  navItems.forEach(n => {
    const onclick = n.getAttribute('onclick') || '';
    if(onclick.includes(`'${last}'`)){
      document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
      navItems.forEach(ni=>ni.classList.remove('active'));
      const page = document.getElementById('page-'+last);
      if(page){ page.classList.add('active'); n.classList.add('active'); render(last); found=true; }
    }
  });
  if(!found){ render('dashboard'); }
}

// ── BADGE ─────────────────────────────────────────────────────────────────────
function badge(val){
  if(!val)return'—';
  const v=val.toLowerCase().replace(/\s/g,'');
  const map={new:'badge-new',won:'badge-won',lost:'badge-lost',contacted:'badge-contacted',
    inprogress:'badge-inprogress',completed:'badge-completed',paid:'badge-paid',
    unpaid:'badge-unpaid',overdue:'badge-overdue',partial:'badge-partial'};
  const cls=map[v]||'badge-default';
  return`<span class="badge ${cls}">${val}</span>`;
}

function emptyState(msg, btnLabel=null, btnAction=null){
  const btn = btnLabel ? `<button class="btn-add" style="margin-top:14px;" onclick="${btnAction}">${btnLabel}</button>` : '';
  return`<div class="empty-state"><div class="empty-icon">📂</div><p>${msg}</p>${btn}</div>`;
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
function renderDashboard(){
  loadSavedInsights();
  setTimeout(renderActivityChart, 100);
  const now=today();
  const thisMonth=now.substring(0,7);
  const leads=db.leads;
  const estimates=db.estimates;
  const jobs=db.jobs;
  const invoices=db.invoices;
  const fups=db.followups;

  const openLeads=leads.filter(l=>l.status!=='Won'&&l.status!=='Lost').length;
  const followUpDue=leads.filter(l=>l.followUpDate&&l.followUpDate<=now&&l.status!=='Won'&&l.status!=='Lost').length;
  const pendingEst=estimates.filter(e=>['Draft','Sent','Pending'].includes(e.status)).length;
  const activeJobs=jobs.filter(j=>['Scheduled','In Progress','Waiting'].includes(j.status)).length;
  const readyInvoice=jobs.filter(j=>j.status==='Completed').length;
  const unpaidInv=invoices.filter(i=>i.autoStatus==='Unpaid'||i.status==='Unpaid').length;
  const overdueInv=invoices.filter(i=>calcAutoStatus(i)==='Overdue').length;
  const revMonth=invoices.filter(i=>i.dateSent&&i.dateSent.startsWith(thisMonth)).reduce((s,i)=>s+Number(i.amount||0),0);
  const cashMonth=invoices.filter(i=>i.paymentDate&&i.paymentDate.startsWith(thisMonth)).reduce((s,i)=>s+Number(i.amountPaid||0),0);

  const metrics=[
    {label:'Open Leads',val:openLeads,cls:'yellow'},
    {label:'Leads Due Follow-Up',val:followUpDue,cls:'red'},
    {label:'Pending Estimates',val:pendingEst,cls:'yellow'},
    {label:'Active Jobs',val:activeJobs,cls:'blue'},
    {label:'Ready to Invoice',val:readyInvoice,cls:'yellow'},
    {label:'Unpaid Invoices',val:unpaidInv,cls:'red'},
    {label:'Overdue Invoices',val:overdueInv,cls:'red'},
    {label:'Revenue This Month',val:'$'+revMonth.toLocaleString(),cls:'green'},
    {label:'Cash Collected',val:'$'+cashMonth.toLocaleString(),cls:'green'},
  ];

  document.getElementById('metrics-grid').innerHTML=metrics.map(m=>`
    <div class="metric-card">
      <div class="metric-label">${m.label}</div>
      <div class="metric-value ${m.cls}">${m.val}</div>
    </div>`).join('');

  // Today's follow-ups
  const todayFups=fups.filter(f=>f.dueDate===now&&f.status==='Open');
  document.getElementById('dash-followups').innerHTML=todayFups.length?
    todayFups.map(f=>`<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:0.82rem;"><strong>${f.name||'—'}</strong> — ${f.reason||'—'}</div>`).join(''):
    `<div style="color:var(--muted);font-size:0.82rem;padding:8px 0;">No follow-ups today 🎉</div>`;

  // Overdue invoices
  const overdueList=invoices.filter(i=>calcAutoStatus(i)==='Overdue');
  document.getElementById('dash-overdue').innerHTML=overdueList.length?
    overdueList.map(i=>`<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:0.82rem;display:flex;justify-content:space-between;"><span>${i.clientName||'—'}</span><span style="color:var(--red);">${money(i.amount)}</span></div>`).join(''):
    `<div style="color:var(--muted);font-size:0.82rem;padding:8px 0;">No overdue invoices 🎉</div>`;

  renderCrewLog();
}

// ── RENDERS ───────────────────────────────────────────────────────────────────
function calcAutoStatus(inv){
  const paid=Number(inv.amountPaid||0);
  const amt=Number(inv.amount||0);
  if(paid>=amt&&amt>0)return'Paid';
  if(paid>0)return'Partial';
  if(inv.dueDate&&inv.dueDate<today())return'Overdue';
  return'Unpaid';
}

function renderLeads(){
  // Apply saved view preference
  if(leadsView === 'kanban'){
    setLeadsView('kanban');
  } else {
    setLeadsView('table');
  }
  const tbody=document.getElementById('leads-tbody');
  const q=getSearch('search-leads');
  const filtered=db.leads.filter(l=>matchSearch(q,l.firstName,l.lastName,l.phone,l.email,l.serviceType,l.source,l.status,l.id));
  if(!db.leads.length){tbody.innerHTML=`<tr><td colspan="10">${emptyState('No leads yet.','+ Add Your First Lead',"openModal('lead')")}</td></tr>`;updateNavBadges();return;}
  if(!filtered.length){tbody.innerHTML=`<tr><td colspan="10">${emptyState('No leads match your search.')}</td></tr>`;return;}
  tbody.innerHTML=filtered.map(l=>`<tr>
    <td>${l.id}</td><td>${fmt(l.dateAdded)}</td>
    <td><strong>${l.firstName||''} ${l.lastName||''}</strong></td>
    <td>${l.phone||'—'}</td><td>${l.serviceType||'—'}</td>
    <td>${l.source||'—'}</td><td>${badge(l.status)}</td>
    <td>${fmt(l.followUpDate)}</td><td>${money(l.value)}</td>
    <td><button class="btn-edit" onclick="openModal('lead','${l.id}')">Edit</button><button class="btn-delete" onclick="deleteRecord('leads','${l.id}')">Delete</button></td>
  </tr>`).join('');
}

function renderEstimates(){
  const tbody=document.getElementById('estimates-tbody');
  const q=getSearch('search-estimates');
  const filtered=db.estimates.filter(e=>matchSearch(q,e.clientName,e.serviceType,e.status,e.id,e.linkedLeadId));
  if(!db.estimates.length){tbody.innerHTML=`<tr><td colspan="8">${emptyState('No estimates yet.','+ Add Your First Estimate',"openModal('estimate')")}</td></tr>`;return;}
  if(!filtered.length){tbody.innerHTML=`<tr><td colspan="8">${emptyState('No estimates match your search.')}</td></tr>`;return;}
  tbody.innerHTML=filtered.map(e=>`<tr>
    <td>${e.id}</td><td>${fmt(e.dateCreated)}</td>
    <td>${e.clientName||'—'}</td><td>${e.serviceType||'—'}</td>
    <td>${money(e.amount)}</td><td>${badge(e.status)}</td>
    <td>${fmt(e.followUpDate)}</td>
    <td><button class="btn-edit" onclick="openModal('estimate','${e.id}')">Edit</button><button class="btn-delete" onclick="deleteRecord('estimates','${e.id}')">Delete</button></td>
  </tr>`).join('');
}

function renderJobs(){
  const tbody=document.getElementById('jobs-tbody');
  const q=getSearch('search-jobs');
  const filtered=db.jobs.filter(j=>matchSearch(q,j.clientName,j.serviceType,j.status,j.id,j.assignedTo));
  if(!db.jobs.length){tbody.innerHTML=`<tr><td colspan="10">${emptyState('No jobs yet.','+ Add Your First Job',"openModal('job')")}</td></tr>`;return;}
  if(!filtered.length){tbody.innerHTML=`<tr><td colspan="10">${emptyState('No jobs match your search.')}</td></tr>`;return;}
  tbody.innerHTML=filtered.map(j=>`<tr>
    <td>${j.id}</td><td>${j.clientName||'—'}</td>
    <td>${j.serviceType||'—'}</td><td>${money(j.value)}</td>
    <td>${badge(j.status)}</td><td>${fmt(j.startDate)}</td>
    <td>${fmt(j.endDate)}</td><td>${j.assignedTo||'—'}</td>
    <td>${badge(j.priority)}</td>
    <td><button class="btn-notify" onclick="openCrewModal('${j.id}')">📲</button><button class="btn-edit" onclick="openModal('job','${j.id}')">Edit</button><button style="background:rgba(75,175,125,0.15);border:1px solid rgba(75,175,125,0.3);color:#4CAF7D;padding:5px 10px;border-radius:6px;font-size:0.75rem;cursor:pointer;font-weight:600;" onclick="generateInvoiceFromJob('${j.id}')">🧾 Invoice</button><button class="btn-delete" onclick="deleteRecord('jobs','${j.id}')">Delete</button></td>
  </tr>`).join('');
}

function renderInvoices(){
  const tbody=document.getElementById('invoices-tbody');
  const q=getSearch('search-invoices');
  const filtered=db.invoices.filter(i=>matchSearch(q,i.clientName,i.id,i.linkedJobId,calcAutoStatus(i)));
  if(!db.invoices.length){tbody.innerHTML=`<tr><td colspan="9">${emptyState('No invoices yet.','+ Add Your First Invoice',"openModal('invoice')")}</td></tr>`;return;}
  if(!filtered.length){tbody.innerHTML=`<tr><td colspan="9">${emptyState('No invoices match your search.')}</td></tr>`;return;}
  tbody.innerHTML=filtered.map(i=>{
    const auto=calcAutoStatus(i);
    const balance=Math.max(0,Number(i.amount||0)-Number(i.amountPaid||0));
    return`<tr>
      <td>${i.id}</td><td>${i.clientName||'—'}</td>
      <td>${money(i.amount)}</td><td>${fmt(i.dateSent)}</td>
      <td>${fmt(i.dueDate)}</td><td>${money(i.amountPaid)}</td>
      <td>${money(balance)}</td><td>${badge(auto)}</td>
      <td><button class="btn-edit" onclick="openModal('invoice','${i.id}')">Edit</button><button class="btn-delete" onclick="deleteRecord('invoices','${i.id}')">Delete</button></td>
    </tr>`;
  }).join('');
}

function renderFollowups(){
  const tbody=document.getElementById('followups-tbody');
  const q=getSearch('search-followups');
  const filtered=db.followups.filter(f=>matchSearch(q,f.name,f.reason,f.status,f.owner,f.id));
  if(!db.followups.length){tbody.innerHTML=`<tr><td colspan="8">${emptyState('No follow-ups yet.','+ Add Your First Follow-Up',"openModal('followup')")}</td></tr>`;return;}
  if(!filtered.length){tbody.innerHTML=`<tr><td colspan="8">${emptyState('No follow-ups match your search.')}</td></tr>`;return;}
  tbody.innerHTML=filtered.map(f=>`<tr>
    <td>${f.id}</td><td>${f.relatedType||'—'}</td>
    <td>${f.name||'—'}</td><td>${f.reason||'—'}</td>
    <td>${fmt(f.dueDate)}</td><td>${badge(f.status)}</td>
    <td>${f.owner||'—'}</td>
    <td><button class="btn-edit" onclick="openModal('followup','${f.id}')">Edit</button><button class="btn-delete" onclick="deleteRecord('followups','${f.id}')">Delete</button></td>
  </tr>`).join('');
}

function renderClients(){
  const tbody=document.getElementById('clients-tbody');
  const q=getSearch('search-clients');
  const filtered=db.clients.filter(c=>matchSearch(q,c.name,c.phone,c.email,c.serviceType,c.status,c.id));
  if(!db.clients.length){tbody.innerHTML=`<tr><td colspan="8">${emptyState('No clients yet.','+ Add Your First Client',"openModal('client')")}</td></tr>`;return;}
  if(!filtered.length){tbody.innerHTML=`<tr><td colspan="8">${emptyState('No clients match your search.')}</td></tr>`;return;}
  tbody.innerHTML=filtered.map(c=>`<tr>
    <td>${c.id}</td><td><strong>${c.name||'—'}</strong></td>
    <td>${c.phone||'—'}</td><td>${c.email||'—'}</td>
    <td>${c.serviceType||'—'}</td><td>${badge(c.status)}</td>
    <td>${fmt(c.lastJobDate)}</td>
    <td><button class="btn-edit" onclick="openModal('client','${c.id}')">Edit</button><button class="btn-delete" onclick="deleteRecord('clients','${c.id}')">Delete</button></td>
  </tr>`).join('');
}

function renderSettings(){
  const s=db.settings;
  // Ensure teamMemberPhones exists
  if(!s.teamMemberPhones) s.teamMemberPhones={};
  setTimeout(renderSettingsSignOut, 50);
  setTimeout(renderSubscriptionSection, 50);

  const sections=[
    {key:'leadStatuses',label:'Lead Statuses'},
    {key:'leadSources',label:'Lead Sources'},
    {key:'serviceTypes',label:'Service Types'},
    {key:'estimateStatuses',label:'Estimate Statuses'},
    {key:'jobStatuses',label:'Job Statuses'},
    {key:'invoiceStatuses',label:'Invoice Statuses'},
    {key:'clientStatuses',label:'Client Statuses'},
    {key:'priorityLevels',label:'Priority Levels'},
    {key:'followUpStatuses',label:'Follow-Up Statuses'},
  ];

  // Team Members section (special — includes phone numbers)
  const teamSection = `<div class="settings-card" style="grid-column:1/-1;">
    <h3>👥 Team Members & Phone Numbers</h3>
    <div id="team-members-list">
      ${(s.teamMembers||[]).map(name=>`
        <div class="settings-member-item">
          <span class="settings-member-name">${name}</span>
          <div class="settings-member-phone">
            <input type="tel" placeholder="555-000-0000" value="${s.teamMemberPhones[name]||''}"
              onchange="updateMemberPhone('${name}',this.value)" onblur="updateMemberPhone('${name}',this.value)"/>
          </div>
          <span class="settings-member-remove" onclick="removeMember('${name}')">✕</span>
        </div>`).join('')}
    </div>
    <div class="settings-add" style="margin-top:10px;">
      <input type="text" id="input-teamMembers" placeholder="Add team member name..." onkeydown="if(event.key==='Enter')addMember()"/>
      <button onclick="addMember()">+</button>
    </div>
    <div style="color:var(--muted);font-size:0.75rem;margin-top:10px;">📱 Add phone numbers to enable crew text notifications</div>
  </div>`;

  // AI Receptionist settings
  const receptionistPlan = db.subscription?.plan;
  const receptionistAccess = receptionistPlan === 'pro' || receptionistPlan === 'agency';
  const r = s.receptionist || {};
  const receptionistSection = !receptionistAccess
    ? `<div class="settings-card" style="grid-column:1/-1;background:linear-gradient(135deg,rgba(99,102,241,0.08),rgba(59,130,246,0.05));border-color:rgba(99,102,241,0.25);text-align:center;padding:32px;">
        <div style="font-size:2rem;margin-bottom:8px;">🔒</div>
        <div style="font-weight:700;margin-bottom:6px;">AI Receptionist</div>
        <div style="font-size:0.82rem;color:var(--muted);margin-bottom:16px;">Automatically responds to leads via SMS. Available on Pro and Agency plans.</div>
        <button onclick="document.getElementById('subscription-section')?.scrollIntoView({behavior:'smooth'});" style="background:var(--yellow);border:none;color:#000;padding:10px 24px;border-radius:8px;font-weight:700;cursor:pointer;">⚡ Upgrade to Pro</button>
      </div>`
    : `<div class="settings-card" style="grid-column:1/-1;background:linear-gradient(135deg,rgba(99,102,241,0.08),rgba(59,130,246,0.05));border-color:rgba(99,102,241,0.25);">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
      <h3 style="margin:0;">🤖 AI Receptionist</h3>
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
        <span style="font-size:0.82rem;color:var(--muted);">${(r.enabled!==false)?'Active':'Inactive'}</span>
        <div onclick="toggleReceptionist()" style="position:relative;width:44px;height:24px;background:${(r.enabled!==false)?'#6366f1':'var(--border)'};border-radius:25px;transition:background 0.2s;flex-shrink:0;">
          <div style="position:absolute;top:3px;left:${(r.enabled!==false)?'23px':'3px'};width:18px;height:18px;background:#fff;border-radius:50%;transition:left 0.2s;box-shadow:0 1px 4px rgba(0,0,0,0.2);"></div>
        </div>
      </label>
    </div>
    <div style="color:var(--muted);font-size:0.8rem;margin-bottom:20px;">When someone texts your Blueprint Hub number, the AI responds as your receptionist and qualifies leads automatically.</div>
    <div style="margin-bottom:16px;">
      <label style="font-size:0.78rem;font-weight:600;color:var(--text);display:block;margin-bottom:6px;">📱 Your Business Phone Number <span style="font-weight:400;color:var(--muted)">(the number you give to leads)</span></label>
      <input type="tel" placeholder="+1 877 542 7817" value="${r.receptionistPhone||''}"
        onchange="updateReceptionist('receptionistPhone',this.value)"
        style="width:100%;padding:10px 14px;background:var(--bg);border:1.5px solid var(--border);border-radius:8px;font-size:0.88rem;color:var(--text);outline:none;"/>
      <div style="font-size:0.72rem;color:var(--muted);margin-top:4px;">Enter the Twilio number assigned to your account. Texts to this number will be handled by your AI receptionist.</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
      <div>
        <label style="font-size:0.78rem;font-weight:600;color:var(--text);display:block;margin-bottom:6px;">📱 Your Blueprint Hub Number</label>
        <div style="padding:10px 14px;background:var(--bg);border:1.5px solid var(--border);border-radius:8px;font-size:0.88rem;color:var(--muted);">+1 (877) 542-7817</div>
      </div>
      <div>
        <label style="font-size:0.78rem;font-weight:600;color:var(--text);display:block;margin-bottom:6px;">🧑 Receptionist Name</label>
        <input type="text" placeholder="e.g. Sarah, Alex, Jordan..." value="${r.name||''}"
          onchange="updateReceptionist('name',this.value)"
          style="width:100%;padding:10px 14px;background:var(--bg);border:1.5px solid var(--border);border-radius:8px;font-size:0.88rem;color:var(--text);outline:none;"/>
      </div>
    </div>
    <div style="margin-bottom:16px;">
      <label style="font-size:0.78rem;font-weight:600;color:var(--text);display:block;margin-bottom:6px;">🔧 Services You Offer</label>
      <input type="text" placeholder="e.g. Roofing, gutters, siding, inspections, repairs..." value="${r.services||''}"
        onchange="updateReceptionist('services',this.value)"
        style="width:100%;padding:10px 14px;background:var(--bg);border:1.5px solid var(--border);border-radius:8px;font-size:0.88rem;color:var(--text);outline:none;"/>
    </div>
    <div style="margin-bottom:16px;">
      <label style="font-size:0.78rem;font-weight:600;color:var(--text);display:block;margin-bottom:6px;">🗣️ Tone</label>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        ${['Friendly & Casual','Professional','Direct & Efficient'].map(t=>`
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:0.85rem;">
            <input type="radio" name="receptionist-tone" value="${t}" ${(r.tone||'Professional')===t?'checked':''} onchange="updateReceptionist('tone','${t}')"/> ${t}
          </label>`).join('')}
      </div>
    </div>
    <div style="margin-bottom:16px;">
      <label style="font-size:0.78rem;font-weight:600;color:var(--text);display:block;margin-bottom:6px;">💬 Opening Message</label>
      <textarea placeholder="Hey! Thanks for reaching out to {business}. What can I help you with today?" 
        onchange="updateReceptionist('openingMessage',this.value)"
        style="width:100%;padding:10px 14px;background:var(--bg);border:1.5px solid var(--border);border-radius:8px;font-size:0.85rem;color:var(--text);outline:none;resize:vertical;min-height:70px;">${r.openingMessage||''}</textarea>
      <div style="font-size:0.72rem;color:var(--muted);margin-top:4px;">Use {business} for your business name, {name} for the lead's name.</div>
    </div>
    <div>
      <label style="font-size:0.78rem;font-weight:600;color:var(--text);display:block;margin-bottom:6px;">📋 Custom Instructions <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
      <textarea placeholder="e.g. We don't do commercial work. Minimum job $500. Always ask for address. Never quote prices over text..." 
        onchange="updateReceptionist('customInstructions',this.value)"
        style="width:100%;padding:10px 14px;background:var(--bg);border:1.5px solid var(--border);border-radius:8px;font-size:0.85rem;color:var(--text);outline:none;resize:vertical;min-height:80px;">${r.customInstructions||''}</textarea>
    </div>
    <div style="margin-top:16px;padding:12px 16px;background:${(r.enabled!==false)?'rgba(34,197,94,0.08)':'rgba(239,68,68,0.08)'};border:1px solid ${(r.enabled!==false)?'rgba(34,197,94,0.2)':'rgba(239,68,68,0.2)'};border-radius:8px;font-size:0.8rem;color:${(r.enabled!==false)?'#16a34a':'#dc2626'};">
      ${(r.enabled!==false)?'✅ AI Receptionist is <strong>active</strong> — leads who text +1 (877) 542-7817 will get an instant AI response.':'⏸️ AI Receptionist is <strong>paused</strong> — inbound texts will not receive an automated response.'}
    </div>
  </div>`;

  // Push Notifications section

  const pushEnabled = s.pushEnabled || false;
  const pushPermission = typeof Notification !== 'undefined' ? Notification.permission : 'default';
  const pushSection = `<div class="settings-card" style="background:linear-gradient(135deg,rgba(245,166,35,0.08),rgba(245,166,35,0.04));border-color:rgba(245,166,35,0.25);">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
      <h3 style="margin:0;">🔔 Push Notifications</h3>
      ${pushPermission === 'granted'
        ? `<label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
            <span style="font-size:0.82rem;color:var(--muted);">${pushEnabled?'Active':'Inactive'}</span>
            <div onclick="db.settings.pushEnabled=!db.settings.pushEnabled;save();renderSettings();" style="position:relative;width:44px;height:24px;background:${pushEnabled?'var(--yellow)':'var(--border)'};border-radius:25px;transition:background 0.2s;flex-shrink:0;">
              <div style="position:absolute;top:3px;left:${pushEnabled?'23px':'3px'};width:18px;height:18px;background:#fff;border-radius:50%;transition:left 0.2s;box-shadow:0 1px 4px rgba(0,0,0,0.2);"></div>
            </div>
          </label>`
        : `<button onclick="requestPushPermission().then(ok=>{if(ok)renderSettings();})" style="background:var(--yellow);border:none;color:#000;padding:8px 18px;border-radius:8px;font-weight:700;font-size:0.8rem;cursor:pointer;">Enable Notifications</button>`
      }
    </div>
    <div style="font-size:0.8rem;color:var(--muted);">Get notified instantly when new leads are added, invoices are overdue, or follow-ups are due — even when the app isn't open.</div>
    ${pushPermission === 'granted' ? `<div style="margin-top:12px;padding:10px 14px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:8px;font-size:0.78rem;color:#16a34a;">✅ Notifications are enabled on this device.</div>` : ''}
  </div>`;

  // Google Calendar section
  const gcalConnected = !!localStorage.getItem('bh_gcal_token');
  const gcalSection = `<div class="settings-card" style="grid-column:1/-1;background:linear-gradient(135deg,rgba(66,133,244,0.08),rgba(52,168,83,0.05));border-color:rgba(66,133,244,0.25);">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
      <h3 style="margin:0;">📅 Google Calendar Sync</h3>
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
        <span style="font-size:0.82rem;color:var(--muted);">${s.gcalEnabled?'Active':'Inactive'}</span>
        <div onclick="toggleGcal()" style="position:relative;width:44px;height:24px;background:${s.gcalEnabled?'#4285f4':'var(--border)'};border-radius:25px;transition:background 0.2s;flex-shrink:0;">
          <div style="position:absolute;top:3px;left:${s.gcalEnabled?'23px':'3px'};width:18px;height:18px;background:#fff;border-radius:50%;transition:left 0.2s;box-shadow:0 1px 4px rgba(0,0,0,0.2);"></div>
        </div>
      </label>
    </div>
    <div style="color:var(--muted);font-size:0.8rem;margin-bottom:20px;">When enabled, jobs added to Blueprint Hub automatically appear in your Google Calendar.</div>
    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
      <button onclick="connectGoogleCalendar().then(()=>{renderSettings();}).catch(e=>alert('Could not connect: '+e))"
        style="background:${gcalConnected?'rgba(52,168,83,0.15)':'#4285f4'};color:${gcalConnected?'#16a34a':'#fff'};border:${gcalConnected?'1px solid rgba(52,168,83,0.3)':'none'};padding:10px 20px;border-radius:8px;font-weight:600;font-size:0.88rem;cursor:pointer;">
        ${gcalConnected?'✅ Google Calendar Connected':'🔗 Connect Google Calendar'}
      </button>
      ${gcalConnected?`<button onclick="localStorage.removeItem('bh_gcal_token');gcalToken=null;renderSettings();" style="background:none;border:1px solid var(--border);color:var(--muted);padding:10px 16px;border-radius:8px;font-size:0.82rem;cursor:pointer;">Disconnect</button>`:''}
    </div>
    <div style="margin-top:16px;padding:12px 16px;background:${s.gcalEnabled&&gcalConnected?'rgba(34,197,94,0.08)':'rgba(239,68,68,0.08)'};border:1px solid ${s.gcalEnabled&&gcalConnected?'rgba(34,197,94,0.2)':'rgba(239,68,68,0.2)'};border-radius:8px;font-size:0.8rem;color:${s.gcalEnabled&&gcalConnected?'#16a34a':'#dc2626'};">
      ${s.gcalEnabled&&gcalConnected?'✅ Jobs will sync to your Google Calendar automatically.':!gcalConnected?'⚠️ Connect your Google Calendar to enable sync.':'⏸️ Calendar sync is paused.'}
    </div>
  </div>`;

  document.getElementById('settings-grid').innerHTML = receptionistSection + gcalSection + pushSection + teamSection + sections.map(sec=>`
    <div class="settings-card">
      <h3>${sec.label}</h3>
      <div class="settings-tags" id="tags-${sec.key}">
        ${(s[sec.key]||[]).map(v=>`<div class="settings-tag">${v}<span class="tag-remove" onclick="removeTag('${sec.key}','${v}')">✕</span></div>`).join('')}
      </div>
      <div class="settings-add">
        <input type="text" id="input-${sec.key}" placeholder="Add new..." onkeydown="if(event.key==='Enter')addTag('${sec.key}')"/>
        <button onclick="addTag('${sec.key}')">+</button>
      </div>
    </div>`).join('');
}

function updateMemberPhone(name, phone){
  if(!db.settings.teamMemberPhones) db.settings.teamMemberPhones={};
  db.settings.teamMemberPhones[name] = phone.trim();
  save();
}
function addMember(){
  const inp=document.getElementById('input-teamMembers');
  const val=inp.value.trim();
  if(!val)return;
  if(!db.settings.teamMembers.includes(val)){db.settings.teamMembers.push(val);save();renderSettings();}
  inp.value='';
}
function removeMember(name){
  db.settings.teamMembers=db.settings.teamMembers.filter(v=>v!==name);
  if(db.settings.teamMemberPhones) delete db.settings.teamMemberPhones[name];
  save();renderSettings();
}
function addTag(key){
  const inp=document.getElementById('input-'+key);
  const val=inp.value.trim();
  if(!val)return;
  if(!db.settings[key].includes(val)){db.settings[key].push(val);save();renderSettings();}
  inp.value='';
}
function removeTag(key,val){
  db.settings[key]=db.settings[key].filter(v=>v!==val);
  save();renderSettings();
}
function updateReceptionist(key, value){
  if(!db.settings.receptionist) db.settings.receptionist = {};
  db.settings.receptionist[key] = value.trim();
  save();
}
function toggleReceptionist(){
  if(!db.settings.receptionist) db.settings.receptionist = {};
  db.settings.receptionist.enabled = db.settings.receptionist.enabled === false ? true : false;
  save();
  renderSettings();
}
function toggleGcal(){
  db.settings.gcalEnabled = !db.settings.gcalEnabled;
  save();
  renderSettings();
}
const AUTOMATION_URL = 'https://blueprint-hub-production.up.railway.app';
const STRIPE_PUB_KEY = 'pk_test_51TgF16Q0wV9of21BF994UTNjE7x5bjyDlXSIyFnEKwxB2G9qV274XADEEtBfUpGq7iu9ip5WNLxW3Z3zSsstgy2300PSLRhgTE';

const PLANS_UI = [
  { id:'starter', name:'Starter', price:49, color:'#5B8DEF', features:['Leads, Jobs, Invoices','AI Quick Entry','Import & Export','Google Calendar Sync','Email support'] },
  { id:'pro', name:'Pro', price:149, color:'#F5A623', badge:'Most Popular', features:['Everything in Starter','AI Receptionist (SMS)','6 Automated Follow-ups','AI Weekly Insights','Kanban Board','Priority support'] },
  { id:'agency', name:'Agency', price:297, color:'#4CAF7D', features:['Everything in Pro','Done-for-you setup','Monthly check-in call','White-label ready','Dedicated support'] }
];

function renderSubscriptionSection(){
  const el = document.getElementById('subscription-section');
  if(!el) return;
  const sub = db.subscription || {};
  const currentPlan = sub.plan || null;
  const status = sub.status || null;
  const isTrialing = status === 'trialing';
  const isActive = status === 'active' || isTrialing;

  el.innerHTML = `
    <div style="padding:28px 0 8px;border-top:1px solid var(--border);margin-top:8px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <div>
          <div style="font-weight:700;font-size:0.95rem;">Blueprint Hub Subscription</div>
          <div style="font-size:0.78rem;color:var(--muted);margin-top:3px;">
            ${isTrialing ? '🎉 Free trial active' : isActive ? `✅ ${currentPlan ? currentPlan.charAt(0).toUpperCase()+currentPlan.slice(1) : ''} Plan — Active` : '⭐ 14-day free trial on any plan'}
          </div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;">
        ${PLANS_UI.map(p => `
          <div style="background:${currentPlan===p.id?'rgba(245,166,35,0.08)':' var(--dark3)'};border:1.5px solid ${currentPlan===p.id?'var(--yellow)':'var(--border)'};border-radius:12px;padding:20px;position:relative;">
            ${p.badge ? `<div style="position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:var(--yellow);color:#000;font-size:0.65rem;font-weight:800;padding:3px 12px;border-radius:20px;white-space:nowrap;">${p.badge}</div>` : ''}
            <div style="font-size:0.72rem;font-weight:700;color:${p.color};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">${p.name}</div>
            <div style="font-size:1.6rem;font-weight:800;margin-bottom:12px;">$${p.price}<span style="font-size:0.75rem;color:var(--muted);font-weight:400;">/mo</span></div>
            <ul style="list-style:none;display:flex;flex-direction:column;gap:5px;margin-bottom:16px;">
              ${p.features.map(f=>`<li style="font-size:0.75rem;color:var(--muted);display:flex;align-items:center;gap:6px;"><span style="color:${p.color};">✓</span>${f}</li>`).join('')}
            </ul>
            ${currentPlan===p.id
              ? `<div style="text-align:center;font-size:0.75rem;color:var(--yellow);font-weight:600;">Current Plan</div>`
              : `<button onclick="startCheckout('${p.id}')" style="width:100%;background:${p.color};border:none;color:${p.id==='pro'?'#000':'#fff'};padding:10px;border-radius:8px;font-weight:700;font-size:0.82rem;cursor:pointer;">
                  ${isActive ? 'Switch Plan' : 'Start Free Trial'}
                </button>`
            }
          </div>`).join('')}
      </div>
      <div style="margin-top:12px;font-size:0.72rem;color:var(--muted);text-align:center;">14-day free trial · No credit card required to start · Cancel anytime</div>
    </div>`;
}

async function startCheckout(plan){
  if(!currentUser) return;
  const btn = event.target;
  btn.textContent = 'Loading...';
  btn.disabled = true;
  try {
    const res = await fetch(`${AUTOMATION_URL}/create-checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, userId: currentUser.id, email: currentUser.email })
    });
    const data = await res.json();
    if(data.url) window.location.href = data.url;
    else throw new Error(data.error || 'Failed to create checkout');
  } catch(e) {
    btn.textContent = 'Start Free Trial';
    btn.disabled = false;
    alert('Could not start checkout: ' + e.message);
  }
}

// Check for subscription success redirect
(function checkSubscriptionRedirect(){
  const params = new URLSearchParams(window.location.search);
  if(params.get('subscribed') === 'true'){
    const plan = params.get('plan');
    if(!db.subscription) db.subscription = {};
    db.subscription = { status: 'trialing', plan };
    save();
    window.history.replaceState({}, '', window.location.pathname);
    setTimeout(() => showToast('🎉 Subscription activated! Welcome to Blueprint Hub ' + (plan||'') + ' Plan.'), 1000);
  }
})();

function renderSettingsSignOut(){
  const el = document.getElementById('settings-signout');
  if(!el) return;
  el.innerHTML = `
    <div style="padding:24px 0 8px;border-top:1px solid var(--border);margin-top:8px;">
      <div style="margin-bottom:12px;">
        <div style="font-size:0.78rem;color:var(--muted);margin-bottom:2px;">Signed in as</div>
        <div style="font-size:0.88rem;font-weight:600;color:var(--text);">${currentUser?.email || ''}</div>
      </div>
      <button onclick="doLogout()" style="background:rgba(224,82,82,0.1);border:1px solid rgba(224,82,82,0.3);color:#E05252;padding:10px 20px;border-radius:8px;font-size:0.88rem;font-weight:600;cursor:pointer;transition:all 0.2s;width:100%;" onmouseover="this.style.background='rgba(224,82,82,0.2)'" onmouseout="this.style.background='rgba(224,82,82,0.1)'">
        Sign Out
      </button>
    </div>`;
}

function render(page){
  if(page==='dashboard')renderDashboard();
  else if(page==='leads')renderLeads();
  else if(page==='estimates')renderEstimates();
  else if(page==='jobs')renderJobs();
  else if(page==='invoices')renderInvoices();
  else if(page==='followups')renderFollowups();
  else if(page==='clients')renderClients();
  else if(page==='summaries')renderSummaries();
  else if(page==='settings')renderSettings();
}
function renderAll(){renderDashboard();renderLeads();renderEstimates();renderJobs();renderInvoices();renderImport();renderQBExport();renderFollowups();renderClients();renderSummaries();renderSettings();updateNavBadges();}

// ── MODAL FORMS ───────────────────────────────────────────────────────────────
function sel(key){return(db.settings[key]||[]).map(v=>`<option value="${v}">${v}</option>`).join('');}

const FORMS={
  lead:(d={})=>`<div class="form-grid">
    <div class="form-group"><label>First Name *</label><input id="f-firstName" value="${d.firstName||''}"/></div>
    <div class="form-group"><label>Last Name</label><input id="f-lastName" value="${d.lastName||''}"/></div>
    <div class="form-group"><label>Phone</label><input id="f-phone" value="${d.phone||''}"/></div>
    <div class="form-group"><label>Email</label><input id="f-email" value="${d.email||''}"/></div>
    <div class="form-group full"><label>Address</label><input id="f-address" value="${d.address||''}"/></div>
    <div class="form-group"><label>Service Type</label><select id="f-serviceType"><option value="">Select...</option>${sel('serviceTypes')}</select></div>
    <div class="form-group"><label>Lead Source</label><select id="f-source"><option value="">Select...</option>${sel('leadSources')}</select></div>
    <div class="form-group"><label>Lead Status</label><select id="f-status"><option value="">Select...</option>${sel('leadStatuses')}</select></div>
    <div class="form-group"><label>Date Added</label><input type="date" id="f-dateAdded" value="${d.dateAdded||today()}"/></div>
    <div class="form-group"><label>Next Follow-Up Date</label><input type="date" id="f-followUpDate" value="${d.followUpDate||''}"/></div>
    <div class="form-group"><label>Assigned To</label><select id="f-assignedTo"><option value="">Select...</option>${sel('teamMembers')}</select></div>
    <div class="form-group"><label>Estimated Value ($)</label><input type="number" id="f-value" value="${d.value||''}"/></div>
    <div class="form-group full"><label>Notes</label><textarea id="f-notes">${d.notes||''}</textarea></div>
  </div>`,
  estimate:(d={})=>`<div class="form-grid">
    <div class="form-group"><label>Client/Lead Name *</label><input id="f-clientName" value="${d.clientName||''}"/></div>
    <div class="form-group"><label>Linked Lead ID</label><input id="f-linkedLeadId" value="${d.linkedLeadId||''}"/></div>
    <div class="form-group"><label>Service Type</label><select id="f-serviceType"><option value="">Select...</option>${sel('serviceTypes')}</select></div>
    <div class="form-group"><label>Estimate Amount ($)</label><input type="number" id="f-amount" value="${d.amount||''}"/></div>
    <div class="form-group"><label>Status</label><select id="f-status"><option value="">Select...</option>${sel('estimateStatuses')}</select></div>
    <div class="form-group"><label>Date Created</label><input type="date" id="f-dateCreated" value="${d.dateCreated||today()}"/></div>
    <div class="form-group"><label>Sent Date</label><input type="date" id="f-sentDate" value="${d.sentDate||''}"/></div>
    <div class="form-group"><label>Follow-Up Date</label><input type="date" id="f-followUpDate" value="${d.followUpDate||''}"/></div>
    <div class="form-group"><label>Approved Date</label><input type="date" id="f-approvedDate" value="${d.approvedDate||''}"/></div>
    <div class="form-group full"><label>Notes</label><textarea id="f-notes">${d.notes||''}</textarea></div>
  </div>`,
  job:(d={})=>`<div class="form-grid">
    <div class="form-group"><label>Client Name *</label><input id="f-clientName" value="${d.clientName||''}"/></div>
    <div class="form-group"><label>Linked Estimate ID</label><input id="f-linkedEstimateId" value="${d.linkedEstimateId||''}"/></div>
    <div class="form-group"><label>Service Type</label><select id="f-serviceType"><option value="">Select...</option>${sel('serviceTypes')}</select></div>
    <div class="form-group"><label>Job Value ($)</label><input type="number" id="f-value" value="${d.value||''}"/></div>
    <div class="form-group"><label>Job Status</label><select id="f-status"><option value="">Select...</option>${sel('jobStatuses')}</select></div>
    <div class="form-group"><label>Priority</label><select id="f-priority"><option value="">Select...</option>${sel('priorityLevels')}</select></div>
    <div class="form-group"><label>Start Date</label><input type="date" id="f-startDate" value="${d.startDate||''}"/></div>
    <div class="form-group"><label>End Date</label><input type="date" id="f-endDate" value="${d.endDate||''}"/></div>
    <div class="form-group"><label>Assigned To</label><select id="f-assignedTo"><option value="">Select...</option>${sel('teamMembers')}</select></div>
    <div class="form-group full"><label>Notes</label><textarea id="f-notes">${d.notes||''}</textarea></div>
  </div>`,
  invoice:(d={})=>`<div class="form-grid">
    <div class="form-group"><label>Client Name *</label><input id="f-clientName" value="${d.clientName||''}"/></div>
    <div class="form-group"><label>Linked Job ID</label><input id="f-linkedJobId" value="${d.linkedJobId||''}"/></div>
    <div class="form-group"><label>Invoice Amount ($)</label><input type="number" id="f-amount" value="${d.amount||''}"/></div>
    <div class="form-group"><label>Amount Paid ($)</label><input type="number" id="f-amountPaid" value="${d.amountPaid||''}"/></div>
    <div class="form-group"><label>Date Sent</label><input type="date" id="f-dateSent" value="${d.dateSent||today()}"/></div>
    <div class="form-group"><label>Due Date</label><input type="date" id="f-dueDate" value="${d.dueDate||''}"/></div>
    <div class="form-group"><label>Payment Date</label><input type="date" id="f-paymentDate" value="${d.paymentDate||''}"/></div>
    <div class="form-group full"><label>Notes</label><textarea id="f-notes">${d.notes||''}</textarea></div>
  </div>`,
  followup:(d={})=>`<div class="form-grid">
    <div class="form-group"><label>Client/Lead Name *</label><input id="f-name" value="${d.name||''}"/></div>
    <div class="form-group"><label>Related Type</label><select id="f-relatedType"><option value="">Select...</option><option>Lead</option><option>Estimate</option><option>Invoice</option><option>Client</option></select></div>
    <div class="form-group"><label>Related ID</label><input id="f-relatedId" value="${d.relatedId||''}"/></div>
    <div class="form-group"><label>Due Date</label><input type="date" id="f-dueDate" value="${d.dueDate||today()}"/></div>
    <div class="form-group full"><label>Reason</label><input id="f-reason" value="${d.reason||''}"/></div>
    <div class="form-group"><label>Status</label><select id="f-status"><option value="">Select...</option>${sel('followUpStatuses')}</select></div>
    <div class="form-group"><label>Owner</label><select id="f-owner"><option value="">Select...</option>${sel('teamMembers')}</select></div>
    <div class="form-group full"><label>Notes</label><textarea id="f-notes">${d.notes||''}</textarea></div>
  </div>`,
  client:(d={})=>`<div class="form-grid">
    <div class="form-group"><label>Client Name *</label><input id="f-name" value="${d.name||''}"/></div>
    <div class="form-group"><label>Phone</label><input id="f-phone" value="${d.phone||''}"/></div>
    <div class="form-group"><label>Email</label><input id="f-email" value="${d.email||''}"/></div>
    <div class="form-group"><label>Service Type</label><select id="f-serviceType"><option value="">Select...</option>${sel('serviceTypes')}</select></div>
    <div class="form-group full"><label>Service Address</label><input id="f-serviceAddress" value="${d.serviceAddress||''}"/></div>
    <div class="form-group full"><label>Billing Address</label><input id="f-billingAddress" value="${d.billingAddress||''}"/></div>
    <div class="form-group"><label>First Job Date</label><input type="date" id="f-firstJobDate" value="${d.firstJobDate||''}"/></div>
    <div class="form-group"><label>Last Job Date</label><input type="date" id="f-lastJobDate" value="${d.lastJobDate||''}"/></div>
    <div class="form-group"><label>Status</label><select id="f-status"><option value="">Select...</option>${sel('clientStatuses')}</select></div>
    <div class="form-group full"><label>Notes</label><textarea id="f-notes">${d.notes||''}</textarea></div>
  </div>`,
};

function gv(id){const el=document.getElementById(id);return el?el.value:'';}

const SAVERS={
  lead:(id)=>({id,firstName:gv('f-firstName'),lastName:gv('f-lastName'),phone:gv('f-phone'),email:gv('f-email'),address:gv('f-address'),serviceType:gv('f-serviceType'),source:gv('f-source'),status:gv('f-status'),dateAdded:gv('f-dateAdded'),followUpDate:gv('f-followUpDate'),assignedTo:gv('f-assignedTo'),value:gv('f-value'),notes:gv('f-notes')}),
  estimate:(id)=>({id,clientName:gv('f-clientName'),linkedLeadId:gv('f-linkedLeadId'),serviceType:gv('f-serviceType'),amount:gv('f-amount'),status:gv('f-status'),dateCreated:gv('f-dateCreated'),sentDate:gv('f-sentDate'),followUpDate:gv('f-followUpDate'),approvedDate:gv('f-approvedDate'),notes:gv('f-notes')}),
  job:(id)=>({id,clientName:gv('f-clientName'),linkedEstimateId:gv('f-linkedEstimateId'),serviceType:gv('f-serviceType'),value:gv('f-value'),status:gv('f-status'),priority:gv('f-priority'),startDate:gv('f-startDate'),endDate:gv('f-endDate'),assignedTo:gv('f-assignedTo'),notes:gv('f-notes')}),
  invoice:(id)=>({id,clientName:gv('f-clientName'),linkedJobId:gv('f-linkedJobId'),amount:gv('f-amount'),amountPaid:gv('f-amountPaid'),dateSent:gv('f-dateSent'),dueDate:gv('f-dueDate'),paymentDate:gv('f-paymentDate'),notes:gv('f-notes')}),
  followup:(id)=>({id,name:gv('f-name'),relatedType:gv('f-relatedType'),relatedId:gv('f-relatedId'),dueDate:gv('f-dueDate'),reason:gv('f-reason'),status:gv('f-status'),owner:gv('f-owner'),notes:gv('f-notes')}),
  client:(id)=>({id,name:gv('f-name'),phone:gv('f-phone'),email:gv('f-email'),serviceType:gv('f-serviceType'),serviceAddress:gv('f-serviceAddress'),billingAddress:gv('f-billingAddress'),firstJobDate:gv('f-firstJobDate'),lastJobDate:gv('f-lastJobDate'),status:gv('f-status'),notes:gv('f-notes')}),
};

const TYPE_MAP={lead:'leads',estimate:'estimates',job:'jobs',invoice:'invoices',followup:'followups',client:'clients'};
const PREFIX_MAP={lead:'L',estimate:'E',job:'J',invoice:'INV',followup:'FU',client:'C'};
const TITLES={lead:'Lead',estimate:'Estimate',job:'Job',invoice:'Invoice',followup:'Follow-Up',client:'Client'};

function openModal(type,id=null){
  editingType=type;editingId=id;
  const arr=db[TYPE_MAP[type]];
  const existing=id?arr.find(r=>r.id===id):{};
  document.getElementById('modal-title').textContent=(id?'Edit ':'Add ')+TITLES[type];
  document.getElementById('modal-body').innerHTML=FORMS[type](existing||{});
  // Set select values after render
  if(existing){
    setTimeout(()=>{
      ['serviceType','source','status','assignedTo','priority','relatedType','owner'].forEach(f=>{
        const el=document.getElementById('f-'+f);
        if(el&&existing[f])el.value=existing[f];
      });
    },10);
  }
  document.getElementById('modal-overlay').classList.add('open');
  // Auto-focus first input
  setTimeout(()=>{
    const first = document.querySelector('#modal-body input, #modal-body select');
    if(first) first.focus();
  }, 50);
}

function closeModal(){
  document.getElementById('modal-overlay').classList.remove('open');
  editingType=null;editingId=null;
}

async function fireWebhook(event, record){
  const AUTOMATION_URL = 'https://blueprint-hub-production.up.railway.app';
  const businessName = db.settings?.businessName || 'Your Contractor';
  try {
    const payload = { event, business_name: businessName, ...record };
    await fetch(`${AUTOMATION_URL}/webhook/${event}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log(`✅ Webhook fired: ${event}`);
  } catch(e) {
    console.warn('Webhook error (non-critical):', e.message);
  }
}

function saveModal(){
  const type=editingType;
  const arr=db[TYPE_MAP[type]];
  const id=editingId||genId(PREFIX_MAP[type],arr);
  const record=SAVERS[type](id);
  const isNew = !editingId;
  if(editingId){
    const idx=arr.findIndex(r=>r.id===editingId);
    if(idx>=0)arr[idx]=record;
  } else {
    arr.push(record);
  }
  save();closeModal();
  const pageMap={leads:'leads',estimates:'estimates',jobs:'jobs',invoices:'invoices',followups:'followups',clients:'clients'};
  render(pageMap[TYPE_MAP[type]]||'dashboard');
  renderDashboard();
  updateNavBadges();

  // 🔔 Push notification for new records
  if(isNew) triggerPushForRecord(type, record);

  // 🔥 Fire automations on new records
  if(isNew){
    if(type === 'leads') fireWebhook('lead-created', record);
    if(type === 'estimates') fireWebhook('estimate-sent', record);
    if(type === 'jobs' && record.status === 'Approved') fireWebhook('job-approved', record);
    if(type === 'jobs' && record.status === 'Completed') fireWebhook('job-completed', record);
  }

  // 📅 Sync to Google Calendar for jobs
  if(type === 'jobs' && db.settings.gcalEnabled){
    const syncStatuses = ['Approved','Scheduled','In Progress','Completed'];
    if(syncStatuses.includes(record.status)){
      if(isNew) addJobToCalendar(record);
      else updateJobInCalendar(record);
    }
  }
}

function deleteRecord(collection,id){
  if(!confirm('Delete this record?'))return;
  db[collection]=db[collection].filter(r=>r.id!==id);
  save();
  const pageMap={leads:'leads',estimates:'estimates',jobs:'jobs',invoices:'invoices',followups:'followups',clients:'clients'};
  render(pageMap[collection]||'dashboard');
  renderDashboard();
  updateNavBadges();
}

// ── QUICK ENTRY AI ────────────────────────────────────────────────────────────
let pendingQuickRecord = null;
let isRecording = false;
let recognition = null;

function parseQuickEntry(text) {
  const t = text.toLowerCase();
  const result = { type: null, data: {}, summary: '' };

  // Extract name (First Last pattern)
  const nameMatch = text.match(/\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/);
  const firstName = nameMatch ? nameMatch[1] : '';
  const lastName = nameMatch ? nameMatch[2] : '';
  const fullName = nameMatch ? `${firstName} ${lastName}` : '';

  // Extract phone
  const phoneMatch = text.match(/(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/);
  const phone = phoneMatch ? phoneMatch[1] : '';

  // Extract dollar amount
  const moneyMatch = text.match(/\$?([\d,]+(?:\.\d{2})?)\s*(?:dollars?|bucks?)?/);
  const amount = moneyMatch ? moneyMatch[1].replace(',','') : '';

  // Extract service type
  const services = db.settings.serviceTypes || [];
  let serviceType = '';
  services.forEach(s => { if(t.includes(s.toLowerCase())) serviceType = s; });

  // Extract lead source
  const sources = db.settings.leadSources || [];
  let source = '';
  sources.forEach(s => { if(t.includes(s.toLowerCase())) source = s; });

  // Extract date
  const dateMatch = text.match(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/);
  let dateStr = '';
  if(dateMatch) {
    const parts = dateMatch[1].split(/[\/\-]/);
    if(parts.length >= 2) {
      const yr = parts[2] ? (parts[2].length === 2 ? '20'+parts[2] : parts[2]) : new Date().getFullYear();
      dateStr = `${yr}-${String(parts[0]).padStart(2,'0')}-${String(parts[1]).padStart(2,'0')}`;
    }
  }

  // ── DETECT INTENT ──

  // NEW LEAD
  if(t.includes('new lead') || t.includes('new client inquiry') || t.includes('got a lead') || t.includes('lead came in') || (t.includes('called') && !t.includes('invoice') && !t.includes('job'))) {
    result.type = 'lead';
    result.data = {
      firstName, lastName, phone,
      serviceType: serviceType || '',
      source: source || 'Phone',
      status: 'New',
      dateAdded: today(),
      value: amount || '',
    };
    result.summary = `📋 <strong>New Lead</strong><br>
      Name: ${fullName || '(not detected)'}<br>
      ${phone ? 'Phone: '+phone+'<br>' : ''}
      ${serviceType ? 'Service: '+serviceType+'<br>' : ''}
      ${source ? 'Source: '+source+'<br>' : ''}
      ${amount ? 'Est. Value: $'+amount : ''}`;
    return result;
  }

  // NEW INVOICE
  if(t.includes('invoice') || t.includes('bill') || (t.includes('job done') || t.includes('job finished') || t.includes('job complete') || t.includes('finished the'))) {
    result.type = 'invoice';
    // Find matching client/job
    const matchedJob = db.jobs.find(j => fullName && j.clientName && j.clientName.toLowerCase().includes(firstName.toLowerCase()));
    result.data = {
      clientName: fullName || (matchedJob ? matchedJob.clientName : ''),
      linkedJobId: matchedJob ? matchedJob.id : '',
      amount: amount || '',
      dateSent: today(),
      dueDate: (() => { const d = new Date(); d.setDate(d.getDate()+30); return d.toISOString().split('T')[0]; })(),
      amountPaid: '0',
    };
    result.summary = `🧾 <strong>New Invoice</strong><br>
      Client: ${fullName || '(not detected)'}<br>
      Amount: ${amount ? '$'+Number(amount).toLocaleString() : '(not detected)'}<br>
      Due: 30 days from today<br>
      ${matchedJob ? 'Linked Job: '+matchedJob.id : ''}`;
    return result;
  }

  // NEW JOB
  if(t.includes('new job') || t.includes('starting job') || t.includes('job starts') || t.includes('signed') || t.includes('approved') || t.includes('won the job')) {
    result.type = 'job';
    result.data = {
      clientName: fullName || '',
      serviceType: serviceType || '',
      value: amount || '',
      status: 'Scheduled',
      startDate: dateStr || '',
      priority: 'Medium',
    };
    result.summary = `🏗️ <strong>New Job</strong><br>
      Client: ${fullName || '(not detected)'}<br>
      ${serviceType ? 'Service: '+serviceType+'<br>' : ''}
      ${amount ? 'Value: $'+amount+'<br>' : ''}
      ${dateStr ? 'Start: '+fmt(dateStr) : ''}`;
    return result;
  }

  // FOLLOW-UP
  if(t.includes('follow up') || t.includes('follow-up') || t.includes('call back') || t.includes('check in') || t.includes('remind')) {
    result.type = 'followup';
    result.data = {
      name: fullName || '',
      reason: text.replace(/follow.?up|remind me|call back|check in/gi,'').trim(),
      dueDate: dateStr || today(),
      status: 'Open',
      owner: 'Owner',
      relatedType: 'Lead',
    };
    result.summary = `🔔 <strong>Follow-Up</strong><br>
      Name: ${fullName || '(not detected)'}<br>
      Reason: ${result.data.reason || text}<br>
      Due: ${fmt(result.data.dueDate)}`;
    return result;
  }

  // ESTIMATE
  if(t.includes('estimate') || t.includes('quote') || t.includes('bid')) {
    result.type = 'estimate';
    result.data = {
      clientName: fullName || '',
      serviceType: serviceType || '',
      amount: amount || '',
      status: 'Draft',
      dateCreated: today(),
    };
    result.summary = `📐 <strong>New Estimate</strong><br>
      Client: ${fullName || '(not detected)'}<br>
      ${serviceType ? 'Service: '+serviceType+'<br>' : ''}
      ${amount ? 'Amount: $'+amount : '(amount not detected)'}`;
    return result;
  }

  // Couldn't detect
  result.type = null;
  result.summary = `❓ Couldn't figure out what to create from that. Try being more specific, like:<br><br>
    • "New lead John Smith, roofing, called from Google, 555-1234"<br>
    • "Job done for Maria, send invoice $4500"<br>
    • "Follow up with Bob Johnson tomorrow"<br>
    • "New estimate for Dave, concrete, $8000"`;
  return result;
}

// ── AI INVOICE GENERATOR ─────────────────────────────────────────────────────
let generatedInvoiceData = null;

async function generateInvoiceFromJob(jobId){
  const job = db.jobs.find(j => j.id === jobId);
  if(!job) return;

  // Check plan — AI Invoice Generator is Pro+ only
  const plan = db.subscription?.plan;
  const hasAccess = plan === 'pro' || plan === 'agency';
  if(!hasAccess){
    document.getElementById('invoice-gen-overlay').classList.add('open');
    document.getElementById('save-invoice-btn').style.display = 'none';
    document.getElementById('view-invoice-btn').style.display = 'none';
    document.getElementById('invoice-gen-body').innerHTML = `
      <div style="text-align:center;padding:40px 24px;">
        <div style="font-size:3rem;margin-bottom:16px;">🔒</div>
        <div style="font-size:1rem;font-weight:700;margin-bottom:8px;">AI Invoice Generator</div>
        <div style="color:var(--muted);font-size:0.88rem;margin-bottom:28px;line-height:1.7;">This feature is available on the <strong style="color:var(--yellow);">Pro</strong> and <strong style="color:#4CAF7D;">Agency</strong> plans.<br>Upgrade to automatically generate professional invoices from any job.</div>
        <button onclick="closeInvoiceGen();showPage('settings',null);setTimeout(()=>document.getElementById('subscription-section')?.scrollIntoView({behavior:'smooth'}),300);" style="background:var(--yellow);border:none;color:#000;padding:12px 28px;border-radius:8px;font-weight:700;font-size:0.9rem;cursor:pointer;">⚡ Upgrade to Pro</button>
      </div>`;
    return;
  }

  document.getElementById('invoice-gen-overlay').classList.add('open');
  document.getElementById('save-invoice-btn').style.display = 'none';
  document.getElementById('view-invoice-btn').style.display = 'none';
  document.getElementById('invoice-gen-body').innerHTML = `
    <div style="text-align:center;padding:40px 0;color:var(--muted);">
      <div style="font-size:2rem;margin-bottom:12px;">🤖</div>
      <div>Claude is building your invoice...</div>
    </div>`;

  // Get linked client info
  const client = db.clients.find(c => c.name === job.clientName);
  const businessName = db.settings?.businessName || 'Your Business';
  const businessPhone = db.settings?.teamMemberPhones?.Owner || '';

  // Ask Claude to generate line items
  let lineItems = [];
  try {
    const prompt = `You are a contractor invoice assistant. Generate professional line items for this job:

Job type: ${job.serviceType || 'General contractor work'}
Client: ${job.clientName || 'Client'}
Total value: $${job.value || '0'}
Notes: ${job.notes || 'No notes'}
Start date: ${job.startDate || ''}
End date: ${job.endDate || ''}

Generate 2-5 specific line items that would be typical for this type of job. Break down the total into realistic line items.
Return ONLY valid JSON array: [{"description": "...", "amount": 000.00}, ...]
Make the total equal to ${job.value || '0'}.`;

    const res = await fetch(`${SUPABASE_URL}/functions/v1/ai-proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ mode: 'insights', message: prompt })
    });
    const result = await res.json();
    const text = result.insights || '';
    const match = text.match(/\[[\s\S]*\]/);
    if(match) lineItems = JSON.parse(match[0]);
  } catch(e) {
    // Fallback to single line item
    lineItems = [{ description: `${job.serviceType || 'Services'} — ${job.notes || 'As agreed'}`, amount: parseFloat(job.value) || 0 }];
  }

  const today = new Date().toISOString().split('T')[0];
  const dueDate = new Date(Date.now() + 30*86400000).toISOString().split('T')[0];
  const invoiceNum = `INV-${new Date().getFullYear()}-${String(db.invoices.length + 1).padStart(3,'0')}`;

  generatedInvoiceData = {
    invoiceNum, job, client, lineItems, businessName, businessPhone,
    today, dueDate,
    total: lineItems.reduce((s, i) => s + (i.amount || 0), 0)
  };

  // Render the invoice preview
  document.getElementById('invoice-gen-body').innerHTML = `
    <div style="background:var(--dark3);border-radius:10px;padding:20px;margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;">
        <div>
          <div style="font-size:1.1rem;font-weight:700;">${businessName}</div>
          ${businessPhone ? `<div style="font-size:0.8rem;color:var(--muted);">${businessPhone}</div>` : ''}
        </div>
        <div style="text-align:right;">
          <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">Invoice</div>
          <div style="font-size:0.9rem;font-weight:700;">${invoiceNum}</div>
        </div>
      </div>
      <div style="display:flex;gap:40px;margin-bottom:20px;font-size:0.82rem;">
        <div><div style="color:var(--muted);font-size:0.7rem;text-transform:uppercase;margin-bottom:3px;">Bill To</div><strong>${job.clientName || '—'}</strong></div>
        <div><div style="color:var(--muted);font-size:0.7rem;text-transform:uppercase;margin-bottom:3px;">Date</div>${today}</div>
        <div><div style="color:var(--muted);font-size:0.7rem;text-transform:uppercase;margin-bottom:3px;">Due</div>${dueDate}</div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:0.84rem;">
        <thead><tr style="border-bottom:1px solid var(--border);">
          <th style="text-align:left;padding:8px 0;color:var(--muted);font-size:0.7rem;text-transform:uppercase;">Description</th>
          <th style="text-align:right;padding:8px 0;color:var(--muted);font-size:0.7rem;text-transform:uppercase;">Amount</th>
        </tr></thead>
        <tbody>
          ${lineItems.map(li => `<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
            <td style="padding:10px 0;">${li.description}</td>
            <td style="text-align:right;padding:10px 0;font-weight:600;">$${parseFloat(li.amount||0).toFixed(2)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div style="display:flex;justify-content:flex-end;margin-top:16px;padding-top:12px;border-top:1px solid var(--border);">
        <div style="text-align:right;">
          <div style="font-size:0.78rem;color:var(--muted);">Total Due</div>
          <div style="font-size:1.4rem;font-weight:800;color:var(--yellow);">$${generatedInvoiceData.total.toFixed(2)}</div>
        </div>
      </div>
    </div>
    <div style="font-size:0.78rem;color:var(--muted);text-align:center;">Review the line items above. Save to add to your Invoices tab, or View PDF to print/send.</div>`;

  document.getElementById('save-invoice-btn').style.display = 'block';
  document.getElementById('view-invoice-btn').style.display = 'block';
}

function closeInvoiceGen(){
  document.getElementById('invoice-gen-overlay').classList.remove('open');
  generatedInvoiceData = null;
}

function saveGeneratedInvoice(){
  if(!generatedInvoiceData) return;
  const { invoiceNum, job, lineItems, today, dueDate, total } = generatedInvoiceData;
  const invoice = {
    id: invoiceNum,
    clientName: job.clientName,
    linkedJobId: job.id,
    amount: total.toFixed(2),
    amountPaid: '0',
    dateSent: today,
    dueDate: dueDate,
    status: 'Unpaid',
    notes: lineItems.map(li => `${li.description}: $${li.amount}`).join('\n')
  };
  db.invoices.push(invoice);
  save();
  closeInvoiceGen();
  showPage('invoices', document.querySelector('.nav-item[id="nav-invoices"]'));
  renderInvoices();
  updateNavBadges();
  showToast(`✅ Invoice ${invoiceNum} saved!`);
}

function viewGeneratedInvoice(){
  if(!generatedInvoiceData) return;
  const { invoiceNum, job, lineItems, businessName, businessPhone, today, dueDate, total } = generatedInvoiceData;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>${invoiceNum}</title>
  <style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f4f4f4;padding:40px 20px;}.invoice{background:#fff;max-width:700px;margin:0 auto;border-radius:4px;overflow:hidden;box-shadow:0 2px 20px rgba(0,0,0,0.1);}.header{background:#1a2744;color:#fff;padding:32px 40px;display:flex;justify-content:space-between;align-items:flex-start;}.company h2{font-size:1.5rem;font-weight:700;}.company p{font-size:0.8rem;opacity:0.6;margin-top:4px;}.inv-label{text-align:right;}.inv-label h3{font-size:1.6rem;font-weight:300;letter-spacing:4px;text-transform:uppercase;color:rgba(255,255,255,0.9);}.inv-label p{font-size:0.78rem;opacity:0.5;margin-top:4px;}.body{padding:32px 40px;}.meta{display:flex;gap:40px;margin-bottom:28px;font-size:0.85rem;}.meta-block h4{font-size:0.65rem;text-transform:uppercase;letter-spacing:2px;color:#888;margin-bottom:4px;}table{width:100%;border-collapse:collapse;}thead tr{background:#1a2744;color:#fff;}th{padding:10px 14px;text-align:left;font-size:0.72rem;text-transform:uppercase;}th:last-child{text-align:right;}tbody td{padding:12px 14px;border-bottom:1px solid #f0f0f0;font-size:0.86rem;}tbody td:last-child{text-align:right;font-weight:600;}.total-row{display:flex;justify-content:flex-end;margin-top:20px;}.total-box{min-width:220px;}.tr{display:flex;justify-content:space-between;padding:8px 0;font-size:0.86rem;border-bottom:1px solid #f0f0f0;}.tr.big{border:none;margin-top:8px;padding-top:10px;border-top:2px solid #1a2744;font-size:1rem;font-weight:700;color:#1a2744;}.footer{background:#f8f9fc;padding:20px 40px;font-size:0.78rem;color:#666;border-top:1px solid #eee;}</style>
  </head><body><div class="invoice">
  <div class="header"><div class="company"><h2>${businessName}</h2>${businessPhone?`<p>${businessPhone}</p>`:''}</div><div class="inv-label"><h3>Invoice</h3><p>#${invoiceNum}</p></div></div>
  <div class="body"><div class="meta"><div class="meta-block"><h4>Bill To</h4><strong>${job.clientName||'—'}</strong></div><div class="meta-block"><h4>Date</h4>${today}</div><div class="meta-block"><h4>Due Date</h4>${dueDate}</div></div>
  <table><thead><tr><th>Description</th><th style="text-align:right">Amount</th></tr></thead><tbody>
  ${lineItems.map(li=>`<tr><td>${li.description}</td><td>$${parseFloat(li.amount||0).toFixed(2)}</td></tr>`).join('')}
  </tbody></table>
  <div class="total-row"><div class="total-box"><div class="tr"><span>Subtotal</span><span>$${total.toFixed(2)}</span></div><div class="tr big"><span>Total Due</span><span>$${total.toFixed(2)}</span></div></div></div></div>
  <div class="footer">Payment due within 30 days. Thank you for your business!</div>
  </div><script>window.print();