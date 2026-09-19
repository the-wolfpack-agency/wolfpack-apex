/**
 * Approximate country centroids (ISO-3166 alpha-2 -> name + lat/lon in decimal
 * degrees, +N / +E). Used only to place a node on the agent-origin map; these
 * are rough centroids for visualization, not precise geography. Reference data,
 * no PII. Countries absent here still appear in the ranked origin list.
 */
export interface Centroid {
  name: string;
  lat: number;
  lon: number;
}

export const COUNTRY_CENTROIDS: Readonly<Record<string, Centroid>> = {
  US: { name: "United States", lat: 39.8, lon: -98.6 },
  CA: { name: "Canada", lat: 56.1, lon: -106.3 },
  MX: { name: "Mexico", lat: 23.6, lon: -102.5 },
  BR: { name: "Brazil", lat: -14.2, lon: -51.9 },
  AR: { name: "Argentina", lat: -38.4, lon: -63.6 },
  CL: { name: "Chile", lat: -35.7, lon: -71.5 },
  CO: { name: "Colombia", lat: 4.6, lon: -74.3 },
  PE: { name: "Peru", lat: -9.2, lon: -75.0 },
  GB: { name: "United Kingdom", lat: 54.0, lon: -2.0 },
  IE: { name: "Ireland", lat: 53.4, lon: -8.0 },
  FR: { name: "France", lat: 46.6, lon: 2.2 },
  DE: { name: "Germany", lat: 51.2, lon: 10.4 },
  NL: { name: "Netherlands", lat: 52.1, lon: 5.3 },
  BE: { name: "Belgium", lat: 50.5, lon: 4.5 },
  LU: { name: "Luxembourg", lat: 49.8, lon: 6.1 },
  CH: { name: "Switzerland", lat: 46.8, lon: 8.2 },
  AT: { name: "Austria", lat: 47.5, lon: 14.6 },
  IT: { name: "Italy", lat: 41.9, lon: 12.6 },
  ES: { name: "Spain", lat: 40.2, lon: -3.7 },
  PT: { name: "Portugal", lat: 39.4, lon: -8.2 },
  SE: { name: "Sweden", lat: 60.1, lon: 18.6 },
  NO: { name: "Norway", lat: 60.5, lon: 8.5 },
  FI: { name: "Finland", lat: 61.9, lon: 25.7 },
  DK: { name: "Denmark", lat: 56.3, lon: 9.5 },
  IS: { name: "Iceland", lat: 64.9, lon: -19.0 },
  PL: { name: "Poland", lat: 51.9, lon: 19.1 },
  CZ: { name: "Czechia", lat: 49.8, lon: 15.5 },
  SK: { name: "Slovakia", lat: 48.7, lon: 19.7 },
  HU: { name: "Hungary", lat: 47.2, lon: 19.5 },
  RO: { name: "Romania", lat: 45.9, lon: 25.0 },
  BG: { name: "Bulgaria", lat: 42.7, lon: 25.5 },
  GR: { name: "Greece", lat: 39.1, lon: 21.8 },
  HR: { name: "Croatia", lat: 45.1, lon: 15.2 },
  RS: { name: "Serbia", lat: 44.0, lon: 21.0 },
  UA: { name: "Ukraine", lat: 48.4, lon: 31.2 },
  BY: { name: "Belarus", lat: 53.7, lon: 27.9 },
  RU: { name: "Russia", lat: 61.5, lon: 105.3 },
  TR: { name: "Turkey", lat: 39.0, lon: 35.2 },
  EE: { name: "Estonia", lat: 58.6, lon: 25.0 },
  LV: { name: "Latvia", lat: 56.9, lon: 24.6 },
  LT: { name: "Lithuania", lat: 55.2, lon: 23.9 },
  IL: { name: "Israel", lat: 31.0, lon: 34.9 },
  AE: { name: "United Arab Emirates", lat: 23.4, lon: 53.8 },
  SA: { name: "Saudi Arabia", lat: 23.9, lon: 45.1 },
  QA: { name: "Qatar", lat: 25.4, lon: 51.2 },
  IR: { name: "Iran", lat: 32.4, lon: 53.7 },
  IN: { name: "India", lat: 22.0, lon: 79.0 },
  PK: { name: "Pakistan", lat: 30.4, lon: 69.3 },
  BD: { name: "Bangladesh", lat: 23.7, lon: 90.4 },
  CN: { name: "China", lat: 35.9, lon: 104.2 },
  HK: { name: "Hong Kong", lat: 22.3, lon: 114.2 },
  TW: { name: "Taiwan", lat: 23.7, lon: 121.0 },
  JP: { name: "Japan", lat: 36.2, lon: 138.3 },
  KR: { name: "South Korea", lat: 36.5, lon: 127.9 },
  SG: { name: "Singapore", lat: 1.35, lon: 103.8 },
  MY: { name: "Malaysia", lat: 4.2, lon: 101.9 },
  ID: { name: "Indonesia", lat: -2.5, lon: 118.0 },
  TH: { name: "Thailand", lat: 15.9, lon: 101.0 },
  VN: { name: "Vietnam", lat: 14.1, lon: 108.3 },
  PH: { name: "Philippines", lat: 12.9, lon: 121.8 },
  AU: { name: "Australia", lat: -25.3, lon: 133.8 },
  NZ: { name: "New Zealand", lat: -41.0, lon: 174.9 },
  ZA: { name: "South Africa", lat: -30.6, lon: 22.9 },
  NG: { name: "Nigeria", lat: 9.1, lon: 8.7 },
  EG: { name: "Egypt", lat: 26.8, lon: 30.8 },
  KE: { name: "Kenya", lat: 0.0, lon: 37.9 },
  GH: { name: "Ghana", lat: 7.9, lon: -1.0 },
  TG: { name: "Togo", lat: 8.6, lon: 0.8 },
  MA: { name: "Morocco", lat: 31.8, lon: -7.1 },
  DZ: { name: "Algeria", lat: 28.0, lon: 1.7 },
  ET: { name: "Ethiopia", lat: 9.1, lon: 40.5 },
};

export function centroidFor(iso2: string): Centroid | null {
  return COUNTRY_CENTROIDS[(iso2 || "").toUpperCase()] ?? null;
}

/** Equirectangular projection to a 0..1 unit box (x=lon, y=lat). Multiply by the
 *  SVG width/height at render time. */
export function project(lat: number, lon: number): { x: number; y: number } {
  return { x: (lon + 180) / 360, y: (90 - lat) / 180 };
}
