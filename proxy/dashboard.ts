'use strict';

import crypto from 'node:crypto';
import http from 'http';
import { getFullHealthSnapshot } from './stats';

let activeSseConnections = 0;

// Optional dashboard authentication via shared secret.
// If DEEPCLAUDE_DASHBOARD_KEY is set, the X-Dashboard-Key header must
// match it using a timing-safe comparison to prevent side-channel attacks.
// Without the env var, all local requests are allowed.
function checkDashboardAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const key = process.env.DEEPCLAUDE_DASHBOARD_KEY;
    if (!key) return true; // not configured, allow all
    const provided = req.headers['x-dashboard-key'];

    // Length check before timing-safe compare prevents variable-time
    // comparison on variable-length inputs.
    if (typeof provided !== 'string' || provided.length !== key.length) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return false;
    }

    const match = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(key));
    if (!match) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return false;
    }
    return true;
}

// Serve dashboard routes: /dashboard (HTML page) and /health/stream (SSE).
// Returns true if the request was handled, false to continue normal routing.
export function serveDashboard(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    concurrencyStatus: unknown,
    rateLimiterStatus: unknown,
    providerDisplayNames?: Record<string, string>
): boolean {
    if (req.method !== 'GET') return false;

    const url = req.url || '';

    if (url === '/dashboard') {
        if (!checkDashboardAuth(req, res)) return true;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(buildDashboardHtml(providerDisplayNames));
        return true;
    }

    if (url === '/health/stream') {
        if (!checkDashboardAuth(req, res)) return true;
        const MAX_SSE_CONNECTIONS = 20;
        if (activeSseConnections >= MAX_SSE_CONNECTIONS) {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Too many dashboard connections. Try again later.' }));
            return true;
        }
        activeSseConnections++;
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
            'access-control-allow-origin': '*',
        });

        const sendSnapshot = (): void => {
            if (res.destroyed) return;
            try {
                const snapshot = getFullHealthSnapshot(concurrencyStatus, rateLimiterStatus);
                res.write('data: ' + JSON.stringify(snapshot) + '\n\n');
            } catch (_) {
                // Non-fatal -- SSE push should never crash.
            }
        };

        sendSnapshot();
        const interval = setInterval(sendSnapshot, 2000);
        interval.unref();

        const closeHandler = (): void => {
            clearInterval(interval);
            activeSseConnections = Math.max(0, activeSseConnections - 1);
        };
        req.on('close', closeHandler);
        res.on('close', closeHandler);

        return true;
    }

    return false;
}

// Build self-contained dashboard HTML page.
// No external dependencies -- works completely offline.
export function buildDashboardHtml(providerDisplayNames?: Record<string, string>): string {
    const providerNamesJson = JSON.stringify(providerDisplayNames || {});

    return '<!DOCTYPE html>' +
'<html lang="en">' +
'<head>' +
'<meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1.0">' +
'<title>DeepClaude Dashboard</title>' +
'<style>' +
'*{box-sizing:border-box;margin:0;padding:0}' +
'body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:14px;padding:20px}' +
'.header{display:flex;align-items:center;gap:24px;padding:16px 20px;background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:20px;flex-wrap:wrap}' +
'.header h1{font-size:20px;font-weight:600;color:#58a6ff}' +
'.header .stat{color:#8b949e;font-size:13px}' +
'.header .stat strong{color:#c9d1d9}' +
'.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px;margin-bottom:20px}' +
'.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px}' +
'.card-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}' +
'.card-name{font-weight:600;font-size:15px;color:#c9d1d9}' +
'.card-key{color:#8b949e;font-size:11px;margin-top:2px}' +
'.badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;text-transform:uppercase;white-space:nowrap}' +
'.badge-healthy{background:#1b4721;color:#3fb950;border:1px solid #3fb950}' +
'.badge-degraded{background:#4d3800;color:#d29922;border:1px solid #d29922}' +
'.badge-unhealthy{background:#3d141b;color:#f85149;border:1px solid #f85149}' +
'.badge-unknown{background:#21262d;color:#8b949e;border:1px solid #30363d}' +
'.card-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}' +
'.card-stat{font-size:13px}' +
'.card-stat-label{color:#8b949e;font-size:11px;margin-bottom:1px}' +
'.card-stat-value{color:#c9d1d9;font-weight:500}' +
'.cb-closed{color:#3fb950}' +
'.cb-open{color:#f85149}' +
'.cb-half-open{color:#d29922}' +
'.quota-ok{color:#3fb950}' +
'.quota-warning{color:#d29922}' +
'.quota-critical{color:#f85149}' +
'.recent-section{background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden}' +
'.recent-section h2{font-size:16px;font-weight:600;padding:16px 20px;border-bottom:1px solid #30363d}' +
'.recent-section table{width:100%;border-collapse:collapse}' +
'.recent-section th{text-align:left;padding:10px 16px;font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #21262d}' +
'.recent-section td{padding:8px 16px;font-size:13px;border-bottom:1px solid #21262d;white-space:nowrap}' +
'.recent-section tbody tr:hover td{background:#1c2128}' +
'.row-success td{color:#c9d1d9}' +
'.row-failure td{background:rgba(248,81,73,0.06);color:#f85149}' +
'.row-fallback td{background:rgba(210,153,34,0.06);color:#d29922}' +
'.loading{text-align:center;padding:40px;color:#8b949e}' +
'.model-cell{max-width:200px;overflow:hidden;text-overflow:ellipsis}' +
'@media(max-width:600px){.header{gap:12px;font-size:12px}.cards{grid-template-columns:1fr}.card-grid{grid-template-columns:1fr}}' +
'</style>' +
'</head>' +
'<body>' +
'<div class="header">' +
'<h1>DeepClaude Proxy</h1>' +
'<span class="stat">Version: <strong id="version">--</strong></span>' +
'<span class="stat">Uptime: <strong id="uptime">0s</strong></span>' +
'<span class="stat">Spend: <strong id="spend">$0.0000</strong></span>' +
'<span class="stat" id="quota-summary"></span>' +
'</div>' +
'<div class="cards" id="cards">' +
'<div class="loading">Connecting to proxy...</div>' +
'</div>' +
'<div class="recent-section">' +
'<h2>Recent Requests</h2>' +
'<div id="requests-placeholder" class="loading">Waiting for requests...</div>' +
'<table id="requests-table" style="display:none">' +
'<thead><tr><th>Time</th><th>Model</th><th>Provider</th><th>Status</th><th>Latency</th><th>Tokens</th></tr></thead>' +
'<tbody id="requests-body"></tbody>' +
'</table>' +
'</div>' +
'<script>' +
'(function(){' +
'var PROVIDER_NAMES=' + providerNamesJson + ';' +
'var cardsEl=document.getElementById("cards");' +
'var requestsBody=document.getElementById("requests-body");' +
'var requestsTable=document.getElementById("requests-table");' +
'var requestsPlaceholder=document.getElementById("requests-placeholder");' +
'var verEl=document.getElementById("version");' +
'var uptimeEl=document.getElementById("uptime");' +
'var spendEl=document.getElementById("spend");' +
'var quotaEl=document.getElementById("quota-summary");' +
'var lastData=null;' +
'function fmtUptime(ms){' +
'var s=Math.floor(ms/1000);if(s<60)return s+"s";' +
'var m=Math.floor(s/60);if(m<60)return m+"m "+s%60+"s";' +
'var h=Math.floor(m/60);return h+"h "+m%60+"m"' +
'}' +
'function fmtTime(ts){' +
'var d=new Date(ts);' +
'return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})' +
'}' +
'function timeAgo(ts){' +
'if(!ts)return"never";' +
'var diff=Date.now()-ts;' +
'if(diff<1000)return"just now";' +
'if(diff<60000)return Math.floor(diff/1000)+"s ago";' +
'if(diff<3600000)return Math.floor(diff/60000)+"m ago";' +
'return Math.floor(diff/3600000)+"h ago"' +
'}' +
'function getBadge(prov){' +
'var f=prov.fails||0,r=prov.requests||0;' +
'if(r<5)return{text:"UNKNOWN",cls:"badge-unknown"};' +
'var fr=f/r;' +
'if(fr>0.34)return{text:"UNHEALTHY",cls:"badge-unhealthy"};' +
'if(fr>0.2)return{text:"DEGRADED",cls:"badge-degraded"};' +
'return{text:"HEALTHY",cls:"badge-healthy"}' +
'}' +
'function cbClass(s){' +
'if(s==="OPEN")return"cb-open";' +
'if(s==="HALF_OPEN")return"cb-half-open";' +
'return"cb-closed"' +
'}' +
'function esc(s){' +
'if(!s)return"";' +
'return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")' +
'}' +
'function getQuotaStatus(p){' +
'var budget=p.monthlyBudget;' +
'if(!budget)return null;' +
'var spent=p.dailySpend?p.dailySpend.amount:0;' +
'var pct=(spent/budget)*100;' +
'if(pct<50)return{status:"ok",pct:pct,spent:spent,budget:budget,daysLeft:null};' +
'var ad=p.avgDailySpend7d;' +
'var daysLeft=ad&&ad>0?Math.floor((budget-spent)/ad):null;' +
'if(pct<80)return{status:"warning",pct:pct,spent:spent,budget:budget,daysLeft:daysLeft};' +
'return{status:"critical",pct:pct,spent:spent,budget:budget,daysLeft:daysLeft}' +
'}' +
'function render(data){' +
'lastData=data;' +
'verEl.textContent=data.version||"--";' +
'uptimeEl.textContent=fmtUptime(data.uptime||0);' +
'spendEl.textContent="$"+(data.spend||0).toFixed(4);' +
'var provs=data.providers||{};' +
'var keys=Object.keys(provs);' +
'// Quota summary in header: only show if any provider is warning or critical' +
'var okCount=0,warningList=[],criticalList=[];' +
'for(var qi=0;qi<keys.length;qi++){' +
'var qp=provs[keys[qi]];' +
'if(qp.monthlyBudget){' +
'var qs=getQuotaStatus(qp);' +
'if(qs.pct<50)okCount++;' +
'else if(qs.pct<80)warningList.push({k:keys[qi],pct:qs.pct});' +
'else criticalList.push({k:keys[qi],pct:qs.pct});' +
'}' +
'}' +
'if(warningList.length>0||criticalList.length>0){' +
'var qsText="Quota: "+okCount+" under limit";' +
'for(var wi=0;wi<warningList.length;wi++){' +
'qsText+=", "+esc(PROVIDER_NAMES[warningList[wi].k]||warningList[wi].k)+" "+Math.round(warningList[wi].pct)+"%";' +
'}' +
'for(var ci=0;ci<criticalList.length;ci++){' +
'qsText+=", "+esc(PROVIDER_NAMES[criticalList[ci].k]||criticalList[ci].k)+" "+Math.round(criticalList[ci].pct)+"%";' +
'}' +
'quotaEl.textContent=qsText' +
'}else{' +
'quotaEl.textContent=""' +
'}' +
'if(keys.length===0){' +
'cardsEl.innerHTML="<div class=\\"loading\\">No provider data yet.</div>"' +
'}else{' +
'var html="";' +
'for(var i=0;i<keys.length;i++){' +
'var k=keys[i];' +
'var p=provs[k];' +
'var dn=PROVIDER_NAMES[k]||k;' +
'var badge=getBadge(p);' +
'var cb=p.circuitBreaker||"CLOSED";' +
'var sr=p.requests>0?Math.round((p.successes/p.requests)*1000)/10:100;' +
'html+="<div class=\\"card\\">"' +
'+"<div class=\\"card-header\\">"' +
'+"<div><div class=\\"card-name\\">"+esc(dn)+"</div><div class=\\"card-key\\">"+k+"</div></div>"' +
'+"<span class=\\"badge "+badge.cls+"\\">"+badge.text+"</span>"' +
'+"</div>"' +
'+"<div class=\\"card-grid\\">"' +
'+"<div class=\\"card-stat\\"><div class=\\"card-stat-label\\">Circuit Breaker</div><div class=\\"card-stat-value "+cbClass(cb)+"\\">"+cb+"</div></div>"' +
'+"<div class=\\"card-stat\\"><div class=\\"card-stat-label\\">Success Rate</div><div class=\\"card-stat-value\\">"+p.successes+"/"+p.requests+" ("+sr+"%)</div></div>"' +
'+"<div class=\\"card-stat\\"><div class=\\"card-stat-label\\">Avg Latency</div><div class=\\"card-stat-value\\">"+(p.avgMs||0)+"ms</div></div>"' +
'+"<div class=\\"card-stat\\"><div class=\\"card-stat-label\\">Avg TTFT</div><div class=\\"card-stat-value\\">"+(p.avgTTFT||0)+"ms</div></div>"' +
'+"<div class=\\"card-stat\\"><div class=\\"card-stat-label\\">Avg TPS</div><div class=\\"card-stat-value\\">"+(p.avgTPS||0)+"</div></div>"' +
'+"<div class=\\"card-stat\\"><div class=\\"card-stat-label\\">Tokens (In/Out)</div><div class=\\"card-stat-value\\">"+(p.inputTokens||0)+" / "+(p.outputTokens||0)+"</div></div>"' +
'+"<div class=\\"card-stat\\"><div class=\\"card-stat-label\\">Last Request</div><div class=\\"card-stat-value\\">"+timeAgo(p.lastRequest)+"</div></div>"' +
'+(p.monthlyBudget?function(){var q=getQuotaStatus(p);return"<div class=\\"card-stat\\"><div class=\\"card-stat-label\\">Monthly Quota</div><div class=\\"card-stat-value quota-"+q.status+"\\">$"+q.spent.toFixed(2)+" / $"+q.budget.toFixed(2)+" ("+Math.round(q.pct)+"%)"+(q.daysLeft!==null?" "+q.daysLeft+" days left":"")+"</div></div>"}():"")' +
'+"</div></div>"' +
'}cardsEl.innerHTML=html' +
'}' +
'var recent=data.recentRequests||[];' +
'if(recent.length===0){' +
'requestsPlaceholder.style.display="";' +
'requestsTable.style.display="none"' +
'}else{' +
'requestsPlaceholder.style.display="none";' +
'requestsTable.style.display="";' +
'var rh="";' +
'for(var j=0;j<recent.length;j++){' +
'var r=recent[j];' +
'var rc="";' +
'var st=String(r.status||"ERR");' +
'if(r.fallback){rc="row-fallback";st=st+" fb"}' +
'else if(!r.status||r.status>=400){rc="row-failure"}' +
'var mdl=r.model||"-";' +
'var tks=r.tokens?r.tokens.input+"/"+r.tokens.output:"-";' +
'rh+="<tr class=\\""+rc+"\\">"' +
'+"<td>"+fmtTime(r.timestamp)+"</td>"' +
'+"<td class=\\"model-cell\\" title=\\""+esc(mdl)+"\\">"+esc(mdl)+"</td>"' +
'+"<td>"+esc(PROVIDER_NAMES[r.provider]||r.provider)+"</td>"' +
'+"<td>"+st+"</td>"' +
'+"<td>"+r.ms+"ms</td>"' +
'+"<td>"+tks+"</td>"' +
'+"</tr>"' +
'}' +
'requestsBody.innerHTML=rh' +
'}' +
'}' +
'var source=null;' +
'var pollTimer=null;' +
'function startPolling(){' +
'if(pollTimer)return;' +
'poll();' +
'pollTimer=setInterval(poll,2000)' +
'}' +
'function poll(){' +
'var x=new XMLHttpRequest();' +
'x.open("GET","/health");' +
'x.onload=function(){try{render(JSON.parse(x.responseText))}catch(e){}};' +
'x.onerror=function(){};' +
'x.send()' +
'}' +
'try{' +
'source=new EventSource("/health/stream");' +
'source.onmessage=function(e){try{render(JSON.parse(e.data))}catch(err){}};' +
'source.onerror=function(){if(source){source.close();source=null}startPolling()}' +
'}catch(e){startPolling()}' +
'setInterval(function(){' +
'if(lastData){' +
'uptimeEl.textContent=fmtUptime(lastData.uptime||0)' +
'}' +
'},10000)' +
'})();' +
'</script>' +
'</body>' +
'</html>';
}
