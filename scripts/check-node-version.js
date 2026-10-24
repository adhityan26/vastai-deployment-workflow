// Fails when the running Node.js is older than the first release that fixes CVE-2026-111497 (the Brotli decoder,
// "Node2Shell"). Used by apps/web/Dockerfile so an image can never be built on a stale cached base layer.
// Releases fixed on 2026-10-21: 22.23.4, 24.22.1, 26.12.1. Other lines (20 and older, odd lines) get no fix.
const FIXED = { 22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1] };

function check(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (m === null) return `unreadable Node.js version "${version}"`;
  const got = [Number(m[1]), Number(m[2]), Number(m[3])];
  const need = FIXED[got[0]];
  if (need === undefined) return `Node.js ${version} is on a line without a fix for CVE-2026-111497 (use 22, 24 or 26)`;
  for (let i = 0; i < 3; i++) {
    if (got[i] > need[i]) return null;
    if (got[i] < need[i]) return `Node.js ${version} is vulnerable to CVE-2026-111497; need at least ${need.join(".")} (rebuild with --pull)`;
  }
  return null;
}

module.exports = { check };

if (require.main === module) {
  const problem = check(process.version);
  if (problem !== null) {
    console.error(problem);
    process.exit(1);
  }
  console.log(`Node.js ${process.version} includes the CVE-2026-111497 fix`);
}
