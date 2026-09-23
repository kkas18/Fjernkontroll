import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT || 8765);
const keysFile = path.join(root, 'data', 'lg-keys.json');
const media = new Map([['.html','text/html; charset=utf-8'],['.js','text/javascript; charset=utf-8'],['.css','text/css; charset=utf-8'],['.json','application/json; charset=utf-8'],['.webmanifest','application/manifest+json'],['.png','image/png'],['.svg','image/svg+xml']]);
let selected = null;
let lg = { control:null, pointer:null, host:null, ready:false, state:'Frakoblet', muted:false, generation:0 };

function validIp(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const a = ip.split('.').map(Number);
  return a.every(x => x >= 0 && x <= 255) && (a[0] === 10 || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168));
}
function validDevice(d) {
  if (!d || !['roku','lg'].includes(d.type) || !validIp(d.host)) throw Error('Oppgi en gyldig lokal IP-adresse og TV-type.');
  return { type:d.type, host:d.host, name:String(d.name || (d.type === 'lg' ? 'LG webOS' : 'Roku')).slice(0,70) };
}
function send(res,status,data){const b=JSON.stringify(data);res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','content-length':Buffer.byteLength(b)});res.end(b);}
async function body(req) {
  let chunks=[],bytes=0;
  for await(const c of req){bytes+=c.length;if(bytes>16_384)throw Error('For stor forespørsel.');chunks.push(c);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
async function rokuProbe(host) {
  const r = await fetch(`http://${host}:8060/query/device-info`,{signal:AbortSignal.timeout(2400)});
  if(!r.ok)throw Error('Roku svarte ikke. Aktiver «Control by mobile apps» på TV-en.');
  const xml=await r.text();
  const raw=xml.match(/<(?:user-device-name|friendly-device-name)>([^<]{1,120})<\/[^>]+>/i)?.[1] || 'Roku';
  const name=raw.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  return {type:'roku',host,name};
}
async function rokuKey(host,key){
  const r=await fetch(`http://${host}:8060/keypress/${key}`,{method:'POST',signal:AbortSignal.timeout(2600)});
  if(!r.ok)throw Error('Roku avviste kommandoen.');
}
async function discover() {
  const map=new Map();
  const sock=dgram.createSocket({type:'udp4',reuseAddr:true});
  await new Promise((ok,no)=>{sock.once('error',no);sock.bind(0,()=>{sock.removeAllListeners('error');ok();});});
  sock.on('message',(buf,remote)=>{
    const s=buf.toString('utf8').toLowerCase(),host=remote.address;
    if(!validIp(host))return;
    if(s.includes('roku'))map.set(`roku:${host}`,{type:'roku',host,name:`Roku · ${host}`});
    else if(s.includes('webos')||s.includes('lge-com'))map.set(`lg:${host}`,{type:'lg',host,name:`LG webOS · ${host}`});
  });
  const addr='239.255.255.250';
  for(const st of ['roku:ecp','urn:lge-com:service:webos-second-screen:1','ssdp:all']){
    const b=Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
    sock.send(b,1900,addr);
  }
  await new Promise(resolve=>setTimeout(resolve,4500));sock.close();
  const result=await Promise.all([...map.values()].map(async d=>d.type==='roku'?await rokuProbe(d.host).catch(()=>d):d));
  return result;
}
async function keys(){try{return JSON.parse(await fs.readFile(keysFile,'utf8'));}catch{return {};}}
async function saveKey(host,key){const stored=await keys();stored[host]=key;await fs.mkdir(path.dirname(keysFile),{recursive:true});await fs.writeFile(keysFile,JSON.stringify(stored),'utf8');}
function disconnectLg(){
  lg.generation++;
  try{lg.pointer?.close();}catch{}
  try{lg.control?.close();}catch{}
  lg.pointer=null;lg.control=null;lg.ready=false;lg.state='Frakoblet';lg.host=null;
}
function lgRequest(uri,payload=null,id=`cmd_${Date.now()}`){
  if(lg.control?.readyState!==WebSocket.OPEN)throw Error('LG TV er ikke tilkoblet.');
  lg.control.send(JSON.stringify({type:'request',id,uri,...(payload?{payload}:{})}));
}
async function connectLg(d){
  disconnectLg();lg.host=d.host;lg.state='Venter på paring. Godkjenn på TV-skjermen.';
  const generation=lg.generation;
  const stored=await keys();
  if(generation!==lg.generation)return;
  const socket=new WebSocket(`ws://${d.host}:3000/`);lg.control=socket;
  socket.addEventListener('open',()=>{
    if(generation!==lg.generation)return;
    const permissions=['CONTROL_AUDIO','CONTROL_DISPLAY','CONTROL_INPUT_JOYSTICK','CONTROL_INPUT_MEDIA_PLAYBACK','CONTROL_INPUT_TV','CONTROL_POWER','READ_APP_STATUS','READ_CURRENT_CHANNEL','READ_INPUT_DEVICE_LIST','WRITE_NOTIFICATION_TOAST'];
    const payload={forcePairing:false,pairingType:'PROMPT',manifest:{manifestVersion:1,appVersion:'1.0',permissions,signatures:[{signatureVersion:1,signature:'dummy_signature'}]}};
    if(stored[d.host])payload['client-key']=stored[d.host];
    socket.send(JSON.stringify({type:'register',id:'register_0',payload}));
  });
  socket.addEventListener('message',async event=>{
    if(generation!==lg.generation)return;
    let message;try{message=JSON.parse(String(event.data));}catch{return;}
    if(message.type==='registered'){
      const key=message.payload?.['client-key'];if(key)await saveKey(d.host,key).catch(()=>{});
      if(generation!==lg.generation)return;
      lg.state='Paring godkjent. Klargjør navigasjon …';
      lgRequest('ssap://com.webos.service.networkinput/getPointerInputSocket',null,'pointer_0');
    }else if(message.id==='pointer_0'){
      const url=message.payload?.socketPath;
      if(!/^wss?:\/\//.test(url||'')){lg.state='TV-en tilbyr ikke navigasjon.';return;}
      const pointer=new WebSocket(url);lg.pointer=pointer;
      pointer.addEventListener('open',()=>{if(generation!==lg.generation)return;lg.ready=true;lg.state='Tilkoblet';});
      pointer.addEventListener('error',()=>{if(generation!==lg.generation)return;lg.ready=false;lg.state='Navigasjon ble frakoblet.';});
      pointer.addEventListener('close',()=>{if(generation!==lg.generation)return;lg.ready=false;lg.state='Navigasjon ble frakoblet.';});
    }else if(message.type==='error')lg.state='TV-en avviste forespørselen. Kontroller paring og tillatelser.';
  });
  socket.addEventListener('error',()=>{if(generation!==lg.generation)return;lg.ready=false;lg.state='Kunne ikke koble til LG TV. Sjekk IP og nettverk.';});
  socket.addEventListener('close',()=>{if(generation!==lg.generation)return;lg.ready=false;lg.state='LG TV ble frakoblet.';});
}
function lgCommand(key){
  if(!lg.ready)throw Error(lg.state);
  const buttons={Up:'UP',Down:'DOWN',Left:'LEFT',Right:'RIGHT',Select:'ENTER',Back:'BACK',Home:'HOME'};
  if(buttons[key]){lg.pointer.send(`type:button\nname:${buttons[key]}\n\n`);return;}
  const commands={VolumeUp:'ssap://audio/volumeUp',VolumeDown:'ssap://audio/volumeDown',PowerOff:'ssap://system/turnOff',Play:'ssap://media.controls/play',Pause:'ssap://media.controls/pause',Rewind:'ssap://media.controls/rewind',FastForward:'ssap://media.controls/fastForward',ChannelUp:'ssap://tv/channelUp',ChannelDown:'ssap://tv/channelDown'};
  if(key==='Mute'){lg.muted=!lg.muted;lgRequest('ssap://audio/setMute',{mute:lg.muted});return;}
  if(!commands[key])throw Error('Denne kommandoen støttes ikke av LG.');
  lgRequest(commands[key]);
}
async function api(req,res,route){
  if(route==='/api/status'&&req.method==='GET')return send(res,200,{device:selected,ready:selected?.type==='roku'||lg.ready,state:selected?.type==='roku'?'Klar til bruk':lg.state});
  if(req.method!=='POST')return send(res,405,{error:'Metoden støttes ikke.'});
  const input=await body(req);
  if(route==='/api/scan')return send(res,200,{devices:await discover()});
  if(route==='/api/connect'){
    const d=validDevice(input.device);
    if(d.type==='roku'){const real=await rokuProbe(d.host);disconnectLg();selected=real;return send(res,200,{device:real,ready:true});}
    selected=d;await connectLg(d);return send(res,200,{device:d,ready:false,state:lg.state});
  }
  if(route==='/api/command'){
    if(!selected)throw Error('Velg en TV først.');
    const key=String(input.key||'');
    const allowed=['Up','Down','Left','Right','Select','Back','Home','VolumeUp','VolumeDown','Mute','PowerOff','Play','Pause','Rewind','FastForward','ChannelUp','ChannelDown'];
    if(!allowed.includes(key))throw Error('Ukjent kommando.');
    if(selected.type==='lg')lgCommand(key);else await rokuKey(selected.host,key==='Mute'?'VolumeMute':key);
    return send(res,200,{ok:true});
  }
  if(route==='/api/text'){
    if(!selected)throw Error('Velg en TV først.');
    const value=String(input.text||'').slice(0,140);
    if(!value)throw Error('Skriv inn tekst først.');
    if(selected.type==='lg')lgRequest('ssap://com.webos.service.ime/insertText',{text:value,replace:0});
    else for(const char of value)await rokuKey(selected.host,`Lit_${encodeURIComponent(char)}`);
    return send(res,200,{ok:true});
  }
  send(res,404,{error:'Ukjent adresse.'});
}
const server=http.createServer(async(req,res)=>{
  const host=req.headers.host;
  if(![`localhost:${port}`,`127.0.0.1:${port}`].includes(host))return send(res,403,{error:'Kun lokal tilkobling er tillatt.'});
  if(req.headers.origin&&!['http://localhost:'+port,'http://127.0.0.1:'+port].includes(req.headers.origin))return send(res,403,{error:'Ugyldig opphav.'});
  const route=new URL(req.url,'http://localhost').pathname;
  try{
    if(route.startsWith('/api/'))return await api(req,res,route);
    if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,{error:'Metoden støttes ikke.'});
    const relative=route==='/'?'index.html':decodeURIComponent(route).replace(/^\/+/, '');
    const target=path.resolve(publicDir,relative);
    if(!target.startsWith(publicDir+path.sep))return send(res,403,{error:'Ikke tillatt.'});
    const stat=await fs.stat(target);if(!stat.isFile())throw Error('Finnes ikke.');
    res.writeHead(200,{'content-type':media.get(path.extname(target))||'application/octet-stream','cache-control':route==='/sw.js'?'no-cache':'public, max-age=3600','content-length':stat.size});
    if(req.method==='HEAD')res.end();else res.end(await fs.readFile(target));
  }catch(e){send(res,route.startsWith('/api/')?400:404,{error:e?.message||'Uventet feil.'});}
});
server.listen(port,'127.0.0.1',()=>console.log(`Fjern PWA: http://localhost:${port}`));
