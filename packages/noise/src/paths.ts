import { baseName } from './patch.js';

const LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'cargo.lock', 'poetry.lock',
  'gemfile.lock', 'go.sum', 'composer.lock',
]);
export const isLockfile = (path: string): boolean => LOCKFILES.has(baseName(path).toLowerCase());

const GENERATED_PATHS: [RegExp, string][] = [
  [/(^|\/)(dist|build)\//, 'build output directory'],
  [/(^|\/)(__generated__|generated)\//, 'generated directory'],
  [/(^|\/)(openapi|graphql|codegen|proto|protobuf)\/(gen|generated|output)\//, 'codegen output directory'],
  [/\.min\.(js|css)$/, 'minified file'],
  [/\.map$/, 'source map'],
  [/\.generated\./, 'generated file name'],
  [/\.pb\.(ts|js|go)$|_pb\.(js|ts|d\.ts)$|_pb2(_grpc)?\.py$/, 'protobuf output'],
  [/\.snap$/, 'test snapshot'],
];
const HEADER = /@generated\b|do not edit|auto-?generated/i;

/** Reason the file counts as generated, or null. `content` is any version of the file (head preferred). */
export function generatedReason(path: string, content: string | undefined): string | null {
  for (const [re, why] of GENERATED_PATHS) if (re.test(path)) return why;
  if (content && HEADER.test(content.split('\n', 5).join('\n'))) return 'generated-file header marker';
  return null;
}
