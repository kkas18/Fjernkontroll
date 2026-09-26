const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
let saved=readSaved(),found=[],device=null,ready=false,bridge=false,scanning=false,lastState='',toastTimer;
function readSaved(){try{return JSON.parse(localStorage.getItem('fjern-devices')||'[]').filter(d=>d&&['roku','lg'].includes(d.type));}catch{return [];}}
function store(){localStorage.setItem('fjern-devices',JSON.stringify(saved));if(device)localStorage.setItem('fjern-selected',`${device.type}:${device.host}`);}
function feedback(){if(navigator.vibrate)navigator.vibrate(12);}
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),3500);}
async function api(route,data){
  const response=await fetch('/api/'+route,{method:data?'POST':'GET',headers:{'content-type':'application/json'},body:data?JSON.stringify(data):undefined,cache:'no-store'});
  const result=await response.json().catch(()=>({}));if(!response.ok)throw Error(result.error||'Tilkoblingen feilet.');return result;
}
function setView(view){
  $$('.view').forEach(el=>el.classList.toggle('active',el.id===view+'View'));
  $$('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
  window.scrollTo({top:0,behavior:'smooth'});
  if(view==='devices')renderLists();
}
function render(){
  $('#headerName').textContent=device?.name||'Ingen TV valgt';
  $('#headerDot').classList.toggle('on',ready);
  $('#statusOrb').classList.toggle('on',ready);
  $('#statusTitle').textContent=ready?'TILKOBLET':device?'KOBLER TIL':'IKKE TILKOBLET';
  $('#statusDescription').textContent=!bridge?'Start den lokale broen i Termux.':device?lastState||'Sjekker tilkoblingen …':'Koble til en TV på samme nettverk.';
  $('#noDevice').hidden=Boolean(device);$('#remoteControls').hidden=!device;
  $('#subtitle').textContent=device?`Styr ${device.name} på lokalnettet.`:'Velg en TV for å komme i gang.';
  $('#capabilityNote').textContent=device?.type==='roku'?'Volum, kanal og strøm avhenger av Roku-modellen. Tekst virker når et tekstfelt er aktivt på TV-en.':'Enkelte funksjoner avhenger av LG-modellen. Strøm på via lokalnettet er ikke inkludert.';
}
function renderLists(){
  const renderCard=(d,stored)=>{
    const card=document.createElement('div');card.className='device-card'+(device?.type===d.type&&device?.host===d.host?' selected':'');
    const icon=document.createElement('div');icon.className='device-card-icon';icon.textContent=d.type==='lg'?'LG':'R';card.append(icon);
    const info=document.createElement('div');info.className='device-card-copy';
    const name=document.createElement('strong');name.textContent=d.name;
    const detail=document.createElement('small');detail.textContent=`${d.type==='lg'?'LG webOS':'Roku'} · ${d.host}`;
    info.append(name,detail);card.append(info);
    if(stored){const remove=document.createElement('button');remove.className='remove';remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','Fjern '+d.name);remove.onclick=()=>{
      if(!confirm(`Fjerne ${d.name} fra listen?`))return;
      saved=saved.filter(x=>x.type!==d.type||x.host!==d.host);store();renderLists();
    };card.append(remove);}
    const choose=document.createElement('button');choose.type='button';choose.className='select';choose.textContent='›';choose.setAttribute('aria-label','Koble til '+d.name);choose.onclick=()=>connect(d);
    card.append(choose);return card;
  };
  const list=$('#savedList');list.replaceChildren(...saved.map(d=>renderCard(d,true)));
  if(!saved.length){const empty=document.createElement('div');empty.className='list-empty';empty.textContent='Ingen TV-er lagret ennå.';list.append(empty);}
  const newOnes=found.filter(d=>!saved.some(x=>x.type===d.type&&x.host===d.host));
  const discovered=$('#foundList');discovered.replaceChildren(...newOnes.map(d=>renderCard(d,false)));
  if(!newOnes.length){const empty=document.createElement('div');empty.className='list-empty';empty.textContent=scanning?'Søker på lokalnettet …':'Ingen nye enheter funnet. Prøv IP-adresse.';discovered.append(empty);}
}
function remember(d){saved=[d,...saved.filter(x=>x.type!==d.type||x.host!==d.host)];store();renderLists();}
async function connect(d){
  feedback();device=d;ready=false;lastState='Kobler til '+d.name+' …';setView('remote');render();
  try{
    const answer=await api('connect',{device:d});bridge=true;device=answer.device;ready=answer.ready;
    lastState=answer.state|| (ready?'Klar til bruk':'Venter på paring på TV-en.');
    if(ready)remember(device);else toast('Godkjenn paringen på LG TV-en.');render();
  }catch(e){ready=false;lastState=e.message;render();toast(e.message);}
}
async function status(){
  try{
    const s=await api('status');bridge=true;
    if(s.device){device=s.device;ready=s.ready;lastState=s.state;if(ready&&!saved.some(x=>x.type===device.type&&x.host===device.host))remember(device);}
    else{ready=false;lastState='Velg en TV.';}
  }catch{bridge=false;ready=false;lastState='Den lokale broen svarer ikke.';}
  render();
}
async function command(key){
  feedback();if(!device){toast('Velg en TV først.');setView('devices');return;}
  if(!ready){toast(lastState||'TV-en er ikke tilkoblet.');return;}
  try{await api('command',{key});}catch(e){toast(e.message);await status();}
}
async function scan(){
  if(scanning)return;scanning=true;found=[];renderLists();$('#scan').disabled=true;$('#scan').firstChild.textContent='Søker på Wi‑Fi …';
  try{const answer=await api('scan',{});bridge=true;found=answer.devices;toast(found.length?`${found.length} enhet${found.length===1?'':'er'} funnet`:'Ingen TV funnet. Prøv IP-adresse.');}
  catch(e){toast('Start den lokale broen før du søker.');}
  finally{scanning=false;$('#scan').disabled=false;$('#scan').firstChild.textContent='Søk på Wi‑Fi ';renderLists();}
}
$$('.nav-item').forEach(el=>el.addEventListener('click',()=>{feedback();setView(el.dataset.view);}));
$('#deviceSwitch').addEventListener('click',()=>setView('devices'));
$('#startConnect').addEventListener('click',()=>setView('devices'));
$('#scan').addEventListener('click',scan);
$('#manualOpen').addEventListener('click',()=>$('#manualDialog').showModal());
$$('[data-close]').forEach(el=>el.addEventListener('click',()=>$('#'+el.dataset.close).close()));
$('#manualForm').addEventListener('submit',async e=>{
  e.preventDefault();const host=$('#ip').value.trim();const type=$('#deviceType').value;
  const parts=host.split('.').map(Number);
  const local=/^\d{1,3}(\.\d{1,3}){3}$/.test(host)&&parts.every(x=>x>=0&&x<=255)&&(parts[0]===10||parts[0]===172&&parts[1]>=16&&parts[1]<=31||parts[0]===192&&parts[1]===168);
  if(!local){toast('Oppgi en gyldig lokal IPv4-adresse.');return;}
  $('#manualDialog').close();await connect({type,host,name:type==='lg'?`LG webOS · ${host}`:`Roku · ${host}`});
});
$$('[data-key]').forEach(el=>el.addEventListener('click',()=>command(el.dataset.key)));
$('#power').addEventListener('click',()=>{if(!device){toast('Velg en TV først.');return;}$('#powerDialog').showModal();});
$('#powerConfirm').addEventListener('click',()=>{$('#powerDialog').close();command('PowerOff');});
$('#textOpen').addEventListener('click',()=>$('#textDialog').showModal());
$('#textForm').addEventListener('submit',async e=>{
  e.preventDefault();const text=$('#tvText').value.trim();$('#textDialog').close();if(!text)return;
  try{await api('text',{text});toast('Tekst sendt.');$('#tvText').value='';}catch(error){toast(error.message);}
});
document.addEventListener('keydown',e=>{
  if(document.querySelector('dialog[open]')||e.target.matches('input,select,textarea'))return;
  const map={ArrowUp:'Up',ArrowDown:'Down',ArrowLeft:'Left',ArrowRight:'Right',Enter:'Select',Escape:'Back'};
  if(map[e.key]&&device){e.preventDefault();command(map[e.key]);}
});
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
render();renderLists();status();setInterval(status,2300);
const last=localStorage.getItem('fjern-selected');const previous=saved.find(d=>`${d.type}:${d.host}`===last);
if(previous)connect(previous);
