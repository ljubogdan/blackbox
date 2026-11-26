import type { GeoPoint } from '../../shared/types';
import { PROVIDER_NAMES } from '../../shared/types';

// Everything here is synthetic. Merchant and agent-provider names are invented.

export const CITIES: GeoPoint[] = [
  { city: 'Belgrade', country: 'RS', lat: 44.79, lon: 20.45 },
  { city: 'Novi Sad', country: 'RS', lat: 45.27, lon: 19.83 },
  { city: 'Vienna', country: 'AT', lat: 48.21, lon: 16.37 },
  { city: 'Berlin', country: 'DE', lat: 52.52, lon: 13.4 },
  { city: 'Paris', country: 'FR', lat: 48.86, lon: 2.35 },
  { city: 'London', country: 'GB', lat: 51.51, lon: -0.13 },
  { city: 'Madrid', country: 'ES', lat: 40.42, lon: -3.7 },
  { city: 'Rome', country: 'IT', lat: 41.9, lon: 12.5 },
  { city: 'Amsterdam', country: 'NL', lat: 52.37, lon: 4.9 },
  { city: 'Stockholm', country: 'SE', lat: 59.33, lon: 18.07 },
  { city: 'Warsaw', country: 'PL', lat: 52.23, lon: 21.01 },
  { city: 'Athens', country: 'GR', lat: 37.98, lon: 23.73 },
  { city: 'Istanbul', country: 'TR', lat: 41.01, lon: 28.98 },
  { city: 'Dubai', country: 'AE', lat: 25.2, lon: 55.27 },
  { city: 'Mumbai', country: 'IN', lat: 19.08, lon: 72.88 },
  { city: 'Bengaluru', country: 'IN', lat: 12.97, lon: 77.59 },
  { city: 'Singapore', country: 'SG', lat: 1.35, lon: 103.82 },
  { city: 'Jakarta', country: 'ID', lat: -6.21, lon: 106.85 },
  { city: 'Tokyo', country: 'JP', lat: 35.68, lon: 139.69 },
  { city: 'Seoul', country: 'KR', lat: 37.57, lon: 126.98 },
  { city: 'Shanghai', country: 'CN', lat: 31.23, lon: 121.47 },
  { city: 'Sydney', country: 'AU', lat: -33.87, lon: 151.21 },
  { city: 'Auckland', country: 'NZ', lat: -36.85, lon: 174.76 },
  { city: 'Nairobi', country: 'KE', lat: -1.29, lon: 36.82 },
  { city: 'Lagos', country: 'NG', lat: 6.52, lon: 3.38 },
  { city: 'Cairo', country: 'EG', lat: 30.04, lon: 31.24 },
  { city: 'Cape Town', country: 'ZA', lat: -33.92, lon: 18.42 },
  { city: 'São Paulo', country: 'BR', lat: -23.55, lon: -46.63 },
  { city: 'Buenos Aires', country: 'AR', lat: -34.6, lon: -58.38 },
  { city: 'Bogotá', country: 'CO', lat: 4.71, lon: -74.07 },
  { city: 'Mexico City', country: 'MX', lat: 19.43, lon: -99.13 },
  { city: 'Los Angeles', country: 'US', lat: 34.05, lon: -118.24 },
  { city: 'San Francisco', country: 'US', lat: 37.77, lon: -122.42 },
  { city: 'Seattle', country: 'US', lat: 47.61, lon: -122.33 },
  { city: 'Chicago', country: 'US', lat: 41.88, lon: -87.63 },
  { city: 'New York', country: 'US', lat: 40.71, lon: -74.01 },
  { city: 'Miami', country: 'US', lat: 25.76, lon: -80.19 },
  { city: 'Toronto', country: 'CA', lat: 43.65, lon: -79.38 },
  { city: 'Vancouver', country: 'CA', lat: 49.28, lon: -123.12 },
];

export const MERCHANTS: (GeoPoint & { name: string })[] = [
  { name: 'Northwind Outfitters', city: 'Seattle', country: 'US', lat: 47.61, lon: -122.33 },
  { name: 'Lumen Electronics', city: 'Shanghai', country: 'CN', lat: 31.23, lon: 121.47 },
  { name: 'Halden Home', city: 'Stockholm', country: 'SE', lat: 59.33, lon: 18.07 },
  { name: 'Pikto Tech', city: 'Berlin', country: 'DE', lat: 52.52, lon: 13.4 },
  { name: 'Sava Sport', city: 'Belgrade', country: 'RS', lat: 44.79, lon: 20.45 },
  { name: 'Maison Clary', city: 'Paris', country: 'FR', lat: 48.86, lon: 2.35 },
  { name: 'Kumo Audio', city: 'Tokyo', country: 'JP', lat: 35.68, lon: 139.69 },
  { name: 'Brightcart', city: 'London', country: 'GB', lat: 51.51, lon: -0.13 },
  { name: 'Terra Verde Market', city: 'São Paulo', country: 'BR', lat: -23.55, lon: -46.63 },
  { name: 'Orchard Lane', city: 'New York', country: 'US', lat: 40.71, lon: -74.01 },
  { name: 'Meridian Supply', city: 'Singapore', country: 'SG', lat: 1.35, lon: 103.82 },
  { name: 'Coastline Goods', city: 'Sydney', country: 'AU', lat: -33.87, lon: 151.21 },
];

export const PROVIDERS = PROVIDER_NAMES;

export interface CatalogItem {
  title: string;
  premium: string; // the pricier variant an agent can be pushed into
  category: string;
  price: number;
  ask: string; // how a person would phrase the instruction
}

export const CATALOG: CatalogItem[] = [
  { title: 'Trail running shoes, size 43', premium: 'Trail running shoes Pro Carbon, size 43', category: 'footwear', price: 104, ask: 'Buy me trail running shoes in size 43' },
  { title: 'Noise-cancelling headphones', premium: 'Noise-cancelling headphones Studio Edition', category: 'audio', price: 229, ask: 'Get me a pair of noise-cancelling headphones' },
  { title: '27-inch 4K monitor', premium: '32-inch 4K monitor, 144 Hz', category: 'electronics', price: 349, ask: 'Order a 27-inch 4K monitor for my desk' },
  { title: 'Espresso machine', premium: 'Espresso machine with built-in grinder', category: 'kitchen', price: 279, ask: 'Find me a decent espresso machine' },
  { title: 'Robot vacuum', premium: 'Robot vacuum with self-empty dock', category: 'home', price: 319, ask: 'Buy a robot vacuum for the flat' },
  { title: 'Mechanical keyboard', premium: 'Mechanical keyboard, aluminium case', category: 'electronics', price: 139, ask: 'Order a mechanical keyboard' },
  { title: 'Winter jacket, size M', premium: 'Winter jacket, expedition down, size M', category: 'apparel', price: 189, ask: 'Buy a winter jacket in size M' },
  { title: 'Ultrabook 14-inch', premium: 'Ultrabook 14-inch, 32 GB RAM', category: 'computers', price: 949, ask: 'Get me a good 14-inch laptop' },
  { title: 'Smartwatch', premium: 'Smartwatch Titanium LTE', category: 'wearables', price: 259, ask: 'Order a smartwatch for running' },
  { title: 'Air purifier', premium: 'Air purifier XL with HEPA-14', category: 'home', price: 199, ask: 'Buy an air purifier for the bedroom' },
  { title: 'Water filter cartridge', premium: 'Water filter cartridge, 6-pack', category: 'home', price: 34, ask: 'Order one replacement water filter cartridge' },
  { title: 'Standing desk frame', premium: 'Standing desk frame, dual motor', category: 'furniture', price: 389, ask: 'Buy a standing desk frame' },
];

export const DEVICES = ['iPhone-7Q2K', 'Pixel-M41X', 'MacBook-A9F3', 'Galaxy-T88R', 'ThinkPad-L2C6', 'iPad-H5D1'];
export const FOREIGN_DEVICES = ['headless-linux-5e1c', 'vm-chrome-91af', 'emulator-android-0c7d'];
