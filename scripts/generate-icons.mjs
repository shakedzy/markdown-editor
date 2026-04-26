#!/usr/bin/env node
/* eslint-disable no-console */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const exec = promisify(execFile);

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const assetsDir = path.join(projectRoot, 'assets');
const buildDir = path.join(projectRoot, 'build');
const iconsLinuxDir = path.join(buildDir, 'icons');

const ICNS_SIZES = [
  { name: 'icon_16x16.png', size: 16 },
  { name: 'icon_16x16@2x.png', size: 32 },
  { name: 'icon_32x32.png', size: 32 },
  { name: 'icon_32x32@2x.png', size: 64 },
  { name: 'icon_128x128.png', size: 128 },
  { name: 'icon_128x128@2x.png', size: 256 },
  { name: 'icon_256x256.png', size: 256 },
  { name: 'icon_256x256@2x.png', size: 512 },
  { name: 'icon_512x512.png', size: 512 },
  { name: 'icon_512x512@2x.png', size: 1024 },
];

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function svgToPng(svgPath, outPath, size) {
  const svg = await fs.readFile(svgPath);
  await sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outPath);
}

async function makeIcns(svgPath, outIcns) {
  const tmp = path.join(buildDir, `${path.basename(outIcns, '.icns')}.iconset`);
  await ensureDir(tmp);
  for (const entry of ICNS_SIZES) {
    await svgToPng(svgPath, path.join(tmp, entry.name), entry.size);
  }
  if (process.platform !== 'darwin') {
    console.warn(`Skipping ${outIcns}: iconutil only available on macOS. The .iconset folder is at ${tmp}.`);
    return;
  }
  await exec('iconutil', ['-c', 'icns', tmp, '-o', outIcns]);
  await fs.rm(tmp, { recursive: true, force: true });
  console.log(`✓ ${path.relative(projectRoot, outIcns)}`);
}

async function makeIco(svgPath, outIco) {
  const buffers = await Promise.all(
    ICO_SIZES.map(async (size) => {
      const svg = await fs.readFile(svgPath);
      return sharp(svg, { density: 384 })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
    }),
  );
  const ico = await pngToIco(buffers);
  await fs.writeFile(outIco, ico);
  console.log(`✓ ${path.relative(projectRoot, outIco)}`);
}

async function makeLinuxPngs(svgPath) {
  await ensureDir(iconsLinuxDir);
  for (const size of LINUX_SIZES) {
    const out = path.join(iconsLinuxDir, `${size}x${size}.png`);
    await svgToPng(svgPath, out, size);
  }
  await svgToPng(svgPath, path.join(buildDir, 'icon.png'), 1024);
  console.log(`✓ ${path.relative(projectRoot, path.join(buildDir, 'icon.png'))} + ${LINUX_SIZES.length} sizes in build/icons/`);
}

async function main() {
  await ensureDir(buildDir);

  const appSvg = path.join(assetsDir, 'icon.svg');
  const fileSvg = path.join(assetsDir, 'file-icon.svg');

  await makeIcns(appSvg, path.join(buildDir, 'icon.icns'));
  await makeIco(appSvg, path.join(buildDir, 'icon.ico'));
  await makeLinuxPngs(appSvg);

  await makeIcns(fileSvg, path.join(buildDir, 'file-icon.icns'));
  await makeIco(fileSvg, path.join(buildDir, 'file-icon.ico'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
