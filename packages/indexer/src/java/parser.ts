import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';

export type Node = Parser.SyntaxNode;
export type Tree = Parser.Tree;

const require = createRequire(import.meta.url);

let parserPromise: Promise<Parser> | undefined;

/** The WASM runtime and the Java grammar are initialised once, lazily, and shared. */
export function getJavaParser(): Promise<Parser> {
  parserPromise ??= (async () => {
    await Parser.init();
    const lang = await Parser.Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-java.wasm'));
    const parser = new Parser();
    parser.setLanguage(lang);
    return parser;
  })();
  parserPromise.catch(() => { parserPromise = undefined; });
  return parserPromise;
}
