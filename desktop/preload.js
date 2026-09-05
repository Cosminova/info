/**
 * The only channel between the renderer and the shell.
 *
 * The app is a self-contained renderer and needs almost nothing from the host,
 * so rather than open a general IPC surface this exposes two facts it cannot
 * work out for itself: that it is running as a desktop build, and which
 * platform it is on. The in-page UI uses the first to stop offering things that
 * only make sense in a browser tab.
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('cosminovaDesktop', {
  version: process.env.npm_package_version ?? null,
  platform: process.platform,
});
