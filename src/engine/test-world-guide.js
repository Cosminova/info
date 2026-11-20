import { TEST_SITES } from './test-world.js';
export function createTestWorldGuide(visit, light) {
  const panel=document.createElement('details'); panel.className='test-world-guide'; panel.hidden=true;
  const summary=document.createElement('summary'); summary.textContent='Gliese 12b · Biome lab'; panel.append(summary);
  const note=document.createElement('p'); note.textContent='Artistic test world'; panel.append(note);
  const select=document.createElement('select'); select.setAttribute('aria-label','Test biome');
  for(const site of TEST_SITES){const option=document.createElement('option');option.value=site.id;option.textContent=site.name;select.append(option);}
  panel.append(select);
  const go=document.createElement('button');go.textContent='Explore biome';go.onclick=()=>visit(select.value);panel.append(go);
  for(const mode of ['Day','Night']){const b=document.createElement('button');b.textContent=mode;b.onclick=()=>light(mode.toLowerCase());panel.append(b);}
  document.body.append(panel);
  const style=document.createElement('style');style.textContent=`
    .test-world-guide{position:fixed;left:20px;bottom:90px;z-index:35;width:230px;padding:12px 14px;background:rgba(12,20,25,.91);color:#e2eeee;border:1px solid #56706c;border-radius:12px;font:13px system-ui;box-shadow:0 8px 30px #0005}
    .test-world-guide[hidden],body.immersive .test-world-guide{display:none}
    .test-world-guide summary{cursor:pointer;font-weight:600}.test-world-guide p{font-size:11px;color:#a2bcb8;margin:9px 0}
    .test-world-guide select{width:100%;background:#182b30;color:#e4efed;padding:8px;border:1px solid #45636b;border-radius:6px}
    .test-world-guide button{margin:8px 7px 0 0;padding:7px 10px;color:#e4efed;border:1px solid #45636b;border-radius:6px;background:#203a3c;cursor:pointer}
    .test-world-guide button:focus-visible,.test-world-guide select:focus-visible{outline:2px solid #a7e5cc;outline-offset:2px}
    @media(max-width:600px){.test-world-guide{left:10px;bottom:82px;width:205px}}
  `;document.head.append(style);return panel;
}
