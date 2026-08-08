// Push the version in package.json into both native projects (ISSUE-016).
//
// Three files carry a version and nothing kept them in step: on the day the
// native projects were generated, package.json already said 0.2.0 while both
// said 1.0. Drift here is not cosmetic — the stores key their upload rules to
// these numbers, and a build number that fails to increase is rejected at
// upload with a message that does not mention the file you need to edit.
//
//   package.json  version  -> marketing version, e.g. "1.0.0"
//                 build    -> build number, a monotonically increasing integer
//
//   Android  versionName / versionCode        (android/app/build.gradle)
//   iOS      MARKETING_VERSION /              (ios/App/App.xcodeproj/project.pbxproj)
//            CURRENT_PROJECT_VERSION           Info.plist reads both via $(...)
//
// Usage:
//   npm run version:sync           sync native files to package.json
//   npm run version:bump           increment build, then sync
//
// The BUILD number must increase on every upload to either store, even for an
// identical marketing version — a rejected or superseded upload burns its
// number permanently. Bump it every time you submit, not every time you commit.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const p = (rel) => path.join(ROOT, rel);
const read = (rel) => readFileSync(p(rel), 'utf8');

const pkgPath = p('package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

if (process.argv.includes('--bump')) {
  pkg.build = Number(pkg.build || 0) + 1;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`build -> ${pkg.build}`);
}

const version = String(pkg.version || '').trim();
const build = Number(pkg.build);

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`package.json version must be x.y.z, got ${JSON.stringify(version)}`);
  process.exit(1);
}
if (!Number.isInteger(build) || build < 1) {
  console.error(`package.json build must be a positive integer, got ${JSON.stringify(pkg.build)}`);
  process.exit(1);
}

let changed = 0;

// ---- Android ----------------------------------------------------------------
{
  const rel = 'android/app/build.gradle';
  const src = read(rel);
  const next = src
    .replace(/versionCode\s+\d+/, `versionCode ${build}`)
    .replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);
  if (next !== src) { writeFileSync(p(rel), next); changed++; console.log(`${rel}: versionName ${version}, versionCode ${build}`); }
}

// ---- iOS --------------------------------------------------------------------
// Both build configurations (Debug and Release) carry their own copy, so this
// replaces every occurrence rather than the first.
{
  const rel = 'ios/App/App.xcodeproj/project.pbxproj';
  const src = read(rel);
  const next = src
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`)
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`);
  if (next !== src) { writeFileSync(p(rel), next); changed++; console.log(`${rel}: MARKETING_VERSION ${version}, CURRENT_PROJECT_VERSION ${build}`); }
}

// ---- Web client (8.52) ------------------------------------------------------
// Crash reports carry window.CC_VERSION so a stack trace names its build.
{
  const rel = 'public/config.js';
  const src = read(rel);
  const next = src.replace(/window\.CC_VERSION = '[^']*';/, `window.CC_VERSION = '${version}+${build}';`);
  if (next !== src) { writeFileSync(p(rel), next); changed++; console.log(`${rel}: CC_VERSION ${version}+${build}`); }
}

console.log(changed ? `\nsynced ${changed} file(s) to ${version} (${build})` : `\nalready in sync at ${version} (${build})`);
