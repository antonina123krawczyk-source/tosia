import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
mkdirSync(join(root, 'data'), { recursive: true });
const db = new DatabaseSync(process.env.DB_PATH || join(root, 'data', 'stempel.db'));
db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE, name TEXT, role TEXT, password TEXT, venue_id INTEGER);
CREATE TABLE IF NOT EXISTS venues(id INTEGER PRIMARY KEY, name TEXT, category TEXT, address TEXT, reward TEXT, emoji TEXT, qr_code TEXT UNIQUE, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS stamp_requests(id INTEGER PRIMARY KEY, student_id INTEGER, venue_id INTEGER, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP, decided_at TEXT, decided_by INTEGER);
CREATE TABLE IF NOT EXISTS stamps(id INTEGER PRIMARY KEY, student_id INTEGER, venue_id INTEGER, request_id INTEGER UNIQUE, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS reward_requests(id INTEGER PRIMARY KEY, student_id INTEGER, venue_id INTEGER, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP, decided_at TEXT, decided_by INTEGER);
CREATE TABLE IF NOT EXISTS redemptions(id INTEGER PRIMARY KEY, student_id INTEGER, venue_id INTEGER, reward_request_id INTEGER UNIQUE, stamp_cutoff INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_stamp ON stamp_requests(student_id,venue_id) WHERE status='pending';
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_reward ON reward_requests(student_id,venue_id) WHERE status='pending';`);

function hash(password, salt = randomBytes(16).toString('hex')) { return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`; }
function check(password, value) { const [salt, expected] = value.split(':'); return timingSafeEqual(Buffer.from(expected, 'hex'), scryptSync(password, salt, 32)); }
function seed() {
  if (!db.prepare('SELECT count(*) n FROM venues').get().n) {
    const add = db.prepare('INSERT INTO venues(name,category,address,reward,emoji,qr_code) VALUES(?,?,?,?,?,?)');
    add.run('Bun & Co.', 'Burgers', '7 Campus Street', 'Free classic burger', '🍔', 'BULA-7');
    add.run('Coffee Talk', 'Coffee shop', '12 Student Street', 'Any coffee on us', '☕', 'KAWA-12');
    add.run('Green Bowl', 'Lunch', '3 Campus Lane', 'Free bowl of the day', '🥗', 'MISKA-3');
  }
  const addUser = db.prepare('INSERT OR IGNORE INTO users(email,name,role,password,venue_id) VALUES(?,?,?,?,?)');
  addUser.run('student@stempel.app', 'Ola Kowalska', 'student', hash('student123'), null);
  addUser.run('burger@stempel.app', 'Bun & Co. Team', 'venue', hash('venue123'), 1);
  addUser.run('admin@stempel.app', 'Administrator', 'admin', hash('admin123'), null);
}
seed();

const json = (res, status, body) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(body)); };
const readBody = async req => { let s=''; for await (const c of req) { s += c; if(s.length>1e6) throw Error('Request is too large'); } return s ? JSON.parse(s) : {}; };
function session(req) {
  const token = /(?:^|; )session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (!token) return null;
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?').get(token, Date.now()) || null;
}
function must(user, roles, res) { if (!user || !roles.includes(user.role)) { json(res, 403, {error:'Access denied'}); return false; } return true; }
function tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const out=fn(); db.exec('COMMIT'); return out; } catch(e) { db.exec('ROLLBACK'); throw e; } }
function progress(studentId, venueId) {
  const last = db.prepare('SELECT stamp_cutoff FROM redemptions WHERE student_id=? AND venue_id=? ORDER BY id DESC LIMIT 1').get(studentId, venueId)?.stamp_cutoff || 0;
  return db.prepare('SELECT count(*) n FROM stamps WHERE student_id=? AND venue_id=? AND id>?').get(studentId, venueId, last).n;
}
function cards(studentId) {
  return db.prepare('SELECT * FROM venues WHERE active=1 ORDER BY id').all().map(v => ({...v, stamps:progress(studentId,v.id), pendingStamp:!!db.prepare("SELECT 1 FROM stamp_requests WHERE student_id=? AND venue_id=? AND status='pending'").get(studentId,v.id), pendingReward:!!db.prepare("SELECT 1 FROM reward_requests WHERE student_id=? AND venue_id=? AND status='pending'").get(studentId,v.id)}));
}

async function api(req, res, path) {
  const user = session(req); const body = ['POST','PATCH'].includes(req.method) ? await readBody(req) : {};
  if (path==='/api/login' && req.method==='POST') {
    const found=db.prepare('SELECT * FROM users WHERE email=?').get(String(body.email||'').toLowerCase());
    if(!found || !check(String(body.password||''),found.password)) return json(res,401,{error:'Incorrect email or password'});
    const token=randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token,found.id,Date.now()+86400000);
    res.setHeader('Set-Cookie',`session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`); return json(res,200,{ok:true});
  }
  if(path==='/api/logout' && req.method==='POST'){ const token=/(?:^|; )session=([^;]+)/.exec(req.headers.cookie||'')?.[1]; if(token) db.prepare('DELETE FROM sessions WHERE token=?').run(token); res.setHeader('Set-Cookie','session=; HttpOnly; Path=/; Max-Age=0'); return json(res,200,{ok:true}); }
  if(path==='/api/me' && req.method==='GET') return json(res,200,{user:user&&{id:user.id,name:user.name,email:user.email,role:user.role,venue_id:user.venue_id}});
  if(path==='/api/student/cards' && req.method==='GET'){if(!must(user,['student'],res))return; return json(res,200,{cards:cards(user.id)});}
  if(path==='/api/student/scan' && req.method==='POST'){if(!must(user,['student'],res))return; const v=db.prepare('SELECT * FROM venues WHERE qr_code=? AND active=1').get(String(body.code||'').trim().toUpperCase()); if(!v)return json(res,404,{error:'No venue found for this code'}); if(progress(user.id,v.id)>=10)return json(res,409,{error:'Claim your available reward first'}); try{const r=db.prepare('INSERT INTO stamp_requests(student_id,venue_id) VALUES(?,?)').run(user.id,v.id); return json(res,201,{id:Number(r.lastInsertRowid),venue:v.name});}catch{return json(res,409,{error:'This request is already awaiting approval'});}}
  if(path==='/api/student/reward' && req.method==='POST'){if(!must(user,['student'],res))return; const venueId=Number(body.venueId); if(progress(user.id,venueId)<10)return json(res,409,{error:'Collect 10 stamps first'}); try{db.prepare('INSERT INTO reward_requests(student_id,venue_id) VALUES(?,?)').run(user.id,venueId); return json(res,201,{ok:true});}catch{return json(res,409,{error:'A reward claim is already pending'});}}
  if(path==='/api/venue/dashboard' && req.method==='GET'){if(!must(user,['venue'],res))return; const venue=db.prepare('SELECT * FROM venues WHERE id=?').get(user.venue_id); const stamps=db.prepare("SELECT r.id,r.created_at,u.name FROM stamp_requests r JOIN users u ON u.id=r.student_id WHERE r.venue_id=? AND r.status='pending' ORDER BY r.id").all(user.venue_id); const rewards=db.prepare("SELECT r.id,r.created_at,u.name,v.reward FROM reward_requests r JOIN users u ON u.id=r.student_id JOIN venues v ON v.id=r.venue_id WHERE r.venue_id=? AND r.status='pending' ORDER BY r.id").all(user.venue_id); return json(res,200,{venue,stamps,rewards});}
  let m=path.match(/^\/api\/venue\/stamp\/(\d+)\/approve$/); if(m&&req.method==='POST'){if(!must(user,['venue'],res))return; try{tx(()=>{const r=db.prepare("SELECT * FROM stamp_requests WHERE id=? AND venue_id=? AND status='pending'").get(+m[1],user.venue_id); if(!r)throw Error('This request has already been processed'); if(progress(r.student_id,r.venue_id)>=10)throw Error('The student already has a reward ready'); db.prepare("UPDATE stamp_requests SET status='approved',decided_at=CURRENT_TIMESTAMP,decided_by=? WHERE id=? AND status='pending'").run(user.id,r.id); db.prepare('INSERT INTO stamps(student_id,venue_id,request_id) VALUES(?,?,?)').run(r.student_id,r.venue_id,r.id);}); return json(res,200,{ok:true});}catch(e){return json(res,409,{error:e.message});}}
  m=path.match(/^\/api\/venue\/reward\/(\d+)\/approve$/); if(m&&req.method==='POST'){if(!must(user,['venue'],res))return; try{tx(()=>{const r=db.prepare("SELECT * FROM reward_requests WHERE id=? AND venue_id=? AND status='pending'").get(+m[1],user.venue_id); if(!r)throw Error('This request has already been processed'); if(progress(r.student_id,r.venue_id)<10)throw Error('Not enough stamps'); const cutoff=db.prepare('SELECT max(id) id FROM stamps WHERE student_id=? AND venue_id=?').get(r.student_id,r.venue_id).id; db.prepare("UPDATE reward_requests SET status='approved',decided_at=CURRENT_TIMESTAMP,decided_by=? WHERE id=? AND status='pending'").run(user.id,r.id); db.prepare('INSERT INTO redemptions(student_id,venue_id,reward_request_id,stamp_cutoff) VALUES(?,?,?,?)').run(r.student_id,r.venue_id,r.id,cutoff);}); return json(res,200,{ok:true});}catch(e){return json(res,409,{error:e.message});}}
  if(path==='/api/venue/reward'&&req.method==='PATCH'){if(!must(user,['venue'],res))return; const reward=String(body.reward||'').trim(); if(reward.length<3)return json(res,400,{error:'Describe the reward'}); db.prepare('UPDATE venues SET reward=? WHERE id=?').run(reward,user.venue_id); return json(res,200,{ok:true});}
  if(path==='/api/admin/venues'&&req.method==='GET'){if(!must(user,['admin'],res))return; return json(res,200,{venues:db.prepare('SELECT * FROM venues ORDER BY id').all()});}
  if(path==='/api/admin/venues'&&req.method==='POST'){if(!must(user,['admin'],res))return; const {name,category,address,reward,emoji='🍽️'}=body; if(!name||!address||!reward)return json(res,400,{error:'Complete the required fields'}); const code=`VENUE-${randomBytes(3).toString('hex').toUpperCase()}`; const r=db.prepare('INSERT INTO venues(name,category,address,reward,emoji,qr_code) VALUES(?,?,?,?,?,?)').run(name,category||'Food & drink',address,reward,emoji,code); return json(res,201,{id:Number(r.lastInsertRowid)});}
  m=path.match(/^\/api\/admin\/venues\/(\d+)\/toggle$/); if(m&&req.method==='POST'){if(!must(user,['admin'],res))return; db.prepare('UPDATE venues SET active=1-active WHERE id=?').run(+m[1]); return json(res,200,{ok:true});}
  if(path==='/api/wallet/status'&&req.method==='GET') return json(res,200,{apple:{configured:!!(process.env.APPLE_PASS_CERT&&process.env.APPLE_PASS_KEY),message:'Requires an Apple Developer account, Pass Type ID, and certificate.'},google:{configured:!!(process.env.GOOGLE_WALLET_ISSUER&&process.env.GOOGLE_WALLET_KEY),message:'Requires a Google Wallet issuer account and service account key.'}});
  return json(res,404,{error:'Endpoint not found'});
}

const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost'); if(url.pathname.startsWith('/api/'))return await api(req,res,url.pathname); const rel=url.pathname==='/'?'index.html':url.pathname.slice(1); const file=normalize(join(root,'public',rel)); if(!file.startsWith(join(root,'public'))||!existsSync(file)){res.writeHead(404);return res.end('Not found');} res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});res.end(readFileSync(file));}catch(e){console.error(e);json(res,500,{error:'Internal server error'});}});
const port=Number(process.env.PORT||3000); server.listen(port,()=>console.log(`Stempel is running: http://localhost:${port}`));
export {server,db};
