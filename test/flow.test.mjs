import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'stempel-'));
process.env.DB_PATH=join(dir,'test.db'); process.env.PORT='0';
const {server}=await import('../server.mjs');
await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
async function login(email,password){const r=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0]}
async function call(cookie,path,method='GET',body){const r=await fetch(base+path,{method,headers:{cookie,'content-type':'application/json'},body:body&&JSON.stringify(body)});return {status:r.status,data:await r.json()}}

test('full flow: purchase, 10 stamps, and reward redemption',async()=>{
  const student=await login('student@stempel.app','student123');
  const venue=await login('burger@stempel.app','venue123');
  for(let i=1;i<=10;i++){
    const scan=await call(student,'/api/student/scan','POST',{code:'BULA-7'}); assert.equal(scan.status,201);
    const duplicate=await call(student,'/api/student/scan','POST',{code:'BULA-7'}); assert.equal(duplicate.status,409);
    const approve=await call(venue,`/api/venue/stamp/${scan.data.id}/approve`,'POST'); assert.equal(approve.status,200);
    const approveAgain=await call(venue,`/api/venue/stamp/${scan.data.id}/approve`,'POST'); assert.equal(approveAgain.status,409);
  }
  let cards=await call(student,'/api/student/cards'); assert.equal(cards.data.cards[0].stamps,10);
  assert.equal((await call(student,'/api/student/scan','POST',{code:'BULA-7'})).status,409);
  assert.equal((await call(student,'/api/student/reward','POST',{venueId:1})).status,201);
  const dashboard=await call(venue,'/api/venue/dashboard'); const rewardId=dashboard.data.rewards[0].id;
  assert.equal((await call(venue,`/api/venue/reward/${rewardId}/approve`,'POST')).status,200);
  assert.equal((await call(venue,`/api/venue/reward/${rewardId}/approve`,'POST')).status,409);
  cards=await call(student,'/api/student/cards'); assert.equal(cards.data.cards[0].stamps,0);
  assert.equal((await call(student,'/api/student/scan','POST',{code:'BULA-7'})).status,201);
});

test.after(()=>{server.close();rmSync(dir,{recursive:true,force:true})});
