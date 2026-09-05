/**
 * Cosminova as a desktop application.
 *
 * The renderer is the same build that runs in a browser, loaded off disk rather
 * than over HTTP — `base: './'` in the Vite config is what makes that possible,
 * because every asset reference stays relative and so resolves under `file://`
 * without a server to root it.
 *
 * What the desktop build buys over the hosted one is the GPU: a packaged
 * Chromium can be told to prefer the discrete adapter and to keep its
 * compositor off the main thread, neither of which a page can ask for. On a
 * scene that ray-marches a Schwarzschild metric and streams terrain at
 * kilometre precision, that is the difference between forty frames and ninety.
 */
const { app, BrowserWindow, Menu, shell, screen } = require('electron');
const path = require('node:path');

// Chromium picks the integrated adapter on laptops by default, which is the
// right call for a text editor and the wrong one here. Asked for before the app
// is ready, because the GPU process reads these once at startup.
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('enable-zero-copy');

const APP_ROOT = path.join(__dirname, '..');

/** The two entry points the app is built with, as file paths. */
const VIEWS = {
  explorer: path.join(APP_ROOT, 'dist', 'index.html'),
  sky: path.join(APP_ROOT, 'dist', 'sky.html'),
};

let window_ = null;

function createWindow() {
  // Sized to most of the display rather than a fixed default: the scene is a
  // panorama and a 1024x768 window wastes it, but filling the screen outright
  // hides that this is a window at all.
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  window_ = new BrowserWindow({
    width: Math.round(width * 0.86),
    height: Math.round(height * 0.86),
    minWidth: 900,
    minHeight: 600,
    // The scene fades up from black, and a white window flashing first is
    // jarring enough to look like a fault.
    backgroundColor: '#000000',
    show: false,
    title: 'Cosminova',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The renderer is our own build and is handed no Node access; anything it
      // needs from the shell arrives through the preload bridge instead.
      contextIsolation: true,
      nodeIntegration: false,
      // Vite emits ES modules, and the loader needs the page to be treated as a
      // proper origin for those to resolve under file://.
      webSecurity: true,
    },
  });

  window_.once('ready-to-show', () => window_.show());
  window_.on('closed', () => {
    window_ = null;
  });

  // A link to a catalogue or a data source belongs in the user's browser, not
  // in a window with no address bar and no way back.
  window_.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  window_.loadFile(VIEWS.explorer);
}

/**
 * The menu exists for one reason: the app ships two views and the in-page UI
 * only offers the switch in one direction. Everything else here is the standard
 * set, spelled out because defining a menu at all replaces the default.
 */
function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'View',
      submenu: [
        {
          label: 'Solar system',
          accelerator: 'CmdOrCtrl+1',
          click: () => window_?.loadFile(VIEWS.explorer),
        },
        {
          label: 'Sky from the ground',
          accelerator: 'CmdOrCtrl+2',
          click: () => window_?.loadFile(VIEWS.sky),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// A second copy would fight the first for the GPU and for the window, and the
// user gets nothing from it, so the running one is raised instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window_) return;
    if (window_.isMinimized()) window_.restore();
    window_.focus();
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
