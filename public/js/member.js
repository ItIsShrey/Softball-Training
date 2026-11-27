// Member view (index.html).
import { db, auth, configured, currentUser, logOut, telegramEnabled, signInTelegram, mountTelegramButton, telegramProfile, notifyExcos } from './store.js';
import { avatar, shrinkPhoto, safePhoto } from './ui.js';

const VENUES={MPSH:'MPSH (hall)',Kallang:'Kallang field',Jurong:'Jurong field'};
const TEAM=['A','B','C'];
const POSNAME={P:'Pitcher',C:'Catcher','1B':'First base','2B':'Second base',SS:'Shortstop','3B':'Third base',LF:'Left field',CF:'Centre field',RF:'Right field',R:'Rover'};
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const toMin=t=>{const[h,m]=String(t||'0:0').split(':').map(Number);return (h||0)*60+(m||0)};
const fmt=m=>{const h=Math.floor(m/60),mm=((m%60)+60)%60;return (((h+11)%12)+1)+':'+String(mm).padStart(2,'0')};
// "9:00am–12:00pm", or "7:00–9:30pm" when both ends share am or pm.
const span=(a,b)=>{const ap=t=>toMin(t)%1440<720?'am':'pm',x=ap(a),y=ap(b);return fmt(toMin(a))+(x===y?'':x)+'–'+fmt(toMin(b))+y};
const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const pretty=s=>new Date(s+'T12:00:00Z').toLocaleDateString('en-SG',{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'});
// Trainings are in Singapore, so "today" and start times are Singapore time whatever the phone is set to.
const dpart=(s,k)=>new Date(s+'T12:00:00Z').toLocaleDateString('en-SG',{[k]:k==='day'?'numeric':'short',timeZone:'UTC'});
const whenLabel=d=>{const n=Math.round((Date.parse(d)-Date.parse(sgToday()))/864e5);return n<=0?'Today':n===1?'Tomorrow':n<7?new Date(d+'T12:00:00Z').toLocaleDateString('en-SG',{weekday:'long',timeZone:'UTC'}):'In '+n+' days'};
const sgToday=()=>new Date(Date.now()+8*3600e3).toISOString().slice(0,10);
const blockMin=b=>b.kind==='rotation'?(+b.per||0)*(b.stations||[]).length:(+b.minutes||0);
const ordinal=n=>n+(['th','st','nd','rd'][(n%100-20)%10]||['th','st','nd','rd'][n%100]||'th');
const firstName=n=>{n=String(n||'');if(n.includes(','))return n.split(',')[1].trim();return n};
const norm=s=>String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,'').replace(/\s+/g,' ').trim();

const NEXT=new URLSearchParams(location.search).get('next');
const M={notes:{},photos:{},photosLoaded:false,admin:false,showProfile:false,req:null,uid:null,me:null,roster:{},sessions:[],rsvps:{},events:[],evReplies:{},q:'',pick:null,err:'',busy:false,open:{},form:null};
function copyText(txt){const done=()=>toast('Code copied');
  const fallback=()=>{const ta=document.createElement('textarea');ta.value=txt;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();let ok=false;try{ok=document.execCommand('copy')}catch(e){}ta.remove();ok?done():toast("Couldn't copy. Press and hold the code to copy it.")};
  try{navigator.clipboard.writeText(txt).then(done,fallback)}catch(e){fallback()}}
let toastT;
function toast(msg){const el=$('#toast');el.textContent=msg;el.hidden=false;clearTimeout(toastT);toastT=setTimeout(()=>el.hidden=true,2600)}

function render(){
  const app=$('#app');
  const a=document.activeElement,fid=a&&a.id;let sel=null;
  try{if(a&&'selectionStart' in a)sel=[a.selectionStart,a.selectionEnd]}catch(e){}
  if(M.status==='noconfig')app.innerHTML=`<section class="card"><h2>Not set up yet</h2><p class="muted">The club hasn't connected this page to its database yet.</p></section>`;
  else if(M.status==='loading')return;
  else if(M.status==='error')app.innerHTML=`<section class="card"><h2>Can't load trainings</h2><p class="muted">Check your connection and reload the page.</p></section>`;
  else if(M.status==='tglogin'){app.innerHTML=tgLoginHTML();mountTelegramButton(document.getElementById('tg-login'),onTelegram)}
  else if(M.status==='login')app.innerHTML=loginHTML();
  else app.innerHTML=homeHTML();
  if(fid){const el=document.getElementById(fid);if(el&&el!==document.activeElement){el.focus({preventScroll:true});try{if(sel&&sel[0]!=null)el.setSelectionRange(sel[0],sel[1])}catch(e){}}}
}

function tgLoginHTML(){
  return `<section class="card"><h2>${NEXT==='coach'?'Log in to the coach view':'Log in'}</h2>
    <p class="muted" style="margin:0">Everyone logs in here with Telegram, members and excos alike. You'll confirm in the Telegram app.</p>
    <div id="tg-login" style="min-height:48px"></div>
    ${M.err?`<div class="banner bad">${esc(M.err)}</div>`:''}</section>`;
}
async function onTelegram(user){
  M.status='loading';render();
  try{const u=await signInTelegram(user);await afterAuth(u)}
  catch(e){M.err=e&&e.message==='not_in_group'?"This page is for SMU Softball members. Log in with the Telegram account you use in the club group, or ask an exco to add you to the group.":"Telegram login didn't go through. Try again.";M.status='tglogin'}
  render();
}
function loginHTML(){
  const names=Object.entries(M.roster).sort((a,b)=>a[1].localeCompare(b[1]));
  const q=norm(M.q);
  const hits=q?names.filter(([,n])=>norm(n).includes(q)).slice(0,8):[];
  const picked=M.pick&&M.roster[M.pick];
  if(M.req){const n=M.roster[M.req.memberId]||'';
    return `<section class="card"><h2>Waiting for an exco</h2><p class="muted" style="margin:0">You asked to be linked as <b>${esc(n)}</b>. An exco will confirm it, and this page will update by itself. You only do this once.</p>
      <div class="row"><button class="ghost" data-act="cancelReq">That's not my name</button></div></section>${profileHTML()}`}
  return `<section class="card"><h2>Who are you?</h2>
    <p class="muted" style="margin:0">One last step: find your name on the team list. An exco will confirm it's you, and you only do this once.</p>
    ${picked?`<div class="who"><button aria-pressed="true" data-act="unpick">${esc(picked)} <span class="small" style="float:right;opacity:.8">Change</span></button></div>
      ${M.err?`<div class="banner bad">${esc(M.err)}</div>`:''}
      <button class="primary" data-act="request" style="padding:12px;font-size:16px"${M.busy?' disabled':''}>${M.busy?'Sending…':"That's me"}</button>`
    :`<label class="f">Your name<input class="big" id="q" data-input="q" value="${esc(M.q)}" placeholder="Start typing your name" autocomplete="off"></label>
      <div class="who">${hits.map(([id,n])=>`<button data-act="pick" data-id="${esc(id)}">${esc(n)}</button>`).join('')||(q?'<p class="small muted" style="margin:0">No one by that name. Ask an exco to add you.</p>':'')}</div>`}
    ${M.admin?'<div class="row"><button class="ghost" data-act="skip">Skip for now</button></div>':''}
  </section>${profileHTML()}`;
}

const meAv=size=>avatar(M.roster[M.me]||'?',M.photos[M.me],size,M.me||'');
const ICON={pin:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s7-5.6 7-11.5a7 7 0 1 0-14 0C5 15.4 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  clock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  cost:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>'};
function profileHTML(){
  const photo=M.me&&safePhoto(M.photos[M.me]);
  return `<section class="card"><h2>Your profile</h2>
    ${M.me?`<div class="prof">${meAv(64)}<div style="display:grid;gap:8px;min-width:0"><div class="nm">${esc(M.roster[M.me]||'')}</div>
      <div class="photo-btns"><label class="btnlink" style="background:var(--surface);color:var(--ink);border:1px solid var(--line2)">${photo?'Change photo':'Add a photo'}<input type="file" accept="image/*" data-photo></label>${photo?'<button class="ghost" data-act="photoRemove">Remove</button>':''}</div></div></div>
      ${M.photoErr?`<div class="banner bad">${esc(M.photoErr)}</div>`:''}`:''}
    <div style="display:grid;gap:6px"><span class="eyebrow">Your code</span><div class="codebox"><code>${esc(M.uid||'')}</code><button data-act="copyCode">Copy</button></div>
    <span class="small muted">${M.admin?"You're an exco, so you can open the coach view.":"Excos: send this code to the club owner so they can give you access to the planner."}</span></div>
    <div class="row">${M.me?'<button class="ghost" data-act="switch">Not you? Unlink this name</button>':'<button class="ghost" data-act="logout">Log out</button>'}</div></section>`;
}
function myRsvp(date){const r=(M.rsvps[date]||{})[M.me];return r?{...r,...(M.notes[date]||{})}:null}
function trainingHTML(x){
  const start=toMin(x.start),end=toMin(x.end);
  const rv=M.rsvps[x.date]||{};const yes=Object.keys(rv).filter(id=>rv[id].going&&M.roster[id]);const no=Object.keys(rv).filter(id=>!rv[id].going).length;
  const late=yes.filter(id=>rv[id].status!=='yes').length;
  const yesSorted=[...yes].sort((a,b)=>firstName(M.roster[a]).localeCompare(firstName(M.roster[b])));
  const mine=myRsvp(x.date),st=mine&&mine.status,going=!!(mine&&mine.going);
  const shut=closed(x.date);
  const f=!shut&&M.form&&M.form.date===x.date?M.form:null;
  const team=x.teamsVisible&&(x.attendees||[]).includes(M.me)?(x.teams||{})[M.me]:null;
  let teamBox='';
  if(x.teamsVisible){
    if(team==null)teamBox=st==='no'?'':`<div class="myteam plain"><span class="muted">Teams are out, and you're not on the list for this one. Tell an exco if you're coming.</span></div>`;
    else{
      const mates=(x.attendees||[]).filter(id=>(x.teams||{})[id]===team&&id!==M.me&&M.roster[id]).map(id=>[id,M.roster[id]]).sort((a,b)=>a[1].localeCompare(b[1]));
      const hasGame=(x.blocks||[]).some(b=>b.category==='game');
      const lu=hasGame&&x.lineups&&x.lineups[String(team)];
      let game='';
      if(lu){const k=Object.keys(lu.slots||{}).find(s=>lu.slots[s]===M.me);
        const order=(lu.order&&lu.order.length?lu.order:Object.values(lu.slots||{}));const bat=order.indexOf(M.me);
        game=k?`<div>Game: <b>${esc(POSNAME[k]||k)}</b>${bat>=0?`, batting <b>${ordinal(bat+1)}</b>`:''}</div>`:`<div class="muted">Game: you start on the bench.</div>`}
      teamBox=`<div class="myteam t${team}"><div class="tname">You're in Team ${TEAM[team]}</div>${game}
        <div class="going-list">${mates.map(([id,n])=>`<span class="chip">${avatar(n,M.photos[id],24,id)}${esc(firstName(n))}</span>`).join('')||'<span class="muted small">No teammates yet</span>'}</div></div>`;
    }
  }
  let t=start;
  const rows=(x.blocks||[]).map(b=>{const s=t;t+=blockMin(b);
    let what=esc(b.name);
    if(b.kind==='rotation'&&(b.stations||[]).length){
      if(team!=null){const n=b.stations.length;what+=`<div class="small muted">${b.stations.map((_,r)=>`${fmt(s+r*b.per)} ${esc(b.stations[(team+r)%n])}`).join('<br>')}</div>`}
      else what+=`<div class="small muted">${b.stations.map(esc).join(', ')}</div>`}
    return `<div class="plan-row"><span class="time">${fmt(s)}–${fmt(t)}</span><span>${what}</span></div>`}).join('');
  return `<section class="card">
    <div class="tr"><div class="dtile" aria-hidden="true"><span class="dw">${esc(dpart(x.date,'weekday'))}</span><span class="dn">${esc(dpart(x.date,'day'))}</span><span class="dm">${esc(dpart(x.date,'month'))}</span></div>
      <div style="min-width:0"><div class="tr-title">${esc(whenLabel(x.date))}</div>
      <div class="tr-meta"><span>${ICON.pin}${esc(VENUES[x.venue]||x.venue)}</span><span>${ICON.clock}${fmt(start)}–${fmt(end)}pm</span></div></div>
      ${st?`<span class="pill ${st==='no'?'bad':st==='yes'?'good':'warn'}">${esc(STATUS[st])}</span>`:'<span class="pill">No reply yet</span>'}</div>
    ${shut?`<div class="mynote">Replies are closed for this training.${st?` You said: <b>${esc(STATUS[st])}</b>.`:''}</div>`:`<div class="rsvp" role="group" aria-label="Are you coming?">
      <button class="y" data-act="rsvp" data-date="${x.date}" data-s="yes" aria-pressed="${going}">${going?'✓ ':''}I'm coming</button>
      <button class="n" data-act="rsvp" data-date="${x.date}" data-s="no" aria-pressed="${st==='no'}">${st==='no'?'✕ ':''}Can't make it</button>
    </div>
    ${going?`<div class="rsvp2" role="group" aria-label="Coming for part of it?"><button data-act="rsvp" data-date="${x.date}" data-s="late" aria-pressed="${st==='late'}">Coming late</button><button data-act="rsvp" data-date="${x.date}" data-s="early" aria-pressed="${st==='early'}">Leaving early</button></div>`:''}
    ${f?replyFormHTML(x,f):mine&&(mine.reason||mine.time)&&st!=='yes'?`<div class="mynote">${esc(STATUS[st])}${mine.time?`, ${st==='late'?'arriving':'leaving'} ${fmt(toMin(mine.time))}`:''}${mine.reason?` · ${esc(mine.reason)}`:''} <button class="ghost" data-act="rsvp" data-date="${x.date}" data-s="${st}" style="padding:2px 8px;font-size:13px">Change</button></div>`:''}`}
    <details${M.open[x.date]?' open':''} data-open="${x.date}"><summary><span class="going"><span class="av-stack">${yesSorted.slice(0,5).map(id=>avatar(M.roster[id],M.photos[id],28,id)).join('')}${yes.length>5?`<span class="av-more">+${yes.length-5}</span>`:''}</span><span>${yes.length} coming${late?` (${late} late or early)`:''} · ${no} can't</span></span></summary>
      <div class="going-list">${yesSorted.map(id=>`<span class="chip">${avatar(M.roster[id],M.photos[id],24,id)}${esc(firstName(M.roster[id]))}${rv[id].status==='late'?' <span class="muted">· late</span>':rv[id].status==='early'?' <span class="muted">· leaves early</span>':''}</span>`).join('')||'<span class="muted small">Nobody yet</span>'}</div></details>
    ${teamBox}
    ${rows?`<details><summary>Training plan</summary><div>${rows}</div></details>`:''}
  </section>`;
}

const STATUS={yes:'Coming',late:'Coming late',early:'Leaving early',no:"Can't make it"};
// Asks for a reason when coming late, leaving early, or changing a yes to a no.
function replyFormHTML(x,f){
  const q=f.status==='late'?'Coming late':f.status==='early'?'Leaving early':'Changing to a no';
  return `<div class="rform"><b>${q}</b>
    <div class="g">${f.status==='no'?'':`<label class="f">${f.status==='late'?'Arriving at':'Leaving at'}<input type="time" id="rf-time" data-input="form.time" value="${esc(f.time||'')}" step="300"></label>`}
      <label class="f" style="${f.status==='no'?'grid-column:1/-1':''}">Reason<input id="rf-reason" data-input="form.reason" value="${esc(f.reason||'')}" maxlength="200" placeholder="${f.status==='no'?'e.g. fell sick':'e.g. class until 4'}" autocomplete="off"></label></div>
    ${M.err?`<div class="banner bad">${esc(M.err)}</div>`:''}
    <div class="row"><button class="primary" data-act="rsSave"${M.busy?' disabled':''}>${M.busy?'Saving…':'Save'}</button><button class="ghost" data-act="rsCancel">Cancel</button></div></div>`;
}
function startsAt(date){const x=M.sessions.find(s=>s.date===date);return Date.parse(date+'T'+((x&&x.start)||'15:30')+':00+08:00')}
// Replies close 3 hours after the start (the database enforces this too).
const closed=date=>Date.now()>startsAt(date)+3*3600e3;

// Tournaments, friendlies and socials. Replies stay open until the event ends (the database enforces this too).
const EVLABEL={tournament:'Tournament',friendly:'Friendly',social:'Social'};
const evEnds=e=>Date.parse(e.date+'T'+(e.end||'23:59')+':00+08:00')+(e.end&&e.start&&e.end<=e.start?864e5:0);
const evOver=e=>Date.now()>=evEnds(e);
function eventHTML(e){
  const rv=M.evReplies[e.id]||{};const yes=Object.keys(rv).filter(id=>rv[id]===true&&M.roster[id]).sort((a,b)=>firstName(M.roster[a]).localeCompare(firstName(M.roster[b])));
  const no=Object.keys(rv).filter(id=>rv[id]===false).length;
  const mine=rv[M.me],shut=evOver(e),label=EVLABEL[e.type]||'Event';
  const notes=e.notes?esc(e.notes).replace(/\n/g,'<br>'):'';
  return `<section class="card ev-card ev-${esc(e.type)}">
    <div class="tr"><div class="dtile" aria-hidden="true"><span class="dw">${esc(dpart(e.date,'weekday'))}</span><span class="dn">${esc(dpart(e.date,'day'))}</span><span class="dm">${esc(dpart(e.date,'month'))}</span></div>
      <div style="min-width:0"><span class="ev-tag ev-${esc(e.type)}">${esc(label)}</span><div class="tr-title" style="margin-top:4px">${esc(e.title||label)}</div>
      <div class="tr-meta"><span>${ICON.clock}${esc(whenLabel(e.date))}, ${span(e.start,e.end)}</span>${e.venue?`<span>${ICON.pin}${esc(e.venue)}</span>`:''}${e.cost?`<span>${ICON.cost}${esc(e.cost)}</span>`:''}</div></div>
      ${mine===true?'<span class="pill good">Going</span>':mine===false?`<span class="pill bad">Can't go</span>`:'<span class="pill">No reply yet</span>'}</div>
    ${notes?`<div class="ev-notes">${notes}</div>`:''}
    ${shut?`<div class="mynote">Replies are closed for this event.</div>`:`<div class="rsvp" role="group" aria-label="Are you going?">
      <button class="y" data-act="evReply" data-id="${esc(e.id)}" data-g="1" aria-pressed="${mine===true}"${M.busy?' disabled':''}>${mine===true?'✓ ':''}I'm going</button>
      <button class="n" data-act="evReply" data-id="${esc(e.id)}" data-g="0" aria-pressed="${mine===false}"${M.busy?' disabled':''}>${mine===false?'✕ ':''}Can't make it</button></div>`}
    <details${M.open['ev'+e.id]?' open':''} data-open="ev${esc(e.id)}"><summary><span class="going"><span class="av-stack">${yes.slice(0,5).map(id=>avatar(M.roster[id],M.photos[id],28,id)).join('')}${yes.length>5?`<span class="av-more">+${yes.length-5}</span>`:''}</span><span>${yes.length} going · ${no} can't</span></span></summary>
      <div class="going-list">${yes.map(id=>`<span class="chip">${avatar(M.roster[id],M.photos[id],24,id)}${esc(firstName(M.roster[id]))}</span>`).join('')||'<span class="muted small">Nobody yet</span>'}</div></details>
  </section>`;
}
async function saveEventReply(id,going){
  const e=M.events.find(x=>x.id===id);if(!e||evOver(e))return;
  if((M.evReplies[id]||{})[M.me]===going)return;
  M.busy=true;render();
  const d={eventId:id,memberId:M.me,going,uid:M.uid,at:new Date().toISOString()};
  try{await db.doc('eventReplies/'+id+'_'+M.me).set(d);(M.evReplies[id]=M.evReplies[id]||{})[M.me]=going;toast(going?"You're down as going":'Thanks for letting us know')}
  catch(err){toast(evOver(e)?'Replies are closed for this event.':"Couldn't save your reply. Try again.")}
  M.busy=false;render();
}

function homeHTML(){
  const today=sgToday();
  const up=M.sessions.filter(x=>x.date>=today).sort((a,b)=>a.date.localeCompare(b.date));
  const evs=M.events.filter(e=>e.date>=today&&!evOver(e));
  const items=[...up.map(x=>({k:x.date+' '+(x.start||'15:30'),html:()=>trainingHTML(x)})),...evs.map(e=>({k:e.date+' '+(e.start||''),html:()=>eventHTML(e)}))].sort((a,b)=>a.k.localeCompare(b.k));
  const sub=[up.length?`${up.length} training${up.length>1?'s':''}`:'',evs.length?`${evs.length} event${evs.length>1?'s':''}`:''].filter(Boolean).join(' and ');
  const bar=`<div class="hello">${M.me?`<button class="avbtn" data-act="profile" aria-label="Your profile">${meAv(44)}</button>`:''}<div><div class="hi">Hi${M.me?` ${esc(firstName(M.roster[M.me]||''))}`:''}</div><div class="small muted">${sub?sub+' coming up':'Nothing posted yet'}</div></div><div class="row">${M.admin?'<a class="btnlink" href="coach.html">Coach view</a>':''}<button class="ghost" data-act="profile" aria-expanded="${M.showProfile}">${M.showProfile?'Close':'Profile'}</button></div></div>${M.showProfile?profileHTML():''}`;
  if(!M.me)return bar+`<section class="card"><h2>Link your name</h2><p class="muted" style="margin:0">To reply to trainings, find your name and an exco will confirm it. You only do this once.</p><div class="row"><button class="primary" data-act="tolink">Find my name</button></div></section>`;
  return `${bar}
    ${items.length?items.map(i=>i.html()).join(''):`<section class="card"><h2>Nothing posted yet</h2><p class="muted" style="margin:0">When the excos post the next training or event, it'll show here and you can reply.</p></section>`}`;
}

const A={
  pick({id}){M.pick=id;M.err=''},
  unpick(){M.pick=null;M.err=''},
  skip(){M.status='home'},
  tolink(){M.status='login';M.q='';M.pick=null;M.err=''},
  profile(){M.showProfile=!M.showProfile},
  copyCode(){copyText(M.uid||'')},
  async logout(){await logOut();location.reload()},
  async request(){
    M.busy=true;M.err='';render();
    try{const p=await telegramProfile();await db.doc('linkRequests/'+M.uid).set({memberId:M.pick,tgName:p.name.slice(0,100),tgUsername:p.username,at:new Date().toISOString()})}
    catch(e){M.err="Couldn't send that. Try again."}
    M.busy=false;render();
  },
  async cancelReq(){try{await db.doc('linkRequests/'+M.uid).delete()}catch(e){}M.req=null;M.pick=null;M.q='';render()},
  async switch(){try{await db.doc('claims/'+M.uid).delete()}catch(e){}M.me=null;M.pick=null;await logOut();location.reload()},
  rsvp({date,s:status}){
    if(closed(date))return;
    const cur=myRsvp(date);M.err='';
    if(status==='late'||status==='early'){M.form={date,status,time:cur&&cur.status===status?cur.time||'':'',reason:cur&&cur.status===status?cur.reason||'':''};return}
    if(status==='no'&&cur&&cur.going){M.form={date,status,reason:''};return}
    M.form=null;if(cur&&cur.status===status)return;
    return saveReply(date,status,'','');
  },
  rsCancel(){M.form=null;M.err=''},
  evReply({id,g}){return saveEventReply(id,g==='1')},
  async photoRemove(){M.photoErr='';try{await db.doc('photos/'+M.me).set({src:'',by:M.uid,at:new Date().toISOString()});M.photos[M.me]='';toast('Photo removed')}catch(e){M.photoErr="Couldn't remove it. Try again."}render()},
  rsSave(){const f=M.form;if(!f)return;const reason=String(f.reason||'').trim();
    if(!reason){M.err=f.status==='no'?'Let the excos know why you can no longer make it.':'Add a reason so the excos can plan around it.';return}
    return saveReply(f.date,f.status,f.time||'',reason)},
};
document.addEventListener('click',e=>{const el=e.target.closest('[data-act]');if(!el||el.disabled)return;const r=A[el.dataset.act](el.dataset);if(!(r instanceof Promise))render()});
document.addEventListener('change',async e=>{if(!e.target.matches('[data-photo]'))return;const file=e.target.files&&e.target.files[0];if(!file)return;
  M.photoErr='';
  try{const src=await shrinkPhoto(file);await db.doc('photos/'+M.me).set({src,by:M.uid,at:new Date().toISOString()});M.photos[M.me]=src;toast('Photo saved')}
  catch(err){M.photoErr=err&&err.message==='not_image'?"That file isn't a photo. Pick a JPG or PNG.":"Couldn't save the photo. Try a different one."}
  render()});
document.addEventListener('input',e=>{const k=e.target.dataset.input;if(!k)return;const [a,b]=k.split('.');if(b){if(M[a])M[a][b]=e.target.value}else M[k]=e.target.value;if(k==='q')render()});
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.id==='q'){const first=document.querySelector('.who button');if(first)first.click()}});
document.addEventListener('toggle',e=>{const d=e.target.dataset&&e.target.dataset.open;if(d)M.open[d]=e.target.open},true);

async function saveReply(date,status,time,reason){
  const cur=myRsvp(date);
  const d={date,memberId:M.me,going:status!=='no',status,uid:M.uid,at:new Date().toISOString()};
  // The time and reason go in a separate record only this member and the excos can read.
  const note=reason?{date,memberId:M.me,reason:reason.slice(0,200),uid:M.uid,at:d.at,...(time&&status!=='no'&&status!=='yes'?{time}:{})}:null;
  const prev=cur?(cur.status===status?cur.prev||'':cur.status):'';if(prev)d.prev=prev;
  M.busy=true;render();
  const id=date+'_'+M.me;
  try{await db.batch([note?['set','rsvpNotes/'+id,note]:['delete','rsvpNotes/'+id],['set','rsvps/'+id,d]]);(M.rsvps[date]=M.rsvps[date]||{})[M.me]=d;if(note)M.notes[date]=note;else delete M.notes[date];M.form=null;M.err='';
    toast(status==='no'?'Thanks for letting us know':status==='yes'?"You're down as coming":"Saved. The excos can see it");
    const t=startsAt(date),now=Date.now();if(t-now<6*3600e3&&now<t+3*3600e3&&(status!=='yes'||prev))notifyExcos(date,M.me)}
  catch(e){M.err=closed(date)?'Replies are closed for this training.':"Couldn't save your reply. Try again.";if(!M.form)toast(M.err)}
  M.busy=false;render();
}
let rosterStarted=false;
async function afterAuth(u){
  M.uid=u.uid;
  if(!rosterStarted){rosterStarted=true;db.collection('roster').onSnapshot(s=>{M.roster=Object.fromEntries(s.docs.map(x=>[x.id,x.data().name]));if(M.status!=='loading')render()},()=>{M.status='error';render()})}
  try{M.admin=(await db.doc('admins/'+M.uid).get()).exists}catch(e){M.admin=false}
  if(M.admin&&NEXT==='coach'){location.replace('coach.html');return}
  const c=await db.doc('claims/'+M.uid).get();
  if(c.exists&&c.data().memberId){M.me=c.data().memberId;M.status='home';startData()}else M.status=M.admin?'home':'login';
  if(!M.me){await autoLink();if(!M.me)watchLink()}
}
// If an exco recorded this login's @username on a member, link straight away.
async function autoLink(){
  try{const p=await telegramProfile();const u=p.username.toLowerCase();if(!u)return;
    const ix=await db.doc('tgIndex/'+u).get();if(!ix.exists)return;const mid=ix.data().memberId;
    await db.doc('claims/'+M.uid).set({memberId:mid,via:'username'});M.me=mid;M.status='home';startData()}catch(e){}
}
// Waits for an exco to approve this login's link request.
let linkWatched=false;
function watchLink(){
  if(linkWatched)return;linkWatched=true;
  db.doc('linkRequests/'+M.uid).onSnapshot(s=>{M.req=s.exists?s.data():null;if(M.status==='login')render()},()=>{});
  db.doc('claims/'+M.uid).onSnapshot(s=>{if(s.exists&&s.data().memberId&&!M.me){M.me=s.data().memberId;M.req=null;M.status='home';startData();toast("You're linked. Welcome!");render()}},()=>{});
}
// The first time a member is linked, use their Telegram profile photo (they can change or remove it later).
async function useTelegramPhoto(hasDoc){
  if(hasDoc||!M.me)return;
  try{const p=await telegramProfile();if(safePhoto(p.photo))await db.doc('photos/'+M.me).set({src:p.photo,by:M.uid,at:new Date().toISOString()})}catch(e){}
}
let dataStarted=false;
function startData(){
  if(dataStarted)return;dataStarted=true;
  const today=sgToday();
  const fail=()=>{M.status='error';render()};
  db.collection('sessions').where('published','==',true).onSnapshot(s=>{M.sessions=s.docs.map(x=>({...x.data(),date:x.id}));render()},fail);
  db.collection('photos').onSnapshot(s=>{M.photos=Object.fromEntries(s.docs.map(x=>[x.id,x.data().src||'']));
    if(!M.photosLoaded){M.photosLoaded=true;useTelegramPhoto(s.docs.some(x=>x.id===M.me))}render()},()=>{});
  db.collection('rsvpNotes').where('memberId','==',M.me).onSnapshot(s=>{M.notes=Object.fromEntries(s.docs.map(x=>[x.data().date,x.data()]));render()},()=>{});
  db.collection('events').where('published','==',true).onSnapshot(s=>{M.events=s.docs.map(x=>({...x.data(),id:x.id}));render()},()=>{});
  db.collection('eventReplies').onSnapshot(s=>{const o={};s.docs.forEach(x=>{const v=x.data();(o[v.eventId]=o[v.eventId]||{})[v.memberId]=v.going});M.evReplies=o;render()},()=>{});
  db.collection('rsvps').where('date','>=',today).onSnapshot(s=>{const o={};s.docs.forEach(x=>{const v=x.data();(o[v.date]=o[v.date]||{})[v.memberId]={...v,status:v.status||(v.going?'yes':'no')}});M.rsvps=o;render()},fail);
}

(async()=>{
  if(!configured){M.status='noconfig';render();return}
  try{
    let u=await currentUser();
    if(!u||!u.uid.startsWith('tg:')){if(u)await logOut();M.status='tglogin';render();return}
    await afterAuth(u);
  }catch(e){M.status='error'}
  render();
})();
