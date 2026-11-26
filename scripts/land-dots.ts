// One-off: sample points evenly over the sphere and keep the ones on land, for
// the dotted globe. Writes web/src/assets/land.json as [lat, lon, lat, lon, ...].
// Source: Natural Earth 110m land via the world-atlas package (public domain).
import { readFileSync, writeFileSync } from 'node:fs';
import { geoContains } from 'd3-geo';
import { feature } from 'topojson-client';

const topo = JSON.parse(readFileSync('node_modules/world-atlas/land-110m.json', 'utf8'));
const land = feature(topo, topo.objects.land) as any;

const N = 26000;
const out: number[] = [];
const golden = Math.PI * (3 - Math.sqrt(5));
for (let i = 0; i < N; i++) {
  const y = 1 - (i / (N - 1)) * 2;
  const theta = golden * i;
  const lat = (Math.asin(y) * 180) / Math.PI;
  const lon = ((((theta * 180) / Math.PI) % 360) + 540) % 360 - 180;
  if (lat < -60) continue; // skip Antarctica: it adds dots and no cities
  if (geoContains(land, [lon, lat])) out.push(Math.round(lat * 100) / 100, Math.round(lon * 100) / 100);
}
writeFileSync('web/src/assets/land.json', JSON.stringify(out));
console.log(`${out.length / 2} land dots`);
