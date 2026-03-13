import { defineConfig } from 'astro/config';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function syncSkillsPlugin() {
  const src = resolve(__dirname, '../skills');
  const dest = resolve(__dirname, 'public/skills');

  function sync() {
    if (!existsSync(src)) return;
    mkdirSync(dest, { recursive: true });

    const srcDirs = new Set();
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      srcDirs.add(entry.name);
      cpSync(resolve(src, entry.name), resolve(dest, entry.name), { recursive: true });
    }

    // remove stale dirs that no longer exist in source
    if (existsSync(dest)) {
      for (const entry of readdirSync(dest, { withFileTypes: true })) {
        if (entry.isDirectory() && !srcDirs.has(entry.name)) {
          rmSync(resolve(dest, entry.name), { recursive: true });
        }
      }
    }
  }

  return {
    name: 'sync-skills',
    buildStart() { sync(); },
    configureServer(server) {
      server.watcher.add(src);
      server.watcher.on('change', (file) => {
        if (!relative(src, file).startsWith('..')) sync();
      });
    }
  };
}

export default defineConfig({
  site: 'https://www.sfterm.com',
  base: '/',
  trailingSlash: 'always',
  build: {
    assets: 'assets'
  },
  vite: {
    plugins: [syncSkillsPlugin()]
  }
});

