// happy-dom 20.14.5's BrowserWindow.d.ts names `UnderlyingDefaultSource` from node:stream/web, which @types/node 22.20.4
// (the repository's pinned Node 22 types) does not declare. The type is the WHATWG Streams one, so this declares it as
// the DOM lib's interface of the same name; nothing else changes and skipLibCheck stays false.
declare module 'node:stream/web' {
  type UnderlyingDefaultSource<R = unknown> = globalThis.UnderlyingDefaultSource<R>;
}
