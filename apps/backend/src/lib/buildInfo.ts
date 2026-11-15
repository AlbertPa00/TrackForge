// 043/044 — single source for build metadata. Env-injected in images (TF_*),
// package.json as the dev/source fallback (../package.json resolves from src/
// and dist/).
import { readFileSync } from 'node:fs';

const pkgVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return String(pkg.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
})();

export function buildMeta() {
  return {
    version: process.env.TF_VERSION ?? pkgVersion,
    buildNumber: Number(process.env.TF_BUILD_NUMBER ?? 1),
    buildDate: process.env.TF_BUILD_DATE || undefined,
    scm: process.env.TF_SCM_REVISION ?? 'trackforge',
  };
}
