import { Vector3 } from 'three';

// Geography is independent of the camera, quadtree level and loading order.
// Version this seed when intentionally changing the distribution.
export const SCATTER_VERSION = 1;
export const CELL_KM = 0.096;
export const ROCKS_PER_CELL = 16;
export const VISIBLE_KM = 0.095;
export const PREFETCH_KM = 0.17;
const FACES = [
  [[0,0,1],[1,0,0],[0,1,0]], [[0,0,-1],[-1,0,0],[0,1,0]],
  [[1,0,0],[0,0,-1],[0,1,0]], [[-1,0,0],[0,0,1],[0,1,0]],
  [[0,1,0],[1,0,0],[0,0,-1]], [[0,-1,0],[1,0,0],[0,0,1]],
].map(f=>f.map(v=>new Vector3(...v)));
export function hash32(a) {
  a=Math.imul(a^(a>>>16),0x7feb352d);a=Math.imul(a^(a>>>15),0x846ca68b);
  return (a^(a>>>16))>>>0;
}
export function randomFor(seed, lane) { return hash32(seed ^ Math.imul(lane+1,0x9e3779b9))/4294967296; }
export class ScatterGeography {
  constructor(radius, seed=0) { this.radius=radius;this.seed=hash32(seed^SCATTER_VERSION);this.divisions=Math.ceil(2*radius/CELL_KM); }
  direction(face,x,y) {
    const [n,e,u]=FACES[face];
    return n.clone().addScaledVector(e,2*x/this.divisions-1).addScaledVector(u,2*y/this.divisions-1).normalize();
  }
  cellAt(dir) {
    let face=0,best=-Infinity;
    FACES.forEach(([n],i)=>{const d=dir.dot(n);if(d>best){best=d;face=i;}});
    const [,e,u]=FACES[face],n=this.divisions;
    const x=Math.max(0,Math.min(n-1,Math.floor((dir.dot(e)/best+1)*.5*n)));
    const y=Math.max(0,Math.min(n-1,Math.floor((dir.dot(u)/best+1)*.5*n)));
    return {face,x,y,key:`${face}:${x}:${y}`};
  }
  nearby(dir, reach=PREFETCH_KM) {
    const cells=[],n=this.divisions,span=Math.ceil(reach*2/CELL_KM)+2;
    for(let face=0;face<6;face++) {
      const [normal,e,u]=FACES[face],f=dir.dot(normal);if(f<.45)continue;
      const cx=Math.floor((dir.dot(e)/f+1)*.5*n),cy=Math.floor((dir.dot(u)/f+1)*.5*n);
      for(let y=Math.max(0,cy-span);y<=Math.min(n-1,cy+span);y++)for(let x=Math.max(0,cx-span);x<=Math.min(n-1,cx+span);x++) {
        const centre=this.direction(face,x+.5,y+.5),distance=centre.distanceTo(dir)*this.radius;
        if(distance>reach+CELL_KM*Math.SQRT1_2)continue;
        cells.push({face,x,y,key:`${face}:${x}:${y}`,centre,distance});
      }
    }
    return cells.sort((a,b)=>a.distance-b.distance||a.key.localeCompare(b.key));
  }
  generate(cell) {
    const seed=hash32(this.seed ^ Math.imul(cell.face+1,73856093) ^ Math.imul(cell.x,19349663) ^ Math.imul(cell.y,83492791));
    return Array.from({length:ROCKS_PER_CELL},(_,i)=>{
      const id=hash32(seed^Math.imul(i+1,0x9e3779b9));
      // Disjoint, inset strata: no duplicate objects at cell or cube-face seams.
      const x=cell.x+(i%4+.15+randomFor(id,0)*.7)/4;
      const y=cell.y+(Math.floor(i/4)+.15+randomFor(id,1)*.7)/4;
      return {id:`${cell.key}:${i}`,seed:id,dir:this.direction(cell.face,x,y),size:(.15+randomFor(id,2)**3*.95)/1000,yaw:randomFor(id,3)*Math.PI*2};
    });
  }
}
