/**
 * Test-only module resolution shim.
 *
 * The unit tests run on Node's built-in test runner and its native TypeScript
 * type-stripping — no bundler, no transpile step, nothing to keep in sync. Three
 * consequences, all handled here rather than in every test file:
 *
 *  1. Node resolves relative TypeScript specifiers only with an explicit `.ts`
 *     extension, and the repo tsconfig does not enable
 *     `allowImportingTsExtensions`. So tests import the module under test through
 *     a *variable* specifier (opaque to the type checker) and recover its types
 *     from a sibling `import type`. Both halves stay fully type-checked.
 *  2. Application source writes extensionless relative imports, which the loader
 *     needs help with.
 *  3. The `@/*` path alias is a tsconfig/bundler feature that Node knows nothing
 *     about.
 *
 * Type-stripping also means **erasable syntax only** in application code: no
 * enums, no namespaces, and no constructor parameter properties anywhere in
 * `src/lib/cascade` or `src/lib/verify`. That is a deliberate constraint — it is
 * what lets the tests run with no build step.
 *
 * Nothing here is imported by application code.
 */

import * as nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * `module.registerHooks` (Node >= 22.15) is not in the repo's @types/node v20, so
 * the surface we use is declared locally rather than left as `any`.
 */
type NextResolve = (specifier: string, context: unknown) => unknown;
interface ModuleHooksApi {
  registerHooks(hooks: {
    resolve?: (specifier: string, context: unknown, next: NextResolve) => unknown;
  }): void;
}

let registered = false;

/**
 * Teaches the loader what the bundler normally does:
 *   - `@/x` resolves to `<repo>/src/x`, matching tsconfig `paths`;
 *   - an extensionless relative specifier gets `.ts`.
 */
export function registerAliasHooks(): void {
  if (registered) return;
  registered = true;

  // this file: <repo>/src/lib/cascade/testing/aliasHooks.ts
  const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const hasExtension = (s: string): boolean =>
    /\.[cm]?[jt]sx?$/.test(s) || /\.(json|node)$/.test(s);

  const api = nodeModule as unknown as ModuleHooksApi;
  api.registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('@/')) {
        const target = path.join(srcRoot, specifier.slice(2));
        return next(pathToFileURL(hasExtension(target) ? target : `${target}.ts`).href, context);
      }
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        return next(hasExtension(specifier) ? specifier : `${specifier}.ts`, context);
      }
      return next(specifier, context);
    },
  });
}
