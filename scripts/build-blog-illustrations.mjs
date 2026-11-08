// Rebuild the blog's editable SVG figures: node scripts/build-blog-illustrations.mjs
// Inline rendering inherits the article's Pagella / Songti fonts and color scheme.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const out = fileURLToPath(new URL('../site/blog/assets/', import.meta.url));
const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const ink='var(--art-ink, #171717)', muted='var(--art-muted, #525252)', line='var(--art-line, #d6d6d6)', paper='var(--art-paper, #fff)', tint='var(--art-tint, #fafafa)', accent='var(--art-accent, #2563eb)', note='var(--art-note, #eff6ff)';
const text=(x,y,label,size=18,fill=ink,extra='')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${esc(label)}</text>`;
const center=(x,y,label,size=18,fill=ink)=>text(x,y,label,size,fill,'text-anchor="middle"');
const rect=(x,y,w,h,fill=paper,stroke=line)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${fill}" stroke="${stroke}"/>`;
const rule=(x,y,w,stroke=line)=>`<path d="M${x} ${y}h${w}" fill="none" stroke="${stroke}"/>`;
const arrow=(d,dashed=false)=>`<path d="${d}" fill="none" stroke="${accent}" stroke-width="1.4" ${dashed?'stroke-dasharray="4 4"':''} marker-end="url(#arrow)"/>`;
function svg(w,h,title,desc,body){return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title desc"><title id="title">${esc(title)}</title><desc id="desc">${esc(desc)}</desc><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M1 1 8 5 1 9" fill="none" stroke="${accent}" stroke-width="1.4"/></marker></defs><g font-family="'Paper Serif','TeX Gyre Pagella',Palatino,'Songti SC','Noto Serif CJK SC',SimSun,serif">${body}</g></svg>\n`;}
const directory = fileURLToPath(new URL('../site/blog/locales/', import.meta.url));
const copy = Object.fromEntries(fs.readdirSync(directory).filter(file => file.endsWith('.json')).map(file => [file.slice(0, -5), JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')).illustrations]));

function workspace(c,x,y,w,h,source){
 const gutter=18, inner=w-2*gutter;
 let s=rect(x,y,w,h)+rule(x,y+31,w)+text(x+14,y+21,source?c.old:c.now,14,muted);
 if(source){
  const split=Math.round(w*.61); s+=`<path d="M${x+split} ${y+31}v${h-31}" stroke="${line}"/>`;
  s+=text(x+gutter,y+59,c.source,17)+text(x+split+12,y+59,c.preview,14,muted);
  for(let i=0;i<5;i++)s+=rule(x+gutter+(i%2)*10,y+82+i*20,split-gutter-28-(i%3)*14,line);
  s+=rect(x+split+14,y+76,w-split-28,h-96,paper,line);
  for(let i=0;i<4;i++)s+=rule(x+split+23,y+92+i*17,w-split-46,line);
 }else{
  s+=text(x+gutter,y+62,c.page,19);
  s+=rect(x+gutter,y+81,inner*.58,23,note,'none');
  for(let i=0;i<5;i++)s+=rule(x+gutter,y+94+i*20,inner*(i===4?.51:.62),line);
  s+=`<path d="M${x+inner*.67} ${y+83}v74" stroke="${accent}"/>`;
  s+=text(x+inner*.67+11,y+103,c.annotation,13,muted);
  s+=rule(x+inner*.67+11,y+118,inner*.23,line)+rule(x+inner*.67+11,y+133,inner*.17,line);
 }
 return s;
}
function comparison(c,mobile){
 const w=mobile?400:760,h=mobile?650:386;
 let s='';
 if(mobile){
  s+=center(200,34,c.comparison,21)+workspace(c,26,63,348,211,true)+center(200,302,c.oldPath,17,muted);
  s+=workspace(c,26,337,348,211,false)+center(200,579,c.newPath,18)+center(200,617,c.under,16,muted);
 }else{
  s+=center(380,36,c.comparison,25)+workspace(c,24,67,332,220,true)+workspace(c,404,67,332,220,false);
  s+=arrow('M368 176h24')+center(190,319,c.oldPath,17,muted)+center(570,319,c.newPath,18)+center(570,355,c.under,15,muted);
 }
 return svg(w,h,c.comparison,c.comparisonDesc,s);
}
function flow(c,mobile){
 const w=mobile?400:760,h=mobile?668:444;
 let s=center(w/2,36,c.flow,mobile?23:25);
 const node=(step,x,y,width,height)=>rect(x,y,width,height,paper,step===0||step===3?accent:line)+text(x+19,y+27,`${String(step+1).padStart(2,'0')}  /  ${c.steps[step][0]}`,14,muted)+text(x+19,y+59,c.steps[step][1],22)+text(x+19,y+90,c.steps[step][2],mobile?15:16,muted);
 if(mobile){
  for(let i=0;i<4;i++){s+=node(i,42,68+i*144,332,113);if(i<3)s+=arrow(`M208 ${193+i*144}v18`);}
  s+=arrow('M42 556H18V124h13',true)+center(208,650,c.again,15,muted);
 }else{
  s+=node(0,30,73,300,124)+node(1,430,73,300,124)+node(2,430,271,300,124)+node(3,30,271,300,124);
  s+=arrow('M344 135h72')+arrow('M580 211v46')+arrow('M416 333h-72')+arrow('M180 257v-46',true)+center(380,433,c.again,16,muted);
 }
 return svg(w,h,c.flow,c.flowDesc,s);
}
function responsibility(c,mobile){
 const w=mobile?400:760,h=mobile?536:340;
 let s=center(w/2,36,c.responsibility,mobile?21:25);
 const column=(x,y,title,items,width)=>text(x,y,title,22)+rule(x,y+17,width)+items.map((item,i)=>text(x,y+56+i*39,`${i+1}.  ${item}`,mobile?17:18,i<3?ink:muted)).join('');
 if(mobile){s+=column(28,91,c.agent,c.agentItems,344)+column(28,297,c.author,c.authorItems,344)+center(200,509,c.responsibilityFoot,15,muted);}
 else{s+=column(30,101,c.agent,c.agentItems,322)+column(414,101,c.author,c.authorItems,316)+center(380,316,c.responsibilityFoot,17,muted);}
 return svg(w,h,c.responsibility,c.responsibilityDesc,s);
}
for(const [locale,c] of Object.entries(copy))for(const [name,render] of [['interaction-space',comparison],['pdf-first-workflow',flow],['author-judgment',responsibility]])for(const mobile of [false,true]){
 fs.writeFileSync(path.join(out,`${name}${mobile?'-compact':''}.${locale}.svg`),render(c,mobile));
}
console.log(`Wrote ${Object.keys(copy).length * 6} responsive blog figures.`);
