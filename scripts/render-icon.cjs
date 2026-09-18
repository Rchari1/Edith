/**
 * Build the macOS icon set from assets/wordmark.svg.
 *
 * The brand is a wordmark: five letters side by side. That reads at 512px and
 * turns to mush at 16, where each letter would get three pixels. An .icns may
 * carry different art per size, so the small slots get the E alone and the
 * large ones get the whole word - the same trick Apple's own apps use.
 *
 * Everything sits on the rounded square macOS expects, inset from the canvas
 * edge, because a full-bleed square reads as an unfinished app in the Dock.
 *
 * Uses Electron as the renderer: it is already a dependency, and it draws the
 * SVG exactly as the app will. Run with:  npm run icon
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'assets', 'wordmark.svg');
const ICONSET = path.join(ROOT, 'assets', 'icon.iconset');

/**
 * Where the art sits inside the artwork's 1000-unit square, measured from the
 * rendered file rather than guessed: the whole word, and the E on its own.
 */
const WORD = { x: 211, y: 414, w: 572, h: 183 };
const MONO = { x: 212, y: 414, w: 115, h: 183 };

/** The ground the letters sit on, sampled from the original artboard. */
const GROUND = '#111010';

/** Apple's proportions: the rounded square covers ~80% of the canvas. */
const INSET = 0.0977;
const RADIUS = 0.2246;

/** Below this size the five letters cannot resolve, so the E stands in. */
const MONOGRAM_UP_TO = 256;

const SIZES = [16, 32, 64, 128, 256, 512, 1024];

function pageFor(size) {
  const svg = fs.readFileSync(SVG, 'utf8').replace(/<\?xml[^>]*\?>/, '');
  const art = size <= MONOGRAM_UP_TO ? MONO : WORD;
  // How much of the rounded square the art may use, across or down.
  const fill = size <= MONOGRAM_UP_TO ? 0.46 : 0.72;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:transparent;overflow:hidden}
    #plate{position:absolute;inset:${INSET * 100}%;background:${GROUND};
      border-radius:${RADIUS * size * (1 - 2 * INSET)}px;overflow:hidden}
    /* A single soft pass of light from above, in the app's own idiom: no bloom. */
    #plate::after{content:"";position:absolute;inset:0;
      background:linear-gradient(170deg, rgba(255,255,255,0.07), rgba(255,255,255,0.012) 46%, transparent 70%)}
    #art{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
      width:${(size * (1 - 2 * INSET) * fill).toFixed(2)}px}
    #art svg{display:block;width:100%;height:auto}
  </style></head><body>
    <div id="plate"></div>
    <div id="art">${svg.replace(
      /viewBox="[^"]*"/,
      `viewBox="${art.x} ${art.y} ${art.w} ${art.h}"`
    ).replace(/\s(width|height)="[^"]*"/g, '')}</div>
  </body></html>`;
}

let win = null;

async function ensureWindow() {
  if (win) return win;
  win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  });
  return win;
}

async function render(size, tmp) {
  const file = path.join(tmp, `icon-${size}.html`);
  fs.writeFileSync(file, pageFor(size), 'utf8');
  const w = await ensureWindow();
  w.setSize(size, size);
  await w.loadFile(file);
  await new Promise((r) => setTimeout(r, 250));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  // capturePage honours the display's scale factor; resize back to the slot.
  const exact = img.getSize().width === size ? img : img.resize({ width: size, height: size });
  return exact.toPNG();
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edith-icon-'));
  const png = {};
  for (const size of SIZES) {
    png[size] = await render(size, tmp);
    console.log(`  rendered ${size}x${size}  ${png[size].length} bytes`);
  }

  fs.rmSync(ICONSET, { recursive: true, force: true });
  fs.mkdirSync(ICONSET, { recursive: true });
  const slots = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024]
  ];
  for (const [name, size] of slots) fs.writeFileSync(path.join(ICONSET, name), png[size]);

  // The Dock icon the app sets at runtime. Dock size means the monogram.
  fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), png[256]);
  console.log('  iconset written');
  if (win) win.destroy();
  app.quit();
});
