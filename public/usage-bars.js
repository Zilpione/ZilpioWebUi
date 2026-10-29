// Codex primary/secondary ordering can differ between plans. Match the actual window.
export function normalizeUsage(response) {
  const result={fiveHour:null,weekly:null};
  const limits=response?.rateLimits??response?.rateLimitsByLimitId?.codex;
  for(const window of [limits?.primary,limits?.secondary]) {
    const key=window?.windowDurationMins===300?'fiveHour':window?.windowDurationMins===10080?'weekly':null;
    if(!key||typeof window.usedPercent!=='number'||!Number.isFinite(window.usedPercent))continue;
    const reset=window.resetsAt;
    result[key]={remainingPercent:Math.max(0,Math.min(100,100-window.usedPercent)),resetsAt:typeof reset==='number'&&Number.isFinite(reset)&&reset>0&&Number.isFinite(new Date(reset*1000).getTime())?reset*1000:null};
  }
  return result;
}
export function renderUsageBars(host,response) {
  if(!host)return;
  const usage=normalizeUsage(response);
  host.replaceChildren();
  for(const [key,label] of [['fiveHour','5 ore'],['weekly','Settimanale']]) {
    const quota=usage[key],row=host.ownerDocument.createElement('div');row.className='usage-quota';
    const heading=host.ownerDocument.createElement('div');heading.className='usage-quota-heading';
    const name=host.ownerDocument.createElement('span');name.textContent=label;
    const value=host.ownerDocument.createElement('span');value.textContent=quota?`${Math.round(quota.remainingPercent)}% residuo`:'Non disponibile';
    heading.append(name,value);
    const track=host.ownerDocument.createElement('div');track.className='usage-quota-track';
    if(quota){track.setAttribute('role','progressbar');track.setAttribute('aria-label',`${label}: quota residua`);track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');track.setAttribute('aria-valuenow',String(quota.remainingPercent));const fill=host.ownerDocument.createElement('span');fill.style.width=`${quota.remainingPercent}%`;track.append(fill)}
    const reset=host.ownerDocument.createElement('small');reset.textContent=quota?.resetsAt?`Reset: ${new Date(quota.resetsAt).toLocaleString(undefined,{dateStyle:'short',timeStyle:'short'})}`:'Reset non disponibile';
    row.append(heading,track,reset);host.append(row);
  }
}
