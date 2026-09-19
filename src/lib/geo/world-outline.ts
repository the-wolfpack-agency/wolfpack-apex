/**
 * A low-detail world landmass outline for the agent-origin map. Hand-authored
 * continent polygons ([lon, lat] vertices), projected the same way as the origin
 * nodes (equirectangular), so a node sits over its real landmass. The polylines
 * are rendered through a Catmull-Rom smoothing pass so the coastlines read as
 * smooth curves rather than jagged straight segments. A stylized silhouette, not
 * precise cartography - enough for the map to read as Earth and anchor the nodes.
 * Self-contained: no dependency, no external asset (CSP-safe). Reference data.
 */

/** Each continent as [lon, lat] vertices (degrees, +E / +N), roughly clockwise. */
const CONTINENTS: readonly (readonly [number, number][])[] = [
  // North America
  [
    [-159, 65], [-166, 60], [-153, 57], [-138, 59], [-131, 55], [-124, 48],
    [-124, 42], [-120, 35], [-114, 31], [-110, 24], [-106, 23], [-98, 26],
    [-97, 21], [-91, 19], [-88, 21], [-83, 23], [-81, 25], [-80, 31],
    [-76, 35], [-70, 42], [-66, 45], [-60, 47], [-55, 52], [-64, 60],
    [-78, 63], [-95, 69], [-124, 70], [-141, 70], [-159, 65],
  ],
  // Central America bridge
  [[-92, 18], [-87, 14], [-83, 9], [-79, 8], [-83, 11], [-88, 16], [-92, 18]],
  // South America
  [
    [-77, 8], [-71, 11], [-62, 10], [-51, 4], [-44, -2], [-38, -6], [-35, -8],
    [-39, -15], [-48, -25], [-54, -34], [-62, -40], [-68, -50], [-74, -53],
    [-73, -45], [-71, -33], [-70, -20], [-76, -12], [-80, -4], [-80, 1], [-77, 8],
  ],
  // Europe
  [
    [-9, 37], [-9, 43], [-2, 48], [-4, 51], [2, 51], [5, 53], [4, 58],
    [10, 58], [11, 63], [18, 69], [26, 71], [30, 66], [28, 60], [24, 56],
    [30, 52], [36, 48], [30, 45], [22, 41], [18, 40], [12, 44], [4, 43],
    [-3, 43], [-9, 37],
  ],
  // Africa
  [
    [-16, 15], [-16, 21], [-10, 30], [-2, 35], [10, 34], [20, 32], [30, 31],
    [34, 28], [37, 22], [43, 11], [51, 12], [48, 2], [42, -5], [40, -12],
    [35, -22], [27, -33], [20, -35], [16, -29], [12, -17], [9, -1], [4, 6],
    [-8, 4], [-13, 9], [-16, 15],
  ],
  // Asia
  [
    [32, 68], [50, 68], [69, 73], [90, 75], [110, 77], [140, 73], [160, 70],
    [178, 66], [170, 60], [155, 57], [143, 54], [135, 46], [140, 38], [122, 40],
    [122, 31], [118, 24], [109, 21], [106, 10], [104, 1], [100, 7], [92, 21],
    [88, 22], [80, 8], [77, 20], [67, 25], [57, 25], [50, 30], [45, 40],
    [40, 45], [36, 52], [40, 60], [32, 68],
  ],
  // India (its own lobe so Asia's south edge reads right)
  [[68, 24], [72, 20], [76, 9], [80, 8], [84, 18], [88, 22], [80, 24], [72, 26], [68, 24]],
  // Australia
  [
    [114, -22], [122, -18], [130, -12], [137, -12], [142, -11], [147, -20],
    [153, -25], [150, -37], [143, -39], [135, -35], [129, -32], [118, -35],
    [114, -34], [113, -27], [114, -22],
  ],
];

/** Catmull-Rom (uniform) through a closed set of points, emitted as cubic beziers
 *  so the coastline is a smooth curve instead of a jagged polyline. */
function smoothClosedPath(pts: readonly [number, number][]): string {
  const n = pts.length;
  if (n < 3) return "";
  const p = (i: number) => pts[((i % n) + n) % n];
  let d = `M${p(0)[0].toFixed(1)},${p(0)[1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p0 = p(i - 1), p1 = p(i), p2 = p(i + 1), p3 = p(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d + "Z";
}

/** Build smoothed SVG path `d` strings for the continents, projected into a
 *  W x H box (equirectangular: x from lon, y from lat), matching the nodes. */
export function worldOutlinePaths(width: number, height: number): string[] {
  return CONTINENTS.map((poly) => {
    const projected = poly.map(([lon, lat]): [number, number] => [
      ((lon + 180) / 360) * width,
      ((90 - lat) / 180) * height,
    ]);
    return smoothClosedPath(projected);
  });
}
