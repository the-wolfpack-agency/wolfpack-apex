const {Client}=require("pg");
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});await c.connect();
const q=async s=>(await c.query(s)).rows;
const START=Date.now();
for(let i=0;i<30;i++){ // up to ~30 min
  const r=await q("SELECT props->>'hosting' h, props->>'client_type' ct, count(*) n FROM site_analytics_events WHERE props ? 'hosting' AND created_at>now()-interval '3 minutes' GROUP BY 1,2");
  const total=r.reduce((s,x)=>s+Number(x.n),0);
  const dc=r.filter(x=>x.h==='datacenter').reduce((s,x)=>s+Number(x.n),0);
  const headlessRes=r.filter(x=>x.h==='residential'&&x.ct==='headless').reduce((s,x)=>s+Number(x.n),0);
  if(total>0){
    console.log("VERDICT (fresh edge, "+Math.round((Date.now()-START)/60000)+"min): "+total+" hosting-labeled events | datacenter="+dc+" | headless-residential="+headlessRes);
    if(dc>0){ console.log("  => EDGE APPLIES FULL SET: datacenter detection WORKS. Impact confirmed."); break; }
    if(headlessRes>0 && dc===0){ console.log("  => headless STILL residential + zero datacenter -> the fleet is residential-proxied (residential is CORRECT) OR still a coverage gap. Sampling more..."); if(i>3) break; }
  }
  await new Promise(r=>setTimeout(r,60000));
}
await c.end();})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
