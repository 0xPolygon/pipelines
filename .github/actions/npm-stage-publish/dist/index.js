import { createRequire as __WEBPACK_EXTERNAL_createRequire } from "module";
/******/ var __webpack_modules__ = ({

/***/ 421:
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("node:child_process");

/***/ }),

/***/ 24:
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("node:fs");

/***/ }),

/***/ 161:
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("node:os");

/***/ }),

/***/ 760:
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("node:path");

/***/ })

/******/ });
/************************************************************************/
/******/ // The module cache
/******/ var __webpack_module_cache__ = {};
/******/ 
/******/ // The require function
/******/ function __nccwpck_require__(moduleId) {
/******/ 	// Check if module is in cache
/******/ 	var cachedModule = __webpack_module_cache__[moduleId];
/******/ 	if (cachedModule !== undefined) {
/******/ 		return cachedModule.exports;
/******/ 	}
/******/ 	// Create a new module (and put it into the cache)
/******/ 	var module = __webpack_module_cache__[moduleId] = {
/******/ 		// no module.id needed
/******/ 		// no module.loaded needed
/******/ 		exports: {}
/******/ 	};
/******/ 
/******/ 	// Execute the module function
/******/ 	var threw = true;
/******/ 	try {
/******/ 		__webpack_modules__[moduleId](module, module.exports, __nccwpck_require__);
/******/ 		threw = false;
/******/ 	} finally {
/******/ 		if(threw) delete __webpack_module_cache__[moduleId];
/******/ 	}
/******/ 
/******/ 	// Return the exports of the module
/******/ 	return module.exports;
/******/ }
/******/ 
/************************************************************************/
/******/ /* webpack/runtime/compat */
/******/ 
/******/ if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = new URL('.', import.meta.url).pathname.slice(import.meta.url.match(/^file:\/\/\/\w:/) ? 1 : 0, -1) + "/";
/******/ 
/************************************************************************/
var __webpack_exports__ = {};
// This entry need to be wrapped in an IIFE because it uses a non-standard name for the exports (exports).
(() => {
var exports = __webpack_exports__;

Object.defineProperty(exports, "B", ({ value: true }));
// Drop-in replacement for `changeset publish`, run by changesets/action as its
// `publish` command when a repo opts into npm staged publishing.
//
// `changeset publish` always runs a plain `npm publish` / `pnpm publish`, and
// npm's staging is a separate command (`npm stage publish`) rather than a flag
// or config value, so it can't be switched on from the outside. A staged
// version is uploaded but stays invisible until a maintainer approves it with
// a 2FA challenge — that proof-of-presence step is the whole point, and it is
// what OIDC trusted publishing on its own lacks.
//
// The contract with changesets/action is stdout: it scans for `New tag:`
// lines, then pushes those tags and creates a GitHub Release for each. So this
// script lets `changeset tag` decide which versions are new (it skips any tag
// that already exists locally or on the remote — the same idempotency signal
// as a normal release), stages the public ones, and echoes a `New tag:` line
// only for versions that were actually staged. A failed stage therefore never
// gets a tag or a Release.
//
// With SNAPSHOT_TAG set it instead stages every public package whose version
// isn't on the registry yet, under that dist-tag, and creates no tags — the
// staged counterpart of `changeset publish --tag <tag> --no-git-tag`.
const node_child_process_1 = __nccwpck_require__(421);
const node_fs_1 = __nccwpck_require__(24);
const node_os_1 = __nccwpck_require__(161);
const node_path_1 = __nccwpck_require__(760);
function run(command, args, cwd) {
    return (0, node_child_process_1.execFileSync)(command, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit']
    });
}
// Pre mode publishes under the pre tag (`beta`, `rc`, …), matching
// `changeset publish`; otherwise the default `latest`.
function getDistTag() {
    const prePath = '.changeset/pre.json';
    if (!(0, node_fs_1.existsSync)(prePath))
        return 'latest';
    const pre = JSON.parse((0, node_fs_1.readFileSync)(prePath, 'utf8'));
    return pre.mode === 'pre' ? pre.tag : 'latest';
}
// changesets names tags `<name>@<version>` in a workspace and `v<version>`
// for a single-package repo; resolve either form back to its package.
function findPackage({ tag, packages }) {
    const root = process.cwd();
    return (packages.find((p) => tag === `${p.name}@${p.version}`) ??
        packages.find((p) => p.path === root && tag === `v${p.version}`));
}
function isOnRegistry(pkg) {
    try {
        return run('npm', ['view', `${pkg.name}@${pkg.version}`, 'version']).trim() === pkg.version;
    }
    catch {
        return false;
    }
}
// `pnpm pack` rather than staging the directory directly: pnpm is what
// rewrites `workspace:` ranges and applies `publishConfig` overrides (e.g.
// `exports` without the source condition), and npm does neither.
function stage({ pkg, distTag }) {
    const dest = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'stage-'));
    run('pnpm', ['pack', '--pack-destination', dest], pkg.path);
    const tarball = (0, node_fs_1.readdirSync)(dest).find((f) => f.endsWith('.tgz'));
    if (!tarball)
        throw new Error(`pnpm pack produced no tarball for ${pkg.name}`);
    (0, node_child_process_1.execFileSync)('npm', ['stage', 'publish', (0, node_path_1.join)(dest, tarball), '--tag', distTag], {
        stdio: ['ignore', 'inherit', 'inherit']
    });
}
// `pnpm ls -r` includes the workspace root, which changesets never publishes
// in a monorepo; in a single-package repo the root is the package.
function listPackages() {
    const all = JSON.parse(run('pnpm', ['ls', '-r', '--depth', '-1', '--json']));
    return all.length > 1 ? all.filter((p) => p.path !== process.cwd()) : all;
}
// Snapshot versions are throwaway and never tagged, so "new" simply means
// "not on the registry yet" — the same rule `changeset publish` applies.
function stageSnapshot(snapshotTag) {
    let failed = false;
    for (const pkg of listPackages()) {
        if (pkg.private || isOnRegistry(pkg))
            continue;
        try {
            stage({ pkg, distTag: snapshotTag });
            console.log(`Staged ${pkg.name}@${pkg.version} under "${snapshotTag}" — pending maintainer approval`);
        }
        catch (err) {
            console.error(`Failed to stage ${pkg.name}@${pkg.version}`, err);
            failed = true;
        }
    }
    if (failed)
        process.exit(1);
}
function main() {
    const snapshotTag = process.env['SNAPSHOT_TAG'];
    if (snapshotTag) {
        stageSnapshot(snapshotTag);
        return;
    }
    const distTag = getDistTag();
    const packages = listPackages();
    const tagOutput = run('pnpm', ['exec', 'changeset', 'tag']);
    const newTags = [...tagOutput.matchAll(/New tag:\s+(\S+)/g)].map((m) => m[1]);
    if (newTags.length === 0) {
        console.log('No untagged versions — nothing to stage.');
        return;
    }
    let failed = false;
    for (const tag of newTags) {
        const pkg = findPackage({ tag, packages });
        if (!pkg) {
            console.error(`Cannot map tag ${tag} to a workspace package`);
            failed = true;
            continue;
        }
        // Private packages are tagged but never published — same as `changeset publish`.
        // A version already live on npm (approved earlier, tag push lost) only needs its tag.
        if (!pkg.private && !isOnRegistry(pkg)) {
            try {
                stage({ pkg, distTag });
            }
            catch (err) {
                console.error(`Failed to stage ${pkg.name}@${pkg.version}`, err);
                failed = true;
                continue;
            }
            console.log(`Staged ${pkg.name}@${pkg.version} under "${distTag}" — pending maintainer approval`);
        }
        console.log(`New tag: ${tag}`);
    }
    if (failed)
        process.exit(1);
}
main();

})();

var __webpack_exports___esModule = __webpack_exports__.B;
export { __webpack_exports___esModule as __esModule };
