/**
 * A low-detail world landmass outline for the agent-origin map. Hand-authored
 * coarse continent polygons ([lon, lat] vertices), projected the same way as the
 * origin nodes (equirectangular), so a node sits over its real landmass. It is a
 * stylized low-poly silhouette, not precise cartography - just enough for the map
 * to read as Earth and anchor the glowing nodes. Self-contained: no dependency,
 * no external asset (CSP-safe). Reference data only.
 */

/** Each continent as [lon, lat] vertices (degrees, +E / +N). Coarse on purpose. */
const CONTINENTS: readonly (readonly [number, number][])[] = [
  // North America
  [
    [-165, 62], [-140, 70], [-122, 71], [-95, 72], [-82, 73], [-62, 60], [-64, 50],
    [-52, 47], [-66, 44], [-70, 41], [-75, 35], [-81, 25], [-90, 29], [-97, 26],
    [-107, 23], [-115, 29], [-124, 34], [-124, 48], [-135, 58], [-150, 59], [-165, 62],
  ],
  // Central America bridge
  [[-92, 16], [-84, 10], [-78, 8], [-83, 9], [-88, 15], [-92, 16]],
  // South America
  [
    [-78, 8], [-60, 10], [-50, 0], [-35, -8], [-38, -20], [-48, -25], [-58, -38],
    [-66, -45], [-72, -52], [-75, -45], [-70, -30], [-71, -18], [-77, -5], [-79, 2], [-78, 8],
  ],
  // Europe
  [
    [-10, 36], [-9, 44], [-2, 49], [2, 51], [8, 54], [10, 58], [18, 60], [25, 66],
    [30, 70], [28, 60], [40, 55], [38, 48], [30, 45], [20, 40], [15, 38], [3, 42], [-6, 36], [-10, 36],
  ],
  // Africa
  [
    [-16, 15], [-16, 25], [-10, 32], [10, 34], [20, 32], [33, 31], [43, 12], [51, 12],
    [42, -2], [40, -15], [35, -24], [25, -34], [18, -35], [12, -17], [9, 4], [-8, 5], [-16, 15],
  ],
  // Asia
  [
    [30, 70], [60, 72], [100, 77], [140, 73], [165, 70], [180, 66], [170, 60], [140, 55],
    [135, 45], [140, 35], [122, 30], [120, 22], [108, 10], [105, 0], [95, 5], [80, 8],
    [72, 20], [60, 25], [45, 40], [36, 45], [40, 55], [30, 70],
  ],
  // Australia
  [[113, -22], [130, -12], [142, -11], [153, -25], [150, -38], [140, -38], [129, -32], [115, -34], [113, -22]],
];

/** Build SVG path `d` strings for the continents, projected into a W x H box
 *  (equirectangular: x from lon, y from lat), matching the node projection. */
export function worldOutlinePaths(width: number, height: number): string[] {
  return CONTINENTS.map((poly) => {
    const pts = poly.map(([lon, lat]) => {
      const x = ((lon + 180) / 360) * width;
      const y = ((90 - lat) / 180) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `M${pts.join("L")}Z`;
  });
}
