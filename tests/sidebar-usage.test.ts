import {test, expect} from 'bun:test';
import {JSDOM} from 'jsdom';
import {createSidebarUsage} from '../public/sidebar-usage.js';

test('renders independent account quotas and unavailable data', async()=>{
  const doc=new JSDOM('<div id="usage"></div>').window.document;
  const now=Date.UTC(2026,0,1,10,0);
  const panel=createSidebarUsage({host:doc.querySelector('#usage'),now:()=>now,readUsage:async id=>id==='a'?{rateLimitResetCredits:{availableCount:2,credits:[{status:'available',expiresAt:(now+86400000)/1000},{status:'available',expiresAt:null}]},rateLimits:{primary:{windowDurationMins:300,usedPercent:25,resetsAt:(now+208*60000)/1000},secondary:{windowDurationMins:10080,usedPercent:4,resetsAt:(now+10000*60000)/1000}}}:Promise.reject(new Error('offline'))});
  await panel.setAccounts([{id:'a',label:'EL'},{id:'b',label:'Secondo'}]);
  const cards=doc.querySelectorAll('.sidebar-usage-card');
  expect(cards.length).toBe(2);expect(doc.querySelectorAll('.sidebar-usage-updated').length).toBe(1);expect(cards[0].querySelector('.sidebar-usage-updated')).toBeNull();expect(doc.querySelector('#usage')?.lastElementChild?.textContent).toContain('Aggiornato alle');expect(cards[0].textContent).toContain('EL');expect(cards[0].textContent).toContain('3h e 28 m');expect(cards[0].textContent).toContain('75%');expect(cards[0].textContent).not.toContain('166h');expect(cards[0].querySelectorAll('.sidebar-usage-window-heading')[1].textContent).toContain('Sett 96%Reset');expect(cards[0].textContent).toContain('96%');expect(cards[0].querySelectorAll('.sidebar-usage-detail .sidebar-usage-reset').length).toBe(0);expect(cards[0].querySelector('.sidebar-usage-window-heading')?.textContent).toContain('5 ore 75%');expect(cards[0].querySelectorAll('.sidebar-usage-reset-dot').length).toBe(2);cards[0].querySelector('.sidebar-usage-reset-dot')?.dispatchEvent(new doc.defaultView!.Event('mouseenter'));expect(doc.querySelector('.sidebar-usage-tooltip')?.textContent).toContain('Scade');cards[0].querySelector('.sidebar-usage-reset-dot')?.dispatchEvent(new doc.defaultView!.Event('mouseleave'));expect(doc.querySelector('.sidebar-usage-tooltip')).toBeNull();expect(cards[0].querySelector('.sidebar-usage-reset-dot')?.getAttribute('data-tooltip')).toContain('Scade');expect(cards[0].querySelectorAll('.sidebar-usage-reset-dot')[1].getAttribute('data-tooltip')).toContain('Senza scadenza');expect(cards[1].querySelectorAll('.sidebar-usage-reset-dot').length).toBe(0);expect(cards[0].querySelectorAll('[role=progressbar]').length).toBe(2);expect(cards[0].querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('75');expect((cards[0].querySelector('[role=progressbar] span') as HTMLElement).style.width).toBe('75%');expect(cards[0].querySelector('[role=progressbar]')?.getAttribute('data-level')).toBe('high');expect(cards[1].textContent).toContain('Non disponibile');
  panel.dispose();
});

test('low remaining quota produces a short red bar, including zero', async()=>{
  const doc=new JSDOM('<div></div>').window.document;
  const panel=createSidebarUsage({host:doc.querySelector('div'),readUsage:async()=>({rateLimits:{primary:{windowDurationMins:300,usedPercent:95},secondary:{windowDurationMins:10080,usedPercent:100}}})});
  await panel.setAccounts([{id:'a',label:'A'}]);
  const bars=doc.querySelectorAll('[role=progressbar]');
  expect(bars[0].getAttribute('data-level')).toBe('low');expect((bars[0].querySelector('span') as HTMLElement).style.width).toBe('5%');
  expect(bars[1].getAttribute('data-level')).toBe('low');expect((bars[1].querySelector('span') as HTMLElement).style.width).toBe('0%');
  panel.dispose();
});

test('remaining quota is green above 40%, yellow through 40% and red at 20%', async()=>{
  const doc=new JSDOM('<div></div>').window.document;
  let remaining=41;
  const panel=createSidebarUsage({host:doc.querySelector('div'),readUsage:async()=>({rateLimits:{primary:{windowDurationMins:300,usedPercent:100-remaining}}})});
  await panel.setAccounts([{id:'a'}]);
  expect(doc.querySelector('[role=progressbar]')?.getAttribute('data-level')).toBe('high');
  remaining=40;await panel.refresh();expect(doc.querySelector('[role=progressbar]')?.getAttribute('data-level')).toBe('medium');
  remaining=21;await panel.refresh();expect(doc.querySelector('[role=progressbar]')?.getAttribute('data-level')).toBe('medium');
  remaining=20;await panel.refresh();expect(doc.querySelector('[role=progressbar]')?.getAttribute('data-level')).toBe('low');
  panel.dispose();
});

test('does not invent reset credits from scheduled usage windows',async()=>{
  const doc=new JSDOM('<div></div>').window.document;let summary:any=null;
  const panel=createSidebarUsage({host:doc.querySelector('div'),readUsage:async()=>({rateLimitResetCredits:summary,rateLimits:{primary:{windowDurationMins:300,usedPercent:20,resetsAt:1900000000}}})});
  await panel.setAccounts([{id:'a'}]);expect(doc.querySelectorAll('.sidebar-usage-reset-dot').length).toBe(0);
  summary={availableCount:3,credits:[{status:'available',expiresAt:1900000000}]};await panel.refresh();expect(doc.querySelectorAll('.sidebar-usage-reset-dot').length).toBe(3);expect(doc.querySelectorAll('.sidebar-usage-reset-dot')[1].getAttribute('data-tooltip')).toContain('non disponibile');
  summary={availableCount:0,credits:[]};await panel.refresh();expect(doc.querySelectorAll('.sidebar-usage-reset-dot').length).toBe(0);panel.dispose();
});

test('reset requires confirmation, targets the correct account and refreshes after success',async()=>{
 const dom=new JSDOM('<div></div>'),doc=dom.window.document;let reads=0;const calls:any[]=[];
 (dom.window.HTMLDialogElement.prototype as any).showModal=function(){this.open=true};(dom.window.HTMLDialogElement.prototype as any).close=function(){this.open=false};
 const panel=createSidebarUsage({host:doc.querySelector('div'),readUsage:async()=>{reads++;return {rateLimitResetCredits:{availableCount:1,credits:[{id:'credit-1',status:'available',expiresAt:1900000000}]}}},consumeReset:async(id,credit)=>{calls.push([id,credit]);return {outcome:'reset'}}});
 await panel.setAccounts([{id:'account-1',label:'EL'}]);(doc.querySelector('.sidebar-usage-reset-dot') as HTMLElement).click();expect(doc.querySelector('.reset-list-dialog')?.hasAttribute('open')).toBe(true);
 (doc.querySelector('.reset-use') as HTMLElement).click();expect(doc.querySelector('.reset-confirm-dialog')?.hasAttribute('open')).toBe(true);expect(calls.length).toBe(0);
 (doc.querySelector('.reset-confirm') as HTMLElement).click();await new Promise(resolve=>setTimeout(resolve,0));expect(calls).toEqual([['account-1','credit-1']]);expect(reads).toBe(2);expect(doc.querySelector('.reset-list-dialog')?.hasAttribute('open')).toBe(false);panel.dispose();
});

test('reset dots show expiry urgency without inventing dates',async()=>{
 const doc=new JSDOM('<div></div>').window.document,now=Date.UTC(2026,0,1),day=86400000;
 const credits=[4,3,2,1,0].map(n=>({status:'available',expiresAt:(now+n*day)/1000}));credits.push({status:'available',expiresAt:null as any});
 const panel=createSidebarUsage({host:doc.querySelector('div'),now:()=>now,readUsage:async()=>({rateLimitResetCredits:{availableCount:6,credits}})});
 await panel.setAccounts([{id:'a'}]);expect([...doc.querySelectorAll('.sidebar-usage-reset-dot')].map(dot=>dot.getAttribute('data-expiry-level'))).toEqual(['high','medium','medium','low','low','unknown']);expect([...doc.querySelectorAll('.sidebar-usage-reset-dot')].map(dot=>dot.getAttribute('data-expiry-day'))).toEqual(['4','3','2','1','0',null]);panel.dispose();
});

test('expiry urgency counts local calendar days rather than 24-hour periods',async()=>{
 const doc=new JSDOM('<div></div>').window.document,now=new Date(2026,9,28,10,30).getTime(),tomorrow=new Date(2026,9,29,18,0).getTime(),fourDays=new Date(2026,10,1,1,0).getTime();
 const panel=createSidebarUsage({host:doc.querySelector('div'),now:()=>now,readUsage:async()=>({rateLimitResetCredits:{availableCount:2,credits:[{status:'available',expiresAt:tomorrow/1000},{status:'available',expiresAt:fourDays/1000}]}})});
 await panel.setAccounts([{id:'a'}]);expect([...doc.querySelectorAll('.sidebar-usage-reset-dot')].map(dot=>dot.getAttribute('data-expiry-level'))).toEqual(['low','high']);panel.dispose();
});
