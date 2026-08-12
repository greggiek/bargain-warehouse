let cached=null;let cachedAt=0;let inflight=null;const TTL=15*60*1000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
module.exports=async function(req,res){
 const key=process.env.QOBLEX_API_KEY,base=(process.env.QOBLEX_BASE_URL||'https://api.qoblex.com').replace(/\/$/,'');
 if(!key)return res.status(500).json({ok:false,error:'QOBLEX_API_KEY missing'});
 if(cached&&Date.now()-cachedAt<TTL)return res.status(200).json({...cached,cached:true