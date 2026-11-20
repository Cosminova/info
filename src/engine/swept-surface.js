// Earliest entry into a sphere along a frame's movement. Coordinates must be
// body-relative, never absolute intergalactic positions.
export function sphereEntry(start, end, radius) {
  const dx=end.x-start.x,dy=end.y-start.y,dz=end.z-start.z;
  const a=dx*dx+dy*dy+dz*dz;if(a<1e-20)return null;
  const c=start.x*start.x+start.y*start.y+start.z*start.z-radius*radius;
  if(c<=0)return null; // The endpoint terrain constraint handles penetration.
  const b=start.x*dx+start.y*dy+start.z*dz,disc=b*b-a*c;
  if(disc<0)return null;
  const t=(-b-Math.sqrt(disc))/a;
  return t>=0&&t<=1?t:null;
}
