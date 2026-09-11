// Checks the built bundle, not the sources.
//
// This exists because of a bug nothing else could have caught. `semantic_search`
// imports the embedding model lazily, so a user who only wants `list_tables`
// never pays for 210 MB of ONNX runtime. The source did that correctly. The
// *bundle* did not: esbuild inlined the dynamically imported module into the
// single output file and hoisted its dependency to the top, so
// `@xenova/transformers` became a static, mandatory import and the published
// server crashed at startup for everyone who had not installed it.
//
// The self-test cannot see that. It runs from TypeScript sources, where the
// dynamic import is still dynamic. Only the artefact a user installs shows it,
// which is why this runs as part of the build.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const ENTRY = join(DIST, 'index.js');

/** Packages that must never be needed in order to start the server. */
const OPTIONAL = ['@xenova/transformers'];

const problems = [];
let source = '';

try {
    source = readFileSync(ENTRY, 'utf8');
} catch {
    problems.push(`no bundle at ${ENTRY} — run: npm run mcp:build`);
}

if (source) {
    if (!source.startsWith('#!/usr/bin/env node')) {
        problems.push('the bundle has no shebang, so the bin entry will not be executable');
    }

    // A top-level `import ... from "pkg"` runs before any of our code does.
    for (const pkg of OPTIONAL) {
        const hoisted = new RegExp(`^import[^;]*from\\s*["']${pkg}["']`, 'm');
        if (hoisted.test(source)) {
            problems.push(
                `"${pkg}" is a static top-level import in dist/index.js. It is an optional ` +
                    'peer dependency, so the server would crash at startup for anyone who ' +
                    'has not installed it. The build needs --splitting, so the dynamic ' +
                    'import stays in its own chunk.',
            );
        }
    }
}

if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`  bundle: ${problem}\n`);
    process.exit(1);
}

process.stdout.write('  bundle: ok\n');
