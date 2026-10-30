import { build } from 'esbuild';
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'src/miniprogram');
const out = path.join(root, 'dist/miniprogram');
await mkdir(out, { recursive: true });
async function files(dir) {
  const items = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(items.map(f => f.isDirectory() ? files(path.join(dir, f.name)) : [path.join(dir, f.name)]))).flat();
}
const all = await files(source);
for (const f of all.filter(f => !f.endsWith('.ts'))) {
  const dest = path.join(out, path.relative(source, f));
  await mkdir(path.dirname(dest), { recursive: true }); await cp(f, dest);
}
const entries = all.filter(f => f.endsWith('/app.ts') || f.endsWith('\\app.ts') || /[\\/]pages[\\/].*[\\/]index\.ts$/.test(f));
await build({ entryPoints: entries, outdir: out, outbase: source, bundle: true, minify: true,
  format: 'cjs', platform: 'browser', target: 'es2018', charset: 'utf8',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'info',
  plugins: [{ name: 'shared-runtime', setup(b) {
    b.onResolve({ filter: /(?:services\/api|shared\/(?:contracts|companion|interaction|beijing-time|import-cleaning|screenshot))$/ }, () => ({ path: '../../runtime', external: true }));
  } }],
});
await build({ entryPoints: [path.join(source, 'runtime.ts')], outfile: path.join(out, 'runtime.js'),
  bundle: true, minify: true, format: 'cjs', platform: 'browser', target: 'es2018', charset: 'utf8',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'info' });
const cloud = path.join(root, 'src/cloud/index.ts');
if (await stat(cloud).then(() => true, () => false)) {
  const destination = path.join(root, 'dist/cloudfunctions/assistantApiV2');
  await mkdir(destination, { recursive: true });
  await build({ entryPoints: [cloud], outfile: path.join(destination, 'index.js'), bundle: true,
    platform: 'node', format: 'cjs', target: 'node20', external: ['wx-server-sdk', 'tencentcloud-sdk-nodejs-tms'], logLevel: 'info' });
  await cp(path.join(root, 'src/cloud/package.json'), path.join(destination, 'package.json'));
  await cp(path.join(root, 'src/cloud/api-config.json'), path.join(destination, 'config.json'));
  const cleanup = path.join(root, 'dist/cloudfunctions/assistantCleanup');
  await mkdir(cleanup, { recursive: true });
  await build({ entryPoints: [path.join(root, 'src/cloud/cleanup.ts')], outfile: path.join(cleanup, 'index.js'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['wx-server-sdk'], logLevel: 'info' });
  await cp(path.join(root, 'src/cloud/package.json'), path.join(cleanup, 'package.json'));
  await cp(path.join(root, 'src/cloud/cleanup-config.json'), path.join(cleanup, 'config.json'));
}
console.log('Build complete. Import the repository root into WeChat Developer Tools.');
