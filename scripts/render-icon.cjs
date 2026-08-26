/**
 * Rasterize assets/logo.svg into a macOS .icns.
 *
 * Uses Electron as the renderer because it is already a dependency - no
 * cairo/rsvg toolchain needed, and it renders the SVG exactly as the app will.
 * Run with:  env -u ELECTRON_RUN_AS_NODE electron scripts/render-icon.cjs
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'assets', 'logo.svg');
const ICONSET = path.join(ROOT, 'assets', 'icon.iconset');
const SIZES = [16, 32, 64, 128, 256, 512, 1024];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edith-icon-'));

function pageFor(size) {
  const svg = fs.readFileSync(SVG, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:transparent;overflow:hidden}
    svg{display:block;width:${size}px;height:${size}px}
  </style></head><body>${svg}</body></html>`;
  const file = path.join(tmp, `icon-${size}.html`);
  fs.writeFileSync(file, html, 'utf8');
  return file;
}

let win = null;

/**
 * One window, resized between renders. Creating and destroying a transparent
 * BrowserWindow per size races on macOS and the second load fails outright.
 */
async function ensureWindow() {
  if (win) return win;
  win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true
  });
  return win;
}

async function renderAt(size) {
  const w = await ensureWindow();
  w.setContentSize(size, size);
  await w.loadFile(pageFor(size));
  // Let gradients and the blur filter settle before capturing.
  await new Promise((r) => setTimeout(r, 260));
  const image = await w.webContents.capturePage();
  const png = image.toPNG();
  if (png.length < 200) throw new Error(`suspiciously small PNG at ${size}px`);
  return png;
}

app.whenReady().then(async () => {
  try {
    fs.rmSync(ICONSET, { recursive: true, force: true });
    fs.mkdirSync(ICONSET, { recursive: true });

    const png = {};
    for (const size of SIZES) {
      png[size] = await renderAt(size);
      console.log(`rendered ${size}x${size}  ${png[size].length} bytes`);
    }

    const map = [
      ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
      ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
      ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
      ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
      ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024]
    ];
    for (const [name, size] of map) fs.writeFileSync(path.join(ICONSET, name), png[size]);
    fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), png[1024]);
    console.log('iconset written');
    if (win) win.destroy();
    app.exit(0);
  } catch (err) {
    console.error('FAILED:', err && err.message ? err.message : err);
    app.exit(1);
  }
});
